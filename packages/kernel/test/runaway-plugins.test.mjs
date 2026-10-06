/**
 * @file packages/kernel/test/runaway-plugins.test.mjs
 * @description 失控插件：生命周期钩子挂起、动作递归派发、插件抛出的错误如何送达调用方。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, CordiumError, MessageChannel } from '../src/index.mjs';
import { hasCode } from './fixtures/errors.mjs';

const never = () => new Promise(() => {});
const register = (host, id, hooks, extra = {}, options) =>
  host.registerPlugin({ id, version: '1.0.0', apiVersion: '1.0.0', ...extra }, hooks, options);

// ════════════════ 一、生命周期超时 ════════════════

test('★ activate() 永不结束 ⇒ boot 在 lifecycleTimeoutMs 内以 lifecycle_timeout 失败并回滚；之后可重试', async () => {
  const host = new CordiumHost({ lifecycleTimeoutMs: 80 });
  let hang = true;
  let late = null;
  register(host, 'p.slow', { async activate(ctx) { if (hang) { late = ctx; await never(); } } });
  const t0 = Date.now();
  await assert.rejects(host.boot(), hasCode('lifecycle_timeout', /p\.slow.*80ms/));
  assert.ok(Date.now() - t0 < 2000, 'boot 必须在预算附近返回，不能永久挂起');
  const [diag] = host.getDiagnostics().plugins;
  assert.equal(diag.state, 'failed');
  assert.ok(diag.activationMs >= 80, '诊断带激活耗时');
  // 超时后仍在跑的 activate 想再登记：作用域已释放 ⇒ 被生命周期门拒绝
  assert.throws(() => late.on('e', () => {}), hasCode('scope_disposed'));
  hang = false;
  await host.activatePlugin('p.slow');
  assert.equal(host.getDiagnostics().plugins[0].state, 'active', 'FAILED 不是拉黑：修好后可再次激活');
});

test('★ deactivate() 与清理回调都永不结束 ⇒ 停用在预算内走到 disabled，服务 / 动作 / 监听器全部摘除', async () => {
  const host = new CordiumHost({ lifecycleTimeoutMs: 80 });
  host.declareServiceContract('svc.x', { access: 'public' });
  let a, b, heard = 0, laterDisposerRan = false;
  register(host, 'p.a', { activate(c) { a = c; }, deactivate: never }, { provides: ['svc.x'] });
  register(host, 'p.b', { activate(c) { b = c; } });
  await host.boot();
  a.provideService('svc.x', { hi: () => 'hi' });
  a.registerAction('act.a', { handler: () => 'a' });
  a.on('e', () => { heard += 1; });
  a.scope.addDisposer(() => { laterDisposerRan = true; });   // 逆序执行 ⇒ 在挂起的那个之后
  a.scope.addDisposer(never);
  const t0 = Date.now();
  await host.deactivatePlugin('p.a');
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(host.getDiagnostics().plugins[0].state, 'disabled');
  assert.throws(() => b.getService('svc.x'), CordiumError, '服务已摘除（此前停用卡住时仍可取）');
  await assert.rejects(b.dispatchAction('act.a'), hasCode('action_not_found'), '动作已摘除（此前仍可派发）');
  b.emit('e');
  assert.equal(heard, 0, '监听器已摘除');
  assert.ok(laterDisposerRan, '挂起的清理回调之后的回调照样执行');
  assert.ok(host.getDiagnostics().recentErrors.some(e => /lifecycle budget/.test(e.message)), '清理超时进错误日志');
  await host.activatePlugin('p.a');
  assert.equal(host.getDiagnostics().plugins[0].state, 'active', '同一插件后续的生命周期操作不再被堵死');
});

test('★ 停用进行中（清理回调挂起、预算未到）：服务 / 动作 / 监听器此刻就已摘除，不等预算耗尽', async () => {
  // 预算 800ms：检查点在 20ms 时（远未耗尽）；结尾等停用收完，不留挂着的计时器
  const host = new CordiumHost({ lifecycleTimeoutMs: 800 });
  host.declareServiceContract('svc.x', { access: 'public' });
  let a, b, heard = 0;
  register(host, 'p.a', { activate(c) { a = c; } }, { provides: ['svc.x'] });
  register(host, 'p.b', { activate(c) { b = c; } });
  await host.boot();
  a.provideService('svc.x', { hi: () => 'hi' });
  a.registerAction('act.a', { handler: () => 'a' });
  a.on('e', () => { heard += 1; });
  a.scoped('team');
  assert.equal(host.getDiagnostics().channel.scopes.length, 1);
  a.scope.addDisposer(never);
  const stopping = host.deactivatePlugin('p.a');   // 先不 await：清理回调挂着
  await new Promise(r => setTimeout(r, 20));
  assert.equal(host.getDiagnostics().plugins[0].state, 'stopping', '确实还在停用中');
  assert.throws(() => b.getService('svc.x'), CordiumError);
  await assert.rejects(b.dispatchAction('act.a'), hasCode('action_not_found'));
  b.emit('e');
  assert.equal(heard, 0);
  assert.equal(host.getDiagnostics().channel.scopes.length, 0, '作用域引用已归还');
  await stopping;
});

test('宿主侧放宽单个插件的预算：registerPlugin 第三参；manifest 里写同名字段无效', async () => {
  // 分两个宿主：同一宿主里一个插件超时会让 boot 整体回滚，把另一个也停掉（boot 的既有语义）
  const slow = { activate: () => new Promise(r => setTimeout(r, 150)) };
  const allowed = new CordiumHost({ lifecycleTimeoutMs: 50 });
  register(allowed, 'p.allowed', slow, {}, { lifecycleTimeoutMs: 2000 });
  await allowed.boot();
  assert.equal(allowed.getDiagnostics().plugins[0].state, 'active');
  const self = new CordiumHost({ lifecycleTimeoutMs: 50 });
  register(self, 'p.self', slow, { lifecycleTimeoutMs: 2000 });   // 插件自己写进 manifest：被白名单丢弃
  await assert.rejects(self.boot(), hasCode('lifecycle_timeout', /p\.self/));
});

test('lifecycleTimeoutMs 校验：宿主选项与 registerPlugin 选项同一规则；0 = 不限', async () => {
  for (const bad of [2 ** 31, NaN, '100', Infinity]) {
    assert.throws(() => new CordiumHost({ lifecycleTimeoutMs: bad }), hasCode('invalid_option'));
    assert.throws(() => register(new CordiumHost(), 'p.x', {}, {}, { lifecycleTimeoutMs: bad }), hasCode('invalid_option'));
  }
  assert.throws(() => register(new CordiumHost(), 'p.x', {}, {}, 'abc'), hasCode('invalid_option'));
  assert.equal(new CordiumHost().lifecycleTimeoutMs, 30000);
  const host = new CordiumHost({ lifecycleTimeoutMs: 0 });
  register(host, 'p.x', { activate: () => new Promise(r => setTimeout(r, 60)) });
  await host.boot();
  assert.equal(host.getDiagnostics().plugins[0].state, 'active');
});

test('插件拿不到宿主自有释放的登记口（addHostDisposer 要释放令牌）', async () => {
  const host = new CordiumHost();
  let ctx;
  register(host, 'p.a', { activate(c) { ctx = c; } });
  await host.boot();
  assert.throws(() => ctx.scope.addHostDisposer(() => {}), hasCode('scope_owned_by_host'));
  assert.throws(() => ctx.scope.addHostDisposer(() => {}, Symbol('cordium.scope-release')), hasCode('scope_owned_by_host'));
});

// ════════════════ 二、在途派发数上限 ════════════════

test('★ 动作异步自递归 ⇒ 在途数触顶即 action_overloaded，内存有界；宿主之后照常可用', async () => {
  const host = new CordiumHost({ maxInFlightActions: 200 });
  let ctx, calls = 0;
  register(host, 'p.a', { activate(c) { ctx = c; } });
  await host.boot();
  ctx.registerAction('act.loop', { handler: () => { calls += 1; return ctx.dispatchAction('act.loop'); } });
  const err = await ctx.dispatchAction('act.loop').then(() => null, e => e);
  assert.equal(calls, 200, '恰好调用到上限次数，第 201 次在调用处理器之前被拒');
  let inner = err;
  while (inner?.cause) inner = inner.cause;
  assert.equal(inner.code, 'action_overloaded', '最内层是闸门本身');
  assert.equal(err.code, 'action_failed');
  assert.ok(err.message.length < 200, '报文不随嵌套层数增长（每层只引用下层的码）');
  assert.equal(host.getDiagnostics().recentLogs.filter(l => /overloaded/.test(l.message)).length, 1, '告警限频：一次风暴只记一条');
  ctx.registerAction('act.ok', { handler: () => 'fine' });
  assert.equal(await ctx.dispatchAction('act.ok'), 'fine', '在途数全部归还');
});

test('两个插件互相派发同样被拦住；并发扇出也计入', async () => {
  const host = new CordiumHost({ maxInFlightActions: 50 });
  let a, b;
  register(host, 'p.a', { activate(c) { a = c; } });
  register(host, 'p.b', { activate(c) { b = c; } });
  await host.boot();
  a.registerAction('act.a', { handler: () => a.dispatchAction('act.b') });
  b.registerAction('act.b', { handler: () => b.dispatchAction('act.a') });
  await assert.rejects(a.dispatchAction('act.a'), hasCode('action_failed'));
  let release;
  const gate = new Promise(r => { release = r; });
  a.registerAction('act.wait', { handler: () => gate });
  const pending = Array.from({ length: 50 }, () => a.dispatchAction('act.wait'));
  await assert.rejects(a.dispatchAction('act.wait'), hasCode('action_overloaded'));
  await assert.rejects(a.dispatchAction('act.wait'), hasCode('action_overloaded'));
  assert.equal(host.getDiagnostics().recentLogs.filter(l => /overloaded/.test(l.message)).length, 2,
    '限频：互相递归那一轮一条、这一轮一条（回落后重新允许告警），同一轮里连续被拒只记一条');
  release();
  await Promise.all(pending);
});

test('maxInFlightActions 校验与默认值', () => {
  assert.equal(new CordiumHost().maxInFlightActions, 10000);
  for (const bad of [0, -1, 1.5, '10']) assert.throws(() => new CordiumHost({ maxInFlightActions: bad }), hasCode('invalid_option'));
});

// ════════════════ 三、错误信封 ════════════════

const THROWN = ['raw', undefined, 42, new Error('boom')];

test('★ 动作处理器抛任意值 ⇒ action_failed，pluginId = 处理器属主，原值原样在 cause', async () => {
  for (const thrown of THROWN) {
    const host = new CordiumHost();
    let a, b;
    register(host, 'p.owner', { activate(c) { a = c; } });
    register(host, 'p.caller', { activate(c) { b = c; } });
    await host.boot();
    a.registerAction('act.t', { handler: () => { throw thrown; } });
    a.registerAction('act.async', { handler: async () => { throw thrown; } });
    for (const action of ['act.t', 'act.async']) {
      const err = await b.dispatchAction(action).then(() => null, e => e);
      assert.ok(err instanceof CordiumError, String(thrown));
      assert.equal(err.code, 'action_failed');
      assert.equal(err.pluginId, 'p.owner');
      assert.equal(err.cause, thrown, '原值不丢');
    }
  }
});

test('★ 嵌套派发：内层的码不再冒充外层 —— 外层 action_failed，内层判定在 cause', async () => {
  const host = new CordiumHost();
  let a;
  register(host, 'p.a', { activate(c) { a = c; } });
  await host.boot();
  a.registerAction('act.outer', { handler: () => a.dispatchAction('act.missing') });
  a.registerAction('act.slow', { handler: never, timeoutMs: 30 });
  a.registerAction('act.wrap', { handler: () => a.dispatchAction('act.slow'), timeoutMs: 5000 });
  const missing = await a.dispatchAction('act.outer').then(() => null, e => e);
  assert.equal(missing.code, 'action_failed', '外层动作是存在的 —— 不得报成 action_not_found');
  assert.equal(missing.cause.code, 'action_not_found');
  const slow = await a.dispatchAction('act.wrap').then(() => null, e => e);
  assert.equal(slow.code, 'action_failed', '外层没有超时 —— 不得报成 action_timeout');
  assert.equal(slow.cause.code, 'action_timeout');
  assert.equal(host.getDiagnostics().recentLogs.filter(l => l.details?.outcome === 'timeout').length, 1,
    '超时审计只记真正超时的那一层（act.slow），不把外层也记成超时');
  // 本次调用自己的判定照旧不包
  await assert.rejects(a.dispatchAction('act.none'), hasCode('action_not_found'));
});

test('★ 通道 serial / waterfall 与 parallel 同一口径：监听器抛错 ⇒ listener_failed，原值在 cause', async () => {
  for (const thrown of THROWN) {
    const ch = new MessageChannel();
    ch.subscribe('s', () => { throw thrown; });
    ch.subscribe('a', async () => { throw thrown; });
    const check = err => hasCode('listener_failed')(err) && err.cause === thrown;
    await assert.rejects(ch.serial('s'), check);
    await assert.rejects(ch.serial('a'), check, 'serial 的异步拒绝');
    assert.throws(() => ch.waterfall('s', 1, () => 0), check);
    await assert.rejects(ch.waterfall('a', 1, () => 0), check, 'waterfall 的异步拒绝');
  }
});

test('waterfall：多层监听器只套一层信封；兜底函数与 next() 用法错误原样送达', async () => {
  const ch = new MessageChannel();
  ch.subscribe('w', (x, next) => next());
  ch.subscribe('w', (x, next) => next());
  ch.subscribe('w', () => { throw 'deep'; });
  const err = (() => { try { ch.waterfall('w', 1, () => 0); } catch (e) { return e; } })();
  assert.equal(err.code, 'listener_failed');
  assert.equal(err.cause, 'deep', '一层信封，cause 直接是原值');

  const own = new Error('fallback');
  const ch2 = new MessageChannel();
  ch2.subscribe('w', (x, next) => next());
  assert.throws(() => ch2.waterfall('w', 1, () => { throw own; }), e => e === own, '兜底是调用方自己的函数');
  await assert.rejects(ch2.waterfall('w', 1, async () => { throw own; }), e => e === own);

  const ch3 = new MessageChannel();
  ch3.subscribe('w', (x, next) => { next(); return next(); });
  assert.throws(() => ch3.waterfall('w', 1, () => 0), hasCode('invalid_usage'), '本层的用法错误不包');
});

test('★ 服务方法抛任意值（同步 / 异步）⇒ service_failed，pluginId = 提供者；句柄自己的判定不包', async () => {
  for (const thrown of THROWN) {
    const host = new CordiumHost();
    host.declareServiceContract('svc.x', { access: 'public' });
    let a, b;
    register(host, 'p.provider', { activate(c) { a = c; } }, { provides: ['svc.x'] });
    register(host, 'p.consumer', { activate(c) { b = c; } });
    await host.boot();
    a.provideService('svc.x', { sync() { throw thrown; }, async later() { throw thrown; }, ok: () => 7 });
    const svc = b.getService('svc.x');
    const check = err => hasCode('service_failed')(err) && err.pluginId === 'p.provider' && err.cause === thrown;
    assert.throws(() => svc.sync(), check);
    await assert.rejects(svc.later(), check);
    assert.equal(svc.ok(), 7);
    await host.deactivatePlugin('p.provider');
    assert.throws(() => svc.ok(), hasCode('service_unavailable'), '句柄失效是句柄自己的判定，不套 service_failed');
  }
});
