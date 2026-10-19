/**
 * ★★ `getDiagnostics().revision` 与 `host.watchRegistry` —— 宿主侧的 list-watch。
 *
 * 承诺（revision 在稳定面）：**稳定面任一点名字段变了 ⇒ revision 必已增大**（可以多加，不会漏加）。
 * 核心判据是下面的「投影变 ⇒ revision 变」：跑一遍覆盖各类变更的场景，每步后比对。
 *   漏掉任何一处记账点（运行期注册动作、换代码不换状态……）都会在这里变红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, DIAGNOSTICS_CONTRACT, ErrorCode } from '../src/index.mjs';

const m = (id, extra = {}) => ({ id, version: '1.0.0', apiVersion: '1.0.0', ...extra });

/** 只取稳定面点名的路径 / 键（revision 自己除外）—— 消费方「能依赖的那部分」 */
function stableProjection(snap) {
  const pick = (obj, keys) => Object.fromEntries(keys.filter(k => k !== 'revision').map(k => [k, obj[k]]));
  const root = pick(snap, DIAGNOSTICS_CONTRACT.stable['']);
  root.plugins = snap.plugins.map(p => pick(p, DIAGNOSTICS_CONTRACT.stable['plugins[]']));
  root.services = snap.services.map(s => pick(s, DIAGNOSTICS_CONTRACT.stable['services[]']));
  return JSON.stringify(root);
}

test('★★ 稳定投影变了 ⇒ revision 必已增大（覆盖各类变更点）', async () => {
  const host = new CordiumHost();
  const missed = [];
  const stale = [];
  let last = { proj: stableProjection(host.getDiagnostics()), revision: host.getDiagnostics().revision };
  // ★ list-watch 的真正承诺：「每收到信号就重拉」的消费方，最终看到的必须是此刻的状态。
  //   只比 revision 不够 —— 一步里有别的记账点时，漏掉最后那一处也会被掩盖（如 boot 末尾的 booted 翻转）。
  let seenByWatcher = last.proj;
  host.watchRegistry(() => { seenByWatcher = stableProjection(host.getDiagnostics()); });
  const step = async (label, fn) => {
    await fn();
    const snap = host.getDiagnostics();
    const proj = stableProjection(snap);
    if (proj !== last.proj && snap.revision <= last.revision) missed.push(label);
    if (proj !== seenByWatcher) stale.push(label);
    assert.ok(snap.revision >= last.revision, `${label}：revision 不得回退`);
    last = { proj, revision: snap.revision };
  };

  let ctxB;
  await step('声明服务契约', () => host.declareServiceContracts({ 'svc.kv': { access: 'public' } }));
  await step('注册插件', () => {
    host.registerPlugin(m('p.a', { provides: ['svc.kv'] }), { activate: ctx => ctx.provideService('svc.kv', { get: async () => 1 }) });
    host.registerPlugin(m('p.b', { provides: ['svc.late'] }), { activate(ctx) { ctxB = ctx; } });
  });
  await step('boot', () => host.boot());
  await step('运行期注册动作', () => ctxB.registerAction('b.run', { handler: () => 1 }));
  await step('运行期注册 UI 贡献', () => ctxB.registerUIContribution({ id: 'b.panel', type: 'panel' }));
  await step('运行期声明契约', () => host.declareServiceContracts({ 'svc.late': { access: 'public' } }));
  await step('运行期提供服务（无状态迁移）', () => ctxB.provideService('svc.late', { ping: async () => 1 }));
  // ★ 激活半途抛错：失败迁移先广播，作用域释放（摘动作 / UI / 服务）在**之后** ⇒
  //   摘除路径若不记账，「收到信号就重拉」的消费方会停在多算的计数上。
  await step('激活半途失败（释放晚于 failed 迁移）', async () => {
    host.declareServiceContracts({ 'svc.half': { access: 'public' } });
    host.registerPlugin(m('p.half', { provides: ['svc.half'] }), {
      activate(ctx) {
        ctx.registerAction('half.run', { handler: () => 1 });
        ctx.registerUIContribution({ id: 'half.panel', type: 'panel' });
        ctx.provideService('svc.half', { ping: async () => 1 });
        throw new Error('half-way');
      }
    });
    await host.activatePlugin('p.half').catch(() => {});
  });
  // ★ 同一次释放里有多种摘除时，最后那一处的记账会掩盖前面漏掉的 ⇒ 每种摘除各单独跑一次
  await step('激活半途失败：只摘动作', async () => {
    host.registerPlugin(m('p.half-action'), {
      activate(ctx) { ctx.registerAction('half-action.run', { handler: () => 1 }); throw new Error('x'); }
    });
    await host.activatePlugin('p.half-action').catch(() => {});
  });
  await step('激活半途失败：只摘服务', async () => {
    host.declareServiceContracts({ 'svc.half2': { access: 'public' } });
    host.registerPlugin(m('p.half-svc', { provides: ['svc.half2'] }), {
      activate(ctx) { ctx.provideService('svc.half2', { ping: async () => 1 }); throw new Error('y'); }
    });
    await host.activatePlugin('p.half-svc').catch(() => {});
  });
  await step('停用提供者（服务下线）', () => host.deactivatePlugin('p.a'));
  await step('重新激活', () => host.activatePlugin('p.a'));
  await step('替换未激活插件（只换 manifest，状态不变）', async () => {
    host.registerPlugin(m('p.c'), { activate() {} });
    await host.deactivatePlugin('p.c').catch(() => {});
    await host.replacePlugin(m('p.c', { version: '2.0.0' }), { activate() {} });
  });
  await step('停用 p.b（动作与 UI 随作用域释放）', () => host.deactivatePlugin('p.b'));
  await step('移除插件', () => host.unregisterPlugin('p.c'));

  assert.deepEqual(missed, [], '★ 这些步骤改了稳定面却没让 revision 增大');
  assert.deepEqual(stale, [], '★ 这些步骤之后，「收到信号就重拉」的消费方看到的仍是旧状态（最后一处变更没记账）');
});

