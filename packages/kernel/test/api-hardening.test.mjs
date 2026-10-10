/**
 * @file packages/kernel/test/api-hardening.test.mjs
 * @description 公开面入口校验的判别性测试 —— 把一批「静默 / 裸错」钉成「带码拒绝」。
 *
 * 每条都钉住「改前静默 / 裸错，改后带码拒绝」这个**行为差异**（不是实现细节）。
 * 覆盖面：getService 身份参 / deactivatePlugin 未知 id / optionalProvider / ctx 事件名 /
 * UI 速记与类型集 / ctx 退订函数返回 / replacePlugin 陈旧 error / ctx.scoped 非法 label /
 * getService 非存活态门（后两条此前**无测试触达**）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost } from '../src/index.mjs';
import { describeValue } from '../src/internal.mjs';
import { hasCode } from './fixtures/errors.mjs';

const MANIFEST = id => ({ id, version: '1.0.0', apiVersion: '1.0.0' });

/** 起一个宿主，注册一个提供 svc.p 的插件，返回宿主 */
async function hostWithProvider(svc, access = 'public') {
  const host = new CordiumHost();
  host.declareServiceContract(svc, { access });
  host.registerPlugin({ ...MANIFEST('p.prov'), provides: [svc] }, { activate(c) { c.provideService(svc, { m: () => 1 }); } });
  await host.boot();
  return host;
}

// ── getService 第二参（callerPluginId）类型门 ──
test('★ getService 的 callerPluginId 非字符串 ⇒ invalid_argument（此前 truthy 非字符串直落模板字面量抛裸 TypeError）', async () => {
  const host = await hostWithProvider('svc.g');
  for (const v of [Symbol('s'), {}, 42, ['x']]) {
    assert.throws(() => host.getService('svc.g', v), hasCode('invalid_argument'), `callerPluginId = ${describeValue(v)}`);
  }
  // 正向对照：缺身份仍是 identity_required（falsy 分支未被类型门顶掉）
  assert.throws(() => host.getService('svc.g'), hasCode('identity_required'));
});

// ── deactivatePlugin 未知 id ──
test('★ deactivatePlugin 未知 id ⇒ plugin_not_found（此前静默返回 undefined）', async () => {
  const host = new CordiumHost();
  assert.throws(() => host.deactivatePlugin('no.such.plugin'), hasCode('plugin_not_found'));
  host.registerPlugin(MANIFEST('p.d'), { activate() {} });
  await host.boot();
  await host.deactivatePlugin('p.d');
  assert.equal(host.getDiagnostics().plugins.find(p => p.id === 'p.d').state, 'disabled', '正向对照：已注册的照常停用');
});

// ── optionalProvider 校验 ──
test('★ declareServiceContract 的 optionalProvider 非字符串 / 非 plugin id ⇒ invalid_contract', () => {
  const host = new CordiumHost();
  for (const v of [123, {}, ['a'], 'BAD ID', 'has space']) {
    assert.throws(() => host.declareServiceContract('svc.o', { optionalProvider: v }), hasCode('invalid_contract'), String(v));
  }
  // 正向对照：合法 plugin id / 省略 / null 都通过
  host.declareServiceContract('svc.ok', { optionalProvider: 'plugin.x' });
  host.declareServiceContract('svc.ok2', {});
  host.declareServiceContract('svc.ok3', { optionalProvider: null });
});

// ── ctx 事件入口的事件名门 ──
test('★ ctx 事件入口（emit/parallel/serial/waterfall）事件名非法 ⇒ 带码拒绝（此前发布侧零校验）', async () => {
  const host = new CordiumHost();
  let ctx;
  host.registerPlugin(MANIFEST('p.e'), { activate(c) { ctx = c; } });
  await host.boot();
  for (const bad of ['', 42, {}, null]) {
    const label = describeValue(bad);
    assert.throws(() => ctx.emit(bad), hasCode('invalid_argument'), `emit(${label})`);
    assert.throws(() => ctx.waterfall(bad, () => {}), hasCode('invalid_argument'), `waterfall(${label})`);
    await assert.rejects(() => ctx.parallel(bad), hasCode('invalid_argument'), `parallel(${label})`);
    await assert.rejects(() => ctx.serial(bad), hasCode('invalid_argument'), `serial(${label})`);
  }
  // 正向对照：合法名照常（空事件的 emit 是 no-op）；★ symbol 是**合法**事件名（订阅侧即接受 symbol）
  ctx.emit('e/ok');
  ctx.emit(Symbol('s'));
});

