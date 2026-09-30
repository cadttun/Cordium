/**
 * @file packages/kernel/test/ui-contribution-ownership.test.mjs
 * @description 门禁：UI 贡献项的查重与所有权（**不得静默覆盖**）
 *
 * 缺陷背景：
 *   `registerAction` 早已有正确的同名防护，而 `registerUIContribution`
 *   直接 `uiContributions.set(item.id, item)` —— **后者静默顶掉前者**。
 *   同一类问题的两个入口处理不一致，且被顶掉的一方毫无察觉。
 *
 * 本文件锁定四条规则：
 *   ① 不同插件抢同 ID ⇒ 拒绝并报错；
 *   ② 同一插件重复注册同 ID ⇒ 同样拒绝（**不选「幂等」**）；
 *   ③ 停用后 ID 被释放 ⇒ 别的插件可以接着用；
 *   ④ 停用**不得**误删后来者 —— 陈旧 disposer 动不了别人的项。
 *
 * ⚠️ 逐个 `activatePlugin` 而不走 `boot()`：`boot()` 在任何插件失败时会
 *    **回滚全部已激活插件**（部分失败回滚），那会把「谁占着 id」这件事一并清掉，
 *    测不出本文件要测的所有权交接。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost } from '../src/index.mjs';
import { pluginState, uiItem } from './fixtures/inspect.mjs';

const manifest = id => ({
  id,
  name: id,
  version: '1.0.0',
  apiVersion: '1.0.0',
  provides: [],
  dependencies: {},
  permissions: []
});

const failed = (host, id) => pluginState(host, id) === 'failed';

test('不同插件抢同一个 UI contribution id ⇒ 拒绝并报错，且不得覆盖已有项', async () => {
  const host = new CordiumHost();
  host.registerPlugin(manifest('plugin.a'), {
    activate: (ctx) => { ctx.registerUIContribution({ id: 'panel.shared', type: 'panel', title: 'A 的面板' }); }
  });
  host.registerPlugin(manifest('plugin.b'), {
    activate: (ctx) => { ctx.registerUIContribution({ id: 'panel.shared', type: 'panel', title: 'B 的面板' }); }
  });

  await host.activatePlugin('plugin.a');
  await assert.rejects(host.activatePlugin('plugin.b'), hasCode('duplicate_ui_contribution', /already registered by plugin 'plugin\.a'/));

  assert.equal(failed(host, 'plugin.b'), true);
  assert.equal(uiItem(host, 'panel.shared').ownerId, 'plugin.a', '先注册者的项必须原样保留');
  assert.equal(uiItem(host, 'panel.shared').title, 'A 的面板', '被拒绝方不得改动已有项的任何字段');
  assert.equal(host.getUIContributions().length, 1);
});

test('同一插件重复注册同 ID ⇒ 同样拒绝（重复注册意味着逻辑错误，不选「幂等」）', async () => {
  const host = new CordiumHost();
  host.registerPlugin(manifest('plugin.dup'), {
    activate: (ctx) => {
      ctx.registerUIContribution({ id: 'panel.twice', type: 'panel' });
      ctx.registerUIContribution({ id: 'panel.twice', type: 'panel' });
    }
  });

  await assert.rejects(host.activatePlugin('plugin.dup'), hasCode('duplicate_ui_contribution', /already registered by plugin 'plugin\.dup'/));
  assert.equal(failed(host, 'plugin.dup'), true);
});

test('补充：字符串形式的 contribution id 走同一套查重', async () => {
  const host = new CordiumHost();
  host.registerPlugin(manifest('plugin.s1'), { activate: (ctx) => { ctx.registerUIContribution('panel.str'); } });
  host.registerPlugin(manifest('plugin.s2'), { activate: (ctx) => { ctx.registerUIContribution('panel.str'); } });

  await host.activatePlugin('plugin.s1');
  await assert.rejects(host.activatePlugin('plugin.s2'), hasCode('duplicate_ui_contribution'));

  assert.equal(uiItem(host, 'panel.str').ownerId, 'plugin.s1');
  assert.equal(uiItem(host, 'panel.str').type, 'custom');
});

test('停用插件后 id 被释放，另一个插件可以接着注册', async () => {
  const host = new CordiumHost();
  host.registerPlugin(manifest('plugin.first'), {
    activate: (ctx) => { ctx.registerUIContribution({ id: 'panel.handover', type: 'panel' }); }
  });
  host.registerPlugin(manifest('plugin.second'), {
    activate: (ctx) => { ctx.registerUIContribution({ id: 'panel.handover', type: 'panel' }); }
  });

  await host.activatePlugin('plugin.first');
  await assert.rejects(host.activatePlugin('plugin.second'), hasCode('duplicate_ui_contribution'), '占用期间第二个插件必须先被拒');

  await host.deactivatePlugin('plugin.first');
  assert.equal((uiItem(host, 'panel.handover') !== undefined), false, '停用必须真正释放 id');

  await host.activatePlugin('plugin.second');
  assert.equal(uiItem(host, 'panel.handover').ownerId, 'plugin.second');
});

// ⚠️ 这里曾有「陈旧的 disposer 不得误删后来者」，**已删除**。
//   它直接调 `host.unregisterUIContribution(id, 旧 ownerId)` 模拟「旧 disposer 迟到」；
//   该方法私有化后只剩 EffectScope 回调它，而 dispose 是宿主令牌守护 + 一次性的 ⇒
//   迟到的第二次释放从公开 API 构造不出来。正常交接已由上一条用例覆盖；ownerId 校验保留为防御纵深。

test('回归：无 id 的贡献项仍按原样报错（不得因新增查重而放松）', async () => {
  const host = new CordiumHost();
  host.registerPlugin(manifest('plugin.noid'), {
    activate: (ctx) => { ctx.registerUIContribution({ type: 'panel' }); }
  });
  await assert.rejects(host.activatePlugin('plugin.noid'), hasCode('invalid_argument'));
  assert.equal(failed(host, 'plugin.noid'), true);
});
