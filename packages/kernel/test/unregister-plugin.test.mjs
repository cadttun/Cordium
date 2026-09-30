// 插件移除入口 unregisterPlugin 回归测试
//
// 缺陷背景：宿主只有 registerPlugin，没有对应的移除入口 —— host.plugins 只增不减。
// 插件一旦注册就无法卸下，同 id 也无法重新注册（报 already registered）。
//
// 定案：
//   · ACTIVE 时先停用（作用域回收服务/动作/UI），再删除全部宿主记录；
//   · 有必需依赖方 ⇒ 拒绝并列出名单，不级联（同 VS Code #12957；cordis 差异见 host.mjs JSDoc）；
//   · 可选依赖方不阻断；providerEpochs / scopedEpochs 与 manifest 诊断保留。
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost } from '../src/host.mjs';

const SERVICE = 'service.demo';
const m = (id, extra = {}) => ({ id, version: '1.0.0', apiVersion: '1.0.0', ...extra });
const st = (host, id) => host.getDiagnostics().plugins.find(p => p.id === id)?.state;

function makeHost() {
  const host = new CordiumHost();
  host.declareServiceContracts({ [SERVICE]: { access: 'public' } });
  return host;
}

function registerProvider(host, hooks = {}) {
  host.registerPlugin(m('p', { provides: [SERVICE] }), {
    activate(ctx) {
      ctx.provideService(SERVICE, { ping: () => 'pong' });
      ctx.registerAction('demo.ping', { handler: () => 'pong' });
      ctx.registerUIContribution({ id: 'panel.p', type: 'panel' });
    },
    ...hooks
  });
}

test('移除 ACTIVE 插件：先停用，再从宿主消失，服务/动作/UI 回到基线', async () => {
  const host = makeHost();
  const before = host.getDiagnostics();
  let deactivated = 0;
  registerProvider(host, { deactivate() { deactivated += 1; } });
  await host.boot();

  const mid = host.getDiagnostics();
  assert.equal(mid.services.find(s => s.name === SERVICE).activeProvider, 'p');
  assert.equal(mid.actionsCount, before.actionsCount + 1, '正向对照：动作确已登记');
  assert.equal(mid.uiContributionsCount, before.uiContributionsCount + 1, '正向对照：UI 确已登记');

  await host.unregisterPlugin('p');

  const after = host.getDiagnostics();
  assert.equal(deactivated, 1, 'ACTIVE 时必须先走 deactivate');
  assert.equal(st(host, 'p'), undefined, '移除后不得再出现在诊断里');
  assert.equal(after.totalPlugins, before.totalPlugins);
  assert.equal(after.services.find(s => s.name === SERVICE).activeProvider, null);
  assert.equal(after.actionsCount, before.actionsCount);
  assert.equal(after.uiContributionsCount, before.uiContributionsCount);
});

test('移除后同 id 可重新注册并激活', async () => {
  const host = makeHost();
  registerProvider(host);
  await host.boot();
  await host.unregisterPlugin('p');

  registerProvider(host);
  await host.activatePlugin('p');
  assert.equal(st(host, 'p'), 'active');
  assert.equal(await host.dispatchAction('p', 'demo.ping'), 'pong');
});

test('未注册的 id ⇒ 同步抛 not found', () => {
  const host = makeHost();
  assert.throws(() => host.unregisterPlugin('ghost'), hasCode('plugin_not_found', /Plugin 'ghost' not found/));
});

test('有必需依赖方 ⇒ 拒绝并列出名单，插件原样保留；先移除依赖方后可移除', async () => {
  const host = makeHost();
  registerProvider(host);
  host.registerPlugin(m('c', { dependencies: { p: '^1.0.0' } }), { activate() {} });
  await host.boot();

  assert.throws(() => host.unregisterPlugin('p'), hasCode('plugin_has_dependents', /Cannot unregister plugin 'p': required by 'c'/));
  assert.equal(st(host, 'p'), 'active', '被拒绝时不得有任何副作用（不停用、不删除）');
  assert.equal(st(host, 'c'), 'active', '不级联');

  // 正向对照：依赖方移走后，同一调用必须成功
  await host.unregisterPlugin('c');
  await host.unregisterPlugin('p');
  assert.equal(host.getDiagnostics().totalPlugins, 0);
});

test('可选依赖方不阻断；移除后它取服务得 optional_unavailable', async () => {
  const host = new CordiumHost();
  host.declareServiceContracts({ 'svc.o': { access: 'declared', optionalProvider: 'p' } });
  host.registerPlugin(m('p', { provides: ['svc.o'] }), { activate(c) { c.provideService('svc.o', { x: () => 1 }); } });
  let ctx;
  host.registerPlugin(m('c', { optionalDependencies: { p: '*' } }), { activate(c) { ctx = c; } });
  await host.boot();
  assert.equal(ctx.getService('svc.o').x(), 1, '正向对照：移除前可用');

  await host.unregisterPlugin('p');
  assert.equal(st(host, 'c'), 'active', '可选依赖方不受影响');
  assert.throws(() => ctx.getService('svc.o'), err => err.code === 'optional_unavailable');
});

