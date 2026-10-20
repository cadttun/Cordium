/**
 * ★★ 按插件的派发计数（`getDiagnostics().plugins[].counters`，不稳定面）。
 *
 * 口径（action-registry.mjs 的 dispatch）：
 *   · 处理方记 handled / failed / timedOut：handled 含失败与超时，failed 与 timedOut 不重叠
 *     （OpenTelemetry「Recording errors」：成功与失败报在同一个指标里，失败是其中一类）；
 *   · 发起方只记 dispatched；宿主自己发起的（HOST_CALLER）没有插件记录可挂 ⇒ 不记发起方；
 *   · 只数真的调到了处理器的：没有这个动作 / 缺权限 / 调用方不活 / 过载 —— 一律不数；
 *   · 嵌套失败逐层都记（与审计的「只记一次」不同）；处理器接住内层失败、自己正常返回 ⇒ 它不算失败；
 *   · 注册与 replacePlugin 各开一轮（since 变；同一毫秒内连开两轮顺延 1ms）；停用再激活不重置；移除插件随记录消失；
 *   · 计数变化不让 revision +1（否则每次派发都会触发 watchRegistry）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, ErrorCode } from '../src/index.mjs';

const m = (id, extra = {}) => ({ id, version: '1.0.0', apiVersion: '1.0.0', ...extra });
const recordOf = (host, id) => host.getDiagnostics().plugins.find(p => p.id === id);
const countsOf = (host, id) => {
  const rec = recordOf(host, id);
  if (!rec) return undefined;
  const { since, ...counts } = rec.counters;
  return counts;
};
const zero = { handled: 0, failed: 0, timedOut: 0, dispatched: 0 };
const tick = () => new Promise(r => setTimeout(r, 0));

test('★★ 处理方记 handled / failed / timedOut，发起方只记 dispatched', async () => {
  const host = new CordiumHost();
  let caller;
  host.registerPlugin(m('p.owner'), {
    activate(ctx) {
      ctx.registerAction('act.ok', { handler: () => 1 });
      ctx.registerAction('act.boom', { handler: () => { throw new Error('boom'); } });
      ctx.registerAction('act.hang', { timeoutMs: 20, handler: () => new Promise(() => {}) });
    }
  });
  host.registerPlugin(m('p.caller'), { activate(ctx) { caller = ctx; } });
  await host.boot();

  await caller.dispatchAction('act.ok');
  await caller.dispatchAction('act.ok');
  await caller.dispatchAction('act.boom').catch(() => {});
  await caller.dispatchAction('act.hang').catch(() => {});

  assert.deepEqual(countsOf(host, 'p.owner'), { handled: 4, failed: 1, timedOut: 1, dispatched: 0 });
  assert.deepEqual(countsOf(host, 'p.caller'), { handled: 0, failed: 0, timedOut: 0, dispatched: 4 });
});

test('★ 宿主自己发起的派发：只记处理方（宿主没有插件记录可挂发起方）', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.owner'), { activate(ctx) { ctx.registerAction('act.ok', { handler: () => 1 }); } });
  await host.boot();
  await host.dispatchActionAsHost('act.ok');
  assert.deepEqual(countsOf(host, 'p.owner'), { ...zero, handled: 1 });
});

test('★★ 没调到处理器的一律不数：没有这个动作 / 缺权限 / 调用方不活', async () => {
  const host = new CordiumHost();
  host.declarePermissions(['perm.x']);
  let caller;
  host.registerPlugin(m('p.owner'), {
    activate(ctx) { ctx.registerAction('act.guarded', { requiredPermission: 'perm.x', handler: () => 1 }); }
  });
  host.registerPlugin(m('p.caller'), { activate(ctx) { caller = ctx; } });
  await host.boot();

  await assert.rejects(caller.dispatchAction('act.missing'), { code: ErrorCode.ACTION_NOT_FOUND });
  await assert.rejects(caller.dispatchAction('act.guarded'), { code: ErrorCode.ACCESS_DENIED });
  await host.deactivatePlugin('p.caller');
  await assert.rejects(host.dispatchAction('p.caller', 'act.guarded'), { code: ErrorCode.ACCESS_DENIED });

  assert.deepEqual(countsOf(host, 'p.owner'), zero);
  assert.deepEqual(countsOf(host, 'p.caller'), zero);
});

test('★ 过载被拒的那一次不数；风暴里逐层失败各记一次（计数不去重）', async () => {
  const host = new CordiumHost({ maxInFlightActions: 50 });
  host.registerPlugin(m('p.rec'), {
    activate(ctx) { ctx.registerAction('act.rec', { handler: () => ctx.dispatchAction('act.rec') }); }
  });
  await host.boot();
  await assert.rejects(host.dispatchActionAsHost('act.rec'), { code: ErrorCode.ACTION_FAILED });
  // 50 次调到了处理器（第 51 次被在途数闸拒掉）；其中 49 次由它自己发起（第 1 次是宿主发起的）
  assert.deepEqual(countsOf(host, 'p.rec'), { handled: 50, failed: 50, timedOut: 0, dispatched: 49 });
});

test('★ 懒激活「未命中 → 拉起 → 重试」只数重试那一次', async () => {
  const host = new CordiumHost();
  let caller;
  host.registerPlugin(m('p.lazy', { activation: 'lazy' }), {
    activate(ctx) { ctx.registerAction('act.lazy', { handler: () => 'ok' }); }
  });
  host.registerPlugin(m('p.caller'), { activate(ctx) { caller = ctx; } });
  await host.boot();
  assert.equal(await caller.dispatchAction('act.lazy'), 'ok');
  assert.deepEqual(countsOf(host, 'p.lazy'), { ...zero, handled: 1 });
  assert.deepEqual(countsOf(host, 'p.caller'), { ...zero, dispatched: 1 });
});

test('★ 内层失败、外层原样往外抛 ⇒ 两层各记一次失败（审计只记一条，计数不去重）', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.inner'), {
    activate(ctx) { ctx.registerAction('act.inner', { handler: () => { throw new Error('inner'); } }); }
  });
  host.registerPlugin(m('p.outer'), {
    activate(ctx) { ctx.registerAction('act.outer', { handler: () => ctx.dispatchAction('act.inner') }); }
  });
  await host.boot();
  await assert.rejects(host.dispatchActionAsHost('act.outer'), { code: ErrorCode.ACTION_FAILED });
  assert.deepEqual(countsOf(host, 'p.inner'), { ...zero, handled: 1, failed: 1 });
  assert.deepEqual(countsOf(host, 'p.outer'), { ...zero, handled: 1, failed: 1, dispatched: 1 });
  assert.equal(host.getDiagnostics().recentLogs.filter(l => l.details?.outcome === 'error').length, 1);
});

test('★ 处理器接住内层失败、自己正常返回 ⇒ 只有内层算失败', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.inner'), {
    activate(ctx) { ctx.registerAction('act.inner', { handler: () => { throw new Error('inner'); } }); }
  });
  host.registerPlugin(m('p.outer'), {
    activate(ctx) {
      ctx.registerAction('act.outer', { handler: async () => { await ctx.dispatchAction('act.inner').catch(() => {}); return 'ok'; } });
    }
  });
  await host.boot();
  assert.equal(await host.dispatchActionAsHost('act.outer'), 'ok');
  assert.deepEqual(countsOf(host, 'p.inner'), { ...zero, handled: 1, failed: 1 });
  assert.deepEqual(countsOf(host, 'p.outer'), { ...zero, handled: 1, dispatched: 1 });
});

test('★ 执行中处理方被停用、结果作废（action_owner_gone）⇒ 算调到了，不算失败也不算超时', async () => {
  const host = new CordiumHost();
  let release;
  host.registerPlugin(m('p.owner'), {
    activate(ctx) { ctx.registerAction('act.slow', { handler: () => new Promise(r => { release = r; }) }); }
  });
  await host.boot();
  const pending = host.dispatchActionAsHost('act.slow');
  await tick();
  await host.deactivatePlugin('p.owner');
  release('late');
  await assert.rejects(pending, { code: ErrorCode.ACTION_OWNER_GONE });
  assert.deepEqual(countsOf(host, 'p.owner'), { ...zero, handled: 1 });
});

test('★★ 计数窗口：停用再激活不重置；replacePlugin 开新一轮（since 变）；移除插件随记录消失', async () => {
  const host = new CordiumHost();
  const impl = { activate(ctx) { ctx.registerAction('act.ok', { handler: () => 1 }); } };
  host.registerPlugin(m('p.a'), impl);
  await host.boot();
  await host.dispatchActionAsHost('act.ok');
  await host.deactivatePlugin('p.a');
  await host.activatePlugin('p.a');
  await host.dispatchActionAsHost('act.ok');
  assert.deepEqual(countsOf(host, 'p.a'), { ...zero, handled: 2 }, '★ 同一份实现停用再激活：接着数');

  const before = recordOf(host, 'p.a').counters.since;
  await host.replacePlugin(m('p.a', { version: '1.1.0' }), impl);
  assert.deepEqual(countsOf(host, 'p.a'), zero, '★ 换了实现：新一轮从 0 数');
  assert.notEqual(recordOf(host, 'p.a').counters.since, before, '★ since 变了 ⇒ 读的人知道中间重置过');

  await host.unregisterPlugin('p.a');
  assert.equal(countsOf(host, 'p.a'), undefined);
});

test('★★ 同一毫秒内连开两轮：since 仍换新值（顺延 1ms），且只顺延这一个插件', async (t) => {
  // 时钟停住 ⇒ 每一步都落在同一毫秒；判据不靠真时钟走动
  const frozen = Date.now();
  t.mock.method(Date, 'now', () => frozen);
  const impl = { activate() {} };
  const host = new CordiumHost();
  host.registerPlugin(m('p.a'), impl);
  host.registerPlugin(m('p.b'), impl);
  await host.boot();
  const sinceOf = (id) => recordOf(host, id).counters.since;
  assert.equal(sinceOf('p.a'), frozen);
  assert.equal(sinceOf('p.b'), frozen, '★ 按插件各算各的：同一毫秒注册的一批插件，起点都是此刻，不被挤到未来');

  await host.replacePlugin(m('p.a', { version: '1.1.0' }), impl);
  assert.equal(sinceOf('p.a'), frozen + 1, '★ 同一毫秒内换实现 ⇒ 顺延 1ms，读的人照样看得出换了一轮');

  await host.unregisterPlugin('p.a');
  host.registerPlugin(m('p.a'), impl);
  assert.equal(sinceOf('p.a'), frozen + 2, '★ 注销后马上重新注册也一样');
  assert.equal(sinceOf('p.b'), frozen, '★ 别的插件不受影响');
});

test('★ 执行中途 replacePlugin：旧实现迟到的失败记在旧一轮，不算到新实现头上', async () => {
  const host = new CordiumHost();
  let fail;
  host.registerPlugin(m('p.a'), {
    activate(ctx) { ctx.registerAction('act.slow', { handler: () => new Promise((_, reject) => { fail = reject; }) }); }
  });
  await host.boot();
  const pending = host.dispatchActionAsHost('act.slow');
  await tick();
  await host.replacePlugin(m('p.a', { version: '2.0.0' }), {
    activate(ctx) { ctx.registerAction('act.slow', { handler: () => 'new' }); }
  });
  fail(new Error('old impl failed late'));
  await assert.rejects(pending, { code: ErrorCode.ACTION_FAILED });
  assert.deepEqual(countsOf(host, 'p.a'), zero);
});

test('★ 计数变化不让 revision +1、不触发 watchRegistry；快照里的计数是副本', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.a'), { activate(ctx) { ctx.registerAction('act.ok', { handler: () => 1 }); } });
  await host.boot();
  const rev = host.getDiagnostics().revision;
  let signals = 0;
  host.watchRegistry(() => { signals += 1; });
  for (let i = 0; i < 5; i++) await host.dispatchActionAsHost('act.ok');
  assert.equal(host.getDiagnostics().revision, rev);
  assert.equal(signals, 0);

  recordOf(host, 'p.a').counters.handled = 999;
  assert.equal(countsOf(host, 'p.a').handled, 5, '★ 改快照不回写宿主');
});