// ── UI 字符串速记与类型值集 ──
test('★ UI 字符串速记 + 已登记类型集不含 custom ⇒ 报错点名「速记」（不是甩 unknown type "custom"）', async () => {
  const host = new CordiumHost();
  host.declareUIContributionTypes(['panel', 'command']);
  let ctx;
  host.registerPlugin(MANIFEST('p.u'), { activate(c) { ctx = c; } });
  await host.boot();
  assert.throws(() => ctx.registerUIContribution('c1'),
    err => err.code === 'invalid_argument' && /string shorthand/.test(err.message));

  // 正向对照：登记了 'custom' ⇒ 速记可用
  const host2 = new CordiumHost();
  host2.declareUIContributionTypes(['custom']);
  let ctx2;
  host2.registerPlugin(MANIFEST('p.u2'), { activate(c) { ctx2 = c; } });
  await host2.boot();
  ctx2.registerUIContribution('c2');
  assert.deepEqual(host2.getUIContributions().map(i => i.id), ['c2']);
});

test('★ getUIContributions(\'\') ⇒ 空集（不是「返回全部」）；省略 / null ⇒ 全部', async () => {
  const host = new CordiumHost();
  let ctx;
  host.registerPlugin(MANIFEST('p.u'), { activate(c) { ctx = c; } });
  await host.boot();
  ctx.registerUIContribution({ id: 'c1', type: 'panel' });
  assert.deepEqual(host.getUIContributions('').map(i => i.id), [], "'' 按精确相等过滤 ⇒ 空集");
  assert.deepEqual(host.getUIContributions().map(i => i.id), ['c1'], '省略 ⇒ 全部');
  assert.deepEqual(host.getUIContributions(null).map(i => i.id), ['c1'], 'null ⇒ 全部');
  assert.deepEqual(host.getUIContributions('panel').map(i => i.id), ['c1']);
});

test('★ declareUIContributionTypes 首尾带空白 ⇒ invalid_argument（校验 trim 却入表原值会焊死类型门）', () => {
  const host = new CordiumHost();
  assert.throws(() => host.declareUIContributionTypes([' theme ']), hasCode('invalid_argument'));
  assert.throws(() => host.declareUIContributionTypes(['   ']), hasCode('invalid_argument'));
  host.declareUIContributionTypes(['theme', 'command']);   // 正向对照：干净值照常
});

// ── ctx 订阅入口返回退订函数（typedef 与运行时一致）──
test('★ ctx.on / once / watchService / watchPluginState 返回【退订函数】（typedef 与运行时一致）', async () => {
  const host = new CordiumHost();
  host.declareServiceContract('svc.w', { access: 'public' });
  let ctx;
  host.registerPlugin(MANIFEST('p.w'), { activate(c) { ctx = c; } });
  await host.boot();
  for (const [name, fn] of [
    ['on', () => ctx.on('e/x', () => {})],
    ['once', () => ctx.once('e/y', () => {})],
    ['watchService', () => ctx.watchService('svc.w', () => {})],
    ['watchPluginState', () => ctx.watchPluginState(() => {})]
  ]) {
    const off = fn();
    assert.equal(typeof off, 'function', `${name} 必须返回退订函数`);
    assert.equal(typeof off(), 'boolean', `${name} 的退订函数返回布尔`);
  }
});

// ── replacePlugin：换代码后旧失败结论作废 ──
test('★ replacePlugin 换掉一个 failed 插件 ⇒ 不再把旧 error 归到新版本（清 error + 退回未尝试态）', async () => {
  const host = new CordiumHost();
  host.registerPlugin({ ...MANIFEST('p.r') }, { activate() { throw new Error('v1 boom'); } });
  await host.boot().then(() => {}, () => {});
  let d = host.getDiagnostics().plugins.find(p => p.id === 'p.r');
  assert.equal(d.state, 'failed');
  assert.match(d.error, /v1 boom/);

  host.replacePlugin({ id: 'p.r', version: '2.0.0', apiVersion: '1.0.0' }, { activate() {} });
  d = host.getDiagnostics().plugins.find(p => p.id === 'p.r');
  assert.equal(d.version, '2.0.0');
  assert.equal(d.error, null, '旧版本的 error 不得挂在新版本头上');
  assert.notEqual(d.state, 'failed', '换代码后不该顶着旧结论');
});

// ── 两条此前无测试触达的公共错误路径 ──
test('★ ctx.scoped(非法 label) ⇒ invalid_argument（此前无测试触达）', async () => {
  const host = new CordiumHost();
  let ctx;
  host.registerPlugin(MANIFEST('p.s'), { activate(c) { ctx = c; } });
  await host.boot();
  for (const bad of ['', 123, Symbol('s'), null, {}]) {
    assert.throws(() => ctx.scoped(bad), hasCode('invalid_argument'), describeValue(bad));
  }
  assert.equal(typeof ctx.scoped('ok'), 'object', '正向对照：合法 label 返回 ctx');
});

test('★ host.getService 调用方非存活态 ⇒ access_denied（此前无测试触达）', async () => {
  const host = await hostWithProvider('svc.p');
  host.registerPlugin(MANIFEST('p.idle'), { activate() {} });
  await host.boot();
  await host.deactivatePlugin('p.idle');
  assert.throws(() => host.getService('svc.p', 'p.idle'), hasCode('access_denied'), '停用的调用方取服务必须被拒');
});