test('提供者移除再重新注册：旧句柄保持失效，新句柄可用（代次不复用）', async () => {
  const host = makeHost();
  registerProvider(host);
  let ctx;
  host.registerPlugin(m('c', { optionalDependencies: { p: '*' } }), { activate(c) { ctx = c; } });
  await host.boot();
  const stale = ctx.getService(SERVICE);
  assert.equal(stale.ping(), 'pong');

  await host.unregisterPlugin('p');
  registerProvider(host);
  await host.activatePlugin('p');

  assert.throws(() => stale.ping(), err => err.code === 'service_unavailable', '旧句柄不得被「复活」');
  assert.equal(ctx.getService(SERVICE).ping(), 'pong');
});

test('排队期间出现新的必需依赖方 ⇒ 任务体内重新校验并拒绝', async () => {
  const host = makeHost();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  host.registerPlugin(m('p'), { async activate() { await gate; } });

  const activating = host.activatePlugin('p');
  const removing = host.unregisterPlugin('p');       // 入口校验时尚无依赖方 ⇒ 排队
  host.registerPlugin(m('c', { dependencies: { p: '^1.0.0' } }), { activate() {} });
  release();

  await activating;
  await assert.rejects(removing, hasCode('plugin_has_dependents', /required by 'c'/));
  assert.equal(st(host, 'p'), 'active');
});

test('并发两次移除：第二次在任务体内得 not found', async () => {
  const host = makeHost();
  registerProvider(host);
  await host.boot();

  const first = host.unregisterPlugin('p');
  const second = host.unregisterPlugin('p');
  await first;
  await assert.rejects(second, hasCode('plugin_not_found', /Plugin 'p' not found/));
});

test('manifest 诊断是历史事实，不随插件移除', async () => {
  const host = makeHost();
  host.registerPlugin(m('p', { typoField: 'oops' }));
  const count = host.getDiagnostics().manifestDiagnostics.length;
  assert.ok(count > 0, '正向对照：确有诊断');

  await host.unregisterPlugin('p');
  assert.equal(host.getDiagnostics().manifestDiagnostics.length, count);
});

// ── 移除插件后的回归 ──────────────────────────
// 根因同一处：unregisterPlugin 让 #plugins 可以缩小 ⇒「先取 id → await → 再按 id 查记录」拿到的可能是
// undefined，或同 id 重新注册后的【另一条】记录。以下每条先红后绿。

function gated() {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  return { gate, release };
}

test('🔴1 boot 途中移除后序插件：boot 跳过它，不抛 TypeError', async () => {
  const host = makeHost();
  const { gate, release } = gated();
  host.registerPlugin(m('a'), { async activate() { await gate; } });
  host.registerPlugin(m('b'), { activate() {} });

  const booting = host.boot();
  await host.unregisterPlugin('b');
  release();

  await booting;
  assert.equal(st(host, 'a'), 'active');
  assert.equal(st(host, 'b'), undefined);
});

test('🔴2a 级联停用途中移除另一个依赖方：停用照常完成', async () => {
  const host = makeHost();
  const { gate, release } = gated();
  registerProvider(host);
  host.registerPlugin(m('c1', { dependencies: { p: '^1.0.0' } }), { activate() {}, async deactivate() { await gate; } });
  host.registerPlugin(m('c2', { dependencies: { p: '^1.0.0' } }), { activate() {} });
  await host.boot();

  const stopping = host.deactivatePlugin('p');     // 卡在 c1 的 deactivate
  await host.unregisterPlugin('c2');
  release();

  await stopping;
  assert.equal(st(host, 'p'), 'disabled');
  assert.equal(st(host, 'c1'), 'disabled');
  assert.equal(st(host, 'c2'), undefined);
});

test('🔴2b 级联恢复途中移除另一个依赖方：恢复照常完成', async () => {
  const host = makeHost();
  const { gate, release } = gated();
  const { gate: entered, release: enter } = gated();
  let activations = 0;
  registerProvider(host);
  host.registerPlugin(m('c1', { dependencies: { p: '^1.0.0' } }), {
    async activate() { activations += 1; if (activations === 2) { enter(); await gate; } }
  });
  host.registerPlugin(m('c2', { dependencies: { p: '^1.0.0' } }), { activate() {} });
  await host.boot();
  await host.deactivatePlugin('p');
  assert.equal(st(host, 'c2'), 'disabled', '正向对照：c2 确被级联停用');

  const resuming = host.activatePlugin('p');
  await entered;                                   // 恢复循环已取完依赖方名单，卡在 c1
  await host.unregisterPlugin('c2');
  release();

  await resuming;
  assert.equal(st(host, 'c1'), 'active');
  assert.equal(st(host, 'c2'), undefined);
});