test('★ 只读不记账：连拉两次快照 revision 不变', () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.a'), { activate() {} });
  const r = host.getDiagnostics().revision;
  host.getDiagnostics();
  host.getUIContributions();
  host.log('info', 'noise');
  assert.equal(host.getDiagnostics().revision, r, '★ 日志 / 读取属不稳定面或无变化，不该让订阅方白拉');
});

test('★★ watchRegistry：回调内同步拉快照，revision 对得上账且已含这次变化', async () => {
  const host = new CordiumHost();
  const mismatches = [];
  const seen = [];
  host.watchRegistry(({ revision }) => {
    const snap = host.getDiagnostics();
    seen.push(revision);
    if (snap.revision !== revision) mismatches.push({ told: revision, actual: snap.revision });
    // ★ 判 /boom/ 而不是判非 null：error 尚未写入时投影给的是 describeError(undefined) = "undefined"
    const bad = snap.plugins.find(p => p.id === 'p.bad');
    if (bad?.state === 'failed' && !/boom/.test(bad.error)) mismatches.push({ revision, problem: `failed 但 error=${bad.error}` });
  });
  host.registerPlugin(m('p.bad'), { activate() { throw new Error('boom'); } });
  host.registerPlugin(m('p.ok'), { activate() {} });
  await host.boot().catch(() => {});
  await host.activatePlugin('p.bad').catch(() => {});

  assert.deepEqual(mismatches, []);
  assert.ok(seen.length > 0);
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, '★ 无重入时按 revision 递增送达');
  assert.equal(new Set(seen).size, seen.length, '★ 每个 revision 只送一次');
});

test('★ watchPluginState 载荷的 revision 与 watchRegistry 同一条序列', async () => {
  const host = new CordiumHost();
  const fromRegistry = [];
  const fromState = [];
  host.watchRegistry(e => fromRegistry.push(e.revision));
  host.registerPlugin(m('p.obs'), { activate(ctx) { ctx.watchPluginState(e => fromState.push(e.revision)); } });
  host.registerPlugin(m('p.t'), { activate() {} });
  await host.boot();
  await host.deactivatePlugin('p.t');
  assert.ok(fromState.length > 0);
  for (const r of fromState) assert.ok(fromRegistry.includes(r), `状态事件的 revision ${r} 必须是注册表序列里的一员`);
});

test('★ watchRegistry 入口与退订：非函数即拒；退订幂等；监听器抛错不阻断别人与变更本身', () => {
  const host = new CordiumHost();
  for (const bad of [undefined, null, 'fn', {}]) {
    assert.throws(() => host.watchRegistry(bad), { code: ErrorCode.INVALID_ARGUMENT });
  }
  const got = [];
  host.watchRegistry(() => { throw new Error('listener boom'); });
  const off = host.watchRegistry(e => got.push(e.revision));
  host.registerPlugin(m('p.a'), { activate() {} });
  assert.equal(got.length, 1, '★ 前一个监听器抛错不得吞掉后一个的通知');
  assert.equal(host.getDiagnostics().totalPlugins, 1, '★ 监听器抛错不得回滚触发它的变更');
  // 与其余通道监听器同一口径：warn 级进审计日志（不进 recentErrors）
  assert.ok(host.getDiagnostics().recentLogs.some(e => e.level === 'warn' && /listener boom/.test(JSON.stringify(e))), '★ 抛错进审计日志');
  assert.equal(off(), true);
  assert.equal(off(), false);
  host.registerPlugin(m('p.b'), { activate() {} });
  assert.equal(got.length, 1, '★ 退订后不再收到');
});

test('★ 载荷冻结、只带 revision（轻信号：内容自己去拉）', () => {
  const host = new CordiumHost();
  const seen = [];
  host.watchRegistry(e => seen.push(e));
  host.registerPlugin(m('p.a'), { activate() {} });
  assert.ok(Object.isFrozen(seen[0]));
  assert.deepEqual(Object.keys(seen[0]), ['revision']);
});
