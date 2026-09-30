// 契约表【当夹具】：只 applyNeutralServiceContracts(host)，不 assert 其内容；被测对象是内核作用域机制
// 契约表用 cordium 自持的【中立夹具】（`./fixtures/neutral-service-contracts.mjs`）。
/**
 * @file packages/kernel/test/scope-isolation.test.mjs
 * @description Scope 与宿主的访问边界 —— 隔离与可用性【必须成对验证】
 *
 * 缺陷背景：EffectScope 此前把 host 作为公开字段（this.host = host），
 * 而 ctx.scope 会原样交给插件 —— 插件因此可以绕过全部服务门禁，
 * 直达 host.dispatchAction() / .plugins / .services。
 *
 * 为什么隔离与可用性必须配对（只验一边会引出错误修复）：
 *   只验隔离 ⇒ 可能把 ctx.scope 整个删掉，插件再也无法登记清理；
 *   只验可用 ⇒ 可能为了方便又把 host 暴露回去。
 * 两者都要绿，才算「堵住了旁路，且没堵死正路」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost } from '../src/index.mjs';
import { applyNeutralServiceContracts } from './fixtures/neutral-service-contracts.mjs';

/** 建一个已装载契约表、可注册插件的宿主 */
function makeHost() {
  const host = new CordiumHost();
  applyNeutralServiceContracts(host);
  return host;
}

// ───────────────────────── 隔离 ─────────────────────────

test('插件无法经 ctx.scope 触达宿主', async () => {
  let captured = null;
  const host = makeHost();
  host.registerPlugin(
    { id: 'plugin.spy', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) { captured = ctx; } }
  );
  await host.boot();

  const scope = captured.scope;

  // ① host 不是公开属性 —— 也不在原型链上
  assert.equal(scope.host, undefined, 'ctx.scope.host 必须是 undefined');
  assert.equal('host' in scope, false, '原型链上也不得出现 host');
  assert.ok(
    !Object.getOwnPropertyNames(scope).includes('host'),
    '自有属性名里不得有 host（私有字段 #host 不出现在此处）'
  );

  // ② 宿主的关键能力一条都不可经 scope 触达
  for (const prop of [
    'dispatchAction', 'getService', 'getInternalService', 'registerService',
    'unregisterService', 'unregisterPlugin', 'selectActiveProvider', 'plugins', 'serviceContracts',
    'actionHandlers', 'auditLogs'
  ]) {
    assert.equal(scope[prop], undefined, `ctx.scope.${prop} 不得可达`);
  }

  // ③ 兜底：遍历所有可枚举属性值，确认没有一个是宿主实例
  //    （防「把 host 换个名字藏起来」式规避）
  for (const key of Object.keys(scope)) {
    assert.ok(
      !(scope[key] instanceof CordiumHost),
      `ctx.scope.${key} 不得是宿主实例`
    );
  }

  // ④ scope 自有的追踪集合都是值类型，不泄露对象引用
  assert.ok(scope.services instanceof Set, 'scope.services 是「服务名集合」，与宿主契约表无关');
  for (const name of scope.services) {
    assert.equal(typeof name, 'string', 'scope.services 只应含服务名字符串');
  }
});

// ───────────────────────── 可用性 ─────────────────────────

test('addDisposer 登记的清理回调在停用时确实被调用', async () => {
  const host = makeHost();
  let disposed = false;
  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) { ctx.scope.addDisposer(() => { disposed = true; }); } }
  );
  await host.boot();
  await host.deactivatePlugin('plugin.a');

  assert.equal(disposed, true, '停用后清理回调必须被执行');
});

test('trackTimer 托管的定时器在停用时确实被清除', async () => {
  const host = makeHost();
  let fired = false;
  host.registerPlugin(
    { id: 'plugin.b', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        ctx.scope.trackTimer(setTimeout(() => { fired = true; }, 50));
      }
    }
  );
  await host.boot();
  await host.deactivatePlugin('plugin.b');

  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(fired, false, '被托管的定时器在停用后必须已清除，不得再触发');
});

test('trackService 托管的服务在停用时确实被注销', async () => {
  // 本用例只把服务名当**标识字符串**用，与业务语义无关。
  const host = makeHost();
  host.registerPlugin(
    {
      id: 'plugin.svc', version: '1.0.0', apiVersion: '1.0.0',
      provides: ['fixture.public']
    },
    { async activate(ctx) { ctx.provideService('fixture.public', { ping: () => 'pong' }); } }
  );
  await host.boot();
  assert.ok(host.getInternalService('fixture.public'), '激活后服务应可用');

  await host.deactivatePlugin('plugin.svc');
  assert.throws(
    () => host.getInternalService('fixture.public'),
    hasCode('no_provider'),
    '停用后服务必须已被注销'
  );
});

test('trackUIContribution 托管的 UI 贡献在停用时确实被注销', async () => {
  const host = makeHost();
  host.registerPlugin(
    { id: 'plugin.ui', version: '1.0.0', apiVersion: '1.0.0' },
    // 注意 registerUI 只接受【一个】参数（contribution 对象）：
    // 传成 registerUI('id', {...}) 会静默丢弃第二个参数，type 落成 'custom'。
    { async activate(ctx) { ctx.registerUIContribution({ id: 'panel-demo', type: 'panel', title: 'Demo' }); } }
  );
  await host.boot();
  assert.equal(host.getUIContributions('panel').length, 1, '激活后 UI 贡献应存在');

  await host.deactivatePlugin('plugin.ui');
  assert.equal(host.getUIContributions('panel').length, 0, '停用后 UI 贡献必须已被注销');
});