test('🔴3a 排在移除之后的旧 activate 不得作用到同 id 新注册的插件', async () => {
  const host = makeHost();
  const { gate, release } = gated();
  host.registerPlugin(m('p'), { async activate() { await gate; } });

  const first = host.activatePlugin('p');
  const removing = host.unregisterPlugin('p');
  const stale = host.activatePlugin('p');          // 排在旧记录的队列上
  let fresh = 0;
  removing.then(() => host.registerPlugin(m('p'), { activate() { fresh += 1; } }));
  release();

  await first;
  await removing;
  await assert.rejects(stale, hasCode('plugin_not_found', /Plugin 'p' not found/));
  assert.equal(fresh, 0, '新插件不得被旧调用激活');
  assert.equal(st(host, 'p'), 'discovered');
});

test('🔴3b 排在移除之后的旧 deactivate 不得给新插件打上「用户停用」', async () => {
  const host = makeHost();
  const { gate, release } = gated();
  host.registerPlugin(m('p'), { async activate() { await gate; } });

  const first = host.activatePlugin('p');
  const removing = host.unregisterPlugin('p');
  const stale = host.deactivatePlugin('p');
  removing.then(() => host.registerPlugin(m('p'), { activate() {} }));
  release();

  await first;
  await removing;
  await stale;
  await host.boot();
  assert.equal(st(host, 'p'), 'active', 'boot 必须拉起新插件（未被旧调用标记 disabledByUser）');
});

// ★ 3b 杀不掉「去掉 deactivate 身份校验」的变异体：新插件有 activate 钩子，旧任务跑时它还在 ACTIVATING，
//   #deactivatePluginNow 看到非 ACTIVE 直接返回。无钩子的插件激活是【同步】到 ACTIVE 的 ⇒ 这里能观察到。
test('🔴3c 排在移除之后的旧 deactivate 不得停掉同 id 新注册且已激活的插件', async () => {
  const host = makeHost();
  const { gate, release } = gated();
  host.registerPlugin(m('p'), { async activate() { await gate; } });

  const first = host.activatePlugin('p');
  const removing = host.unregisterPlugin('p');
  const stale = host.deactivatePlugin('p');
  removing.then(() => { host.registerPlugin(m('p')); host.activatePlugin('p'); });
  release();

  await first;
  await removing;
  assert.equal(st(host, 'p'), 'active', '正向对照：旧任务跑之前新插件已同步激活');
  await stale;
  assert.equal(st(host, 'p'), 'active');
});

test('🔴4 停用钩子里注册了必需依赖方 ⇒ 拒绝删除，插件保持已停用', async () => {
  const host = makeHost();
  registerProvider(host, {
    deactivate() { host.registerPlugin(m('c', { dependencies: { p: '^1.0.0' } }), { activate() {} }); }
  });
  await host.boot();

  await assert.rejects(host.unregisterPlugin('p'), hasCode('plugin_has_dependents', /required by 'c'/));
  assert.equal(st(host, 'p'), 'disabled', '不得留下悬空依赖');
});

test('🟠5 同 id 重新激活后，旧 ctx 的 getService / dispatch 必须失效', async () => {
  const host = makeHost();
  registerProvider(host);
  const ctxs = [];
  host.registerPlugin(m('c', { optionalDependencies: { p: '*' } }), { activate(c) { ctxs.push(c); } });
  await host.boot();
  await host.deactivatePlugin('c');
  await host.activatePlugin('c');
  const [stale, fresh] = ctxs;

  assert.equal(fresh.getService(SERVICE).ping(), 'pong', '正向对照：新 ctx 可取服务');
  assert.equal(await fresh.dispatchAction('demo.ping'), 'pong', '正向对照：新 ctx 可调动作');
  assert.throws(() => stale.getService(SERVICE), hasCode('scope_disposed'));
  await assert.rejects(stale.dispatchAction('demo.ping'), hasCode('scope_disposed'));
});

test('🟠6 作用域实现重新注册后，旧作用域句柄不得被「复活」', async () => {
  const host = makeHost();
  host.registerPlugin(m('p', { provides: [SERVICE] }), {
    activate(ctx) { ctx.scoped('agent:a').provideService(SERVICE, { ping: () => 'pong' }); }
  });
  let ctx;
  host.registerPlugin(m('c', { optionalDependencies: { p: '*' } }), { activate(c) { ctx = c; } });
  await host.boot();
  const stale = ctx.scoped('agent:a').getService(SERVICE);
  assert.equal(stale.ping(), 'pong');

  await host.deactivatePlugin('p');
  await host.activatePlugin('p');

  assert.throws(() => stale.ping(), err => err.code === 'service_unavailable');
  assert.equal(ctx.scoped('agent:a').getService(SERVICE).ping(), 'pong', '正向对照：新句柄可用');
});

// ★ 三张鉴权快照表里只有 #pluginOptionalDependencies 的删除可被外部观察：
//   可选范围检查排在「调用方是否注册」之前，残留范围会让已移除的 id 拿到 optional_unavailable。
//   #pluginPermissions / #pluginDependencies 的读取点都先判调用方存在 ⇒ 删不删外部不可区分（等价变异体），
//   删除只为不留内存残留；同 id 重新注册时 registerPlugin 也会整体覆盖。
test('🟠7 移除后可选依赖范围一并清除：已移除的调用方不得再按旧范围被判定', async () => {
  const host = new CordiumHost();
  host.declareServiceContracts({ 'svc.o': { access: 'declared', optionalProvider: 'p' } });
  host.registerPlugin(m('p', { provides: ['svc.o'] }), { activate(c) { c.provideService('svc.o', { x: () => 1 }); } });
  host.registerPlugin(m('c', { optionalDependencies: { p: '^2.0.0' } }), { activate() {} });
  await host.boot();
  assert.throws(() => host.getService('svc.o', 'c'), err => err.code === 'optional_unavailable', '正向对照：范围确在生效');

  await host.unregisterPlugin('c');
  assert.throws(() => host.getService('svc.o', 'c'), hasCode('access_denied', /caller plugin 'c' is not registered/));
});

test('🔴1b boot 回滚不得停掉途中被移除后同 id 重新注册的插件', async () => {
  const host = makeHost();
  const { gate, release } = gated();
  host.registerPlugin(m('a'), { activate() {} });
  host.registerPlugin(m('b'), { async activate() { await gate; throw new Error('boom'); } });

  const booting = host.boot();                     // a 已激活，卡在 b
  await host.unregisterPlugin('a');
  host.registerPlugin(m('a'), { activate() {} });
  await host.activatePlugin('a');
  release();

  // 保留报文断言：插件自抛的错误须原样透传（非 CordiumError、无 code），报文即被测对象
  await assert.rejects(booting, /boom/);  // 保留报文断言：插件自抛的错误须原样透传，报文即被测对象
  assert.equal(st(host, 'a'), 'active', '回滚只撤本次 boot 启动的那条记录');
});

test('🔴2c 级联停用途中新上线的必需依赖方也要停：提供者停下后不得留下活的依赖方', async () => {
  const host = makeHost();
  const { gate, release } = gated();
  registerProvider(host);
  host.registerPlugin(m('c1', { dependencies: { p: '^1.0.0' } }), { activate() {}, async deactivate() { await gate; } });
  await host.boot();

  const stopping = host.deactivatePlugin('p');     // 卡在 c1 的 deactivate，p 仍是 active
  host.registerPlugin(m('c3', { dependencies: { p: '^1.0.0' } }));
  await host.activatePlugin('c3');
  assert.equal(st(host, 'c3'), 'active', '正向对照：c3 确在级联途中上线');
  release();

  await stopping;
  assert.equal(st(host, 'p'), 'disabled');
  assert.equal(st(host, 'c3'), 'disabled');
});

test('🔴2d 排队中的级联停用不得作用到同 id 新注册（且不再依赖提供者）的插件及其依赖方', async () => {
  const host = makeHost();
  const { gate, release } = gated();
  registerProvider(host);
  await host.activatePlugin('p');
  host.registerPlugin(m('c1', { dependencies: { p: '^1.0.0' } }), { async activate() { await gate; } });

  const activating = host.activatePlugin('c1');    // c1 卡在 ACTIVATING
  const removing = host.unregisterPlugin('c1');
  const stopping = host.deactivatePlugin('p');     // 级联任务排在旧 c1 的队列上（移除之后）
  removing.then(() => {
    host.registerPlugin(m('c1'));                  // 同 id、不依赖 p
    host.activatePlugin('c1');
    host.registerPlugin(m('d', { dependencies: { c1: '^1.0.0' } }));
    host.activatePlugin('d');
  });
  await new Promise(resolve => setImmediate(resolve));
  release();

  await activating; await removing; await stopping;
  assert.equal(st(host, 'p'), 'disabled', '正向对照：级联停用确已跑完');
  assert.equal(st(host, 'c1'), 'active');
  assert.equal(st(host, 'd'), 'active', '新 c1 的依赖方不归这次级联管');
});
