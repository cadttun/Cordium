/**
 * @file packages/kernel/test/refactor-characterization.test.mjs
 * @description ★ 特征测试（characterization tests）：**钉住**「依赖拓扑」与「服务鉴权」两组行为的**现状**，
 *   供把 `host.mjs` 里这几段搬到独立模块时做**零行为变更**的机械证明。
 *
 * ── 为什么要有这一份（不是普通单测）────────────────────────────────
 *   重构（搬家）最大的风险是「**搬完行为悄悄变了，而测试没覆盖到**」。
 *   两份 2026 的实操材料都指向同一条纪律：
 *     · 先对**现有代码**写特征测试 → 跑绿 → 再重构 → 确认仍绿（顺序不能反）；
 *     · 「长度不是信号，**共享可变状态**才是信号」。
 *   ⇒ 本文件**只断言现状**（包括看起来像缺陷的地方），**不修正任何行为**。
 *
 * ★ 覆盖面刻意选「即将被搬走的那两块」：
 *   ① `dependency-graph.mjs`：拓扑序 / 未满足依赖 / 环检测 / 反向依赖；
 *   ② `service-resolution.mjs`：提供者解析（全局槽 + 作用域桶）/ access 级别鉴权。
 *   ★ 它们正是「纯计算 + 纯只读」的两块 —— 搬家后这些断言必须**逐条仍绿**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost } from '../src/index.mjs';
import { ErrorCode } from '../src/errors.mjs';

const mk = manifest => ({ apiVersion: '1.0.0', name: manifest.id, version: '1.0.0', ...manifest });

/** 起一个装好若干插件、已 boot 的宿主 */
async function hostWith(manifests, { boot = true } = {}) {
  const host = new CordiumHost();
  for (const m of manifests) host.registerPlugin(mk(m), { activate() {} });
  if (boot) await host.boot();
  return host;
}

// ────────────────────────────────────────────────────────────────
// ① 依赖拓扑（将被搬进 dependency-graph.mjs）
// ────────────────────────────────────────────────────────────────

test('特征·拓扑：boot 按依赖顺序激活（依赖先于依赖方）', async () => {
  const order = [];
  const host = new CordiumHost();
  for (const [id, dep] of [['c', 'b'], ['b', 'a'], ['a', null]]) {
    const manifest = mk({ id, dependencies: dep ? { [dep]: '^1.0.0' } : {} });
    host.registerPlugin(manifest, { activate() { order.push(id); } });
  }
  await host.boot();
  assert.deepEqual(order, ['a', 'b', 'c'], '必须按拓扑序，不能按注册序');
});

test('特征·拓扑：循环依赖 ⇒ 抛 cyclic_dependency 并点名涉及者', async () => {
  const host = new CordiumHost();
  host.registerPlugin(mk({ id: 'x', dependencies: { y: '^1.0.0' } }), { activate() {} });
  host.registerPlugin(mk({ id: 'y', dependencies: { x: '^1.0.0' } }), { activate() {} });
  await assert.rejects(async () => host.boot(), err => {
    assert.equal(err.code, ErrorCode.CYCLIC_DEPENDENCY);
    assert.match(err.message, /x|y/, '必须点名涉及环的插件');
    return true;
  });
});

test('特征·拓扑：缺依赖 ⇒ 诊断报 missing，且 boot 拒绝（同源判据）', async () => {
  const host = await hostWith([{ id: 'needy', dependencies: { ghost: '^1.0.0' } }], { boot: false });
  // ★ 现状：未满足依赖挂在 plugins[].unresolvedDependencies（不是顶层 unresolved）
  const u = host.getDiagnostics().plugins[0].unresolvedDependencies;
  assert.deepEqual(u.map(x => x.reason), ['missing'], '诊断必须报 missing');
  await assert.rejects(async () => host.boot(), err => err.code === ErrorCode.MISSING_DEPENDENCY);
});

test('特征·拓扑：版本不满足 ⇒ 诊断报 version_mismatch', async () => {
  const host = await hostWith([
    { id: 'old', version: '1.0.0' },
    { id: 'needy', dependencies: { old: '^2.0.0' } }
  ], { boot: false });
  const u = host.getDiagnostics().plugins.find(p => p.id === 'needy').unresolvedDependencies;
  assert.deepEqual(u.map(x => x.reason), ['version_mismatch']);
});

test('特征·拓扑：被显式停用的插件不参与装配（不漏到 boot 抛错）', async () => {
  const host = await hostWith([{ id: 'broken', dependencies: { ghost: '^1.0.0' } }], { boot: false });
  await host.deactivatePlugin('broken');
  await host.boot();
  assert.equal(host.getDiagnostics().booted, true, '停用后 boot 必须能过');
});

test('特征·拓扑：dependentsOf / 级联停用与恢复的顺序', async () => {
  const events = [];
  const host = new CordiumHost();
  const base = mk({ id: 'base' });
  const mid = mk({ id: 'mid', dependencies: { base: '^1.0.0' } });
  const top = mk({ id: 'top', dependencies: { mid: '^1.0.0' } });
  host.registerPlugin(base, { activate() { events.push('+base'); }, deactivate() { events.push('-base'); } });
  host.registerPlugin(mid, { activate() { events.push('+mid'); }, deactivate() { events.push('-mid'); } });
  host.registerPlugin(top, { activate() { events.push('+top'); }, deactivate() { events.push('-top'); } });
  await host.boot();
  assert.deepEqual(events, ['+base', '+mid', '+top']);
  events.length = 0;
  await host.deactivatePlugin('base');
  assert.deepEqual(events, ['-top', '-mid', '-base'], '必须先停依赖方');
});

// ────────────────────────────────────────────────────────────────
// ② 服务解析与鉴权（将被搬进 service-resolution.mjs）
// ────────────────────────────────────────────────────────────────

test('特征·解析：全局槽解析到唯一提供者；停用后变 no_provider', async () => {
  const host = new CordiumHost();
  host.declareServiceContract('svc.a', { access: 'public' });
  host.registerPlugin(mk({ id: 'p1', provides: ['svc.a'] }), {
    activate(ctx) { ctx.provideService('svc.a', { ping: () => 'pong' }); }
  });
  await host.boot();
  assert.equal(host.getInternalService('svc.a').ping(), 'pong');
  await host.deactivatePlugin('p1');
  assert.throws(() => host.getInternalService('svc.a'), err => err.code === ErrorCode.NO_PROVIDER);
});

test('特征·解析：作用域桶内解析，跨作用域取不到（no_provider）', async () => {
  const host = new CordiumHost();
  host.declareServiceContract('svc.b', { access: 'public' });
  host.registerPlugin(mk({ id: 'scoped', provides: ['svc.b'] }), {
    activate(ctx) {
      ctx.scoped('team').provideService('svc.b', { who: () => 'team' });
    }
  });
  await host.boot();
  // 根作用域取不到作用域桶里的提供者
  assert.throws(() => host.getInternalService('svc.b'), err => err.code === ErrorCode.NO_PROVIDER);
  // 同一作用域取得到
  assert.equal(host.getInternalService('svc.b', 'team').who(), 'team');
});

test('特征·鉴权：未声明契约 ⇒ undeclared_service；access=sensitive 缺权限 ⇒ access_denied', async () => {
  const host = new CordiumHost();
  assert.throws(() => host.getInternalService('svc.nope'), err => err.code === ErrorCode.UNDECLARED_SERVICE);

  host.declareServiceContract('svc.secret', { access: 'sensitive', requiredPermission: 'read_secret' });
  host.registerPlugin(mk({ id: 'owner', provides: ['svc.secret'] }), {
    activate(ctx) { ctx.provideService('svc.secret', { x: 1 }); }
  });
  await host.boot();
  assert.throws(() => host.getService('svc.secret', 'nobody'), err => {
    assert.equal(err.code, ErrorCode.ACCESS_DENIED);
    return true;
  });
});

test('特征·鉴权：命中权限后放行（正向对照）', async () => {
  const host = new CordiumHost();
  host.declarePermissions(['read_secret']);
  host.declareServiceContract('svc.ok', { access: 'sensitive', requiredPermission: 'read_secret' });
  host.registerPlugin(mk({ id: 'owner2', provides: ['svc.ok'] }), {
    activate(ctx) { ctx.provideService('svc.ok', { v: () => 42 }); }
  });
  // ★ 现状：取 sensitive 服务还要求**声明对提供者的依赖**
  host.registerPlugin(mk({ id: 'consumer', permissions: ['read_secret'], dependencies: { owner2: '^1.0.0' } }), { activate() {} });
  await host.boot();
  assert.equal(host.getService('svc.ok', 'consumer').v(), 42);
});

test('特征·解析：同作用域撞名 ⇒ provider_conflict（一个名字一个提供者）', async () => {
  const host = new CordiumHost();
  host.declareServiceContract('svc.dup', { access: 'public' });
  host.registerPlugin(mk({ id: 'a1', provides: ['svc.dup'] }), {
    activate(ctx) { ctx.provideService('svc.dup', { id: () => 'a1' }); }
  });
  host.registerPlugin(mk({ id: 'a2', provides: ['svc.dup'] }), {
    activate(ctx) { ctx.provideService('svc.dup', { id: () => 'a2' }); }
  });
  await assert.rejects(async () => host.boot(), err => err.code === ErrorCode.PROVIDER_CONFLICT);
});

// ────────────────────────────────────────────────────────────────
// ③ 诊断快照（将被搬进 diagnostics.mjs）
// ────────────────────────────────────────────────────────────────

test('特征·诊断：稳定面字段齐全（搬家后快照形状不得变）', async () => {
  const host = await hostWith([{ id: 'solo' }]);
  const d = host.getDiagnostics();
  // ★ 按【实测】的快照形状（不是按想象）
  for (const k of ['schemaVersion', 'hostVersion', 'booted', 'totalPlugins', 'plugins', 'services',
    'actionsCount', 'permissions', 'uiContributionsCount', 'recentLogs', 'recentErrors',
    'errorLogCount', 'manifestDiagnostics', 'manifestDiagnosticsDropped', 'channel']) {
    assert.ok(k in d, `稳定面缺字段：${k}`);
  }
});

test('特征·诊断：日志环形缓冲保序，且 recordManifestDiagnostic 双通道都写', async () => {
  const host = new CordiumHost();
  host.log('info', 'first');
  host.recordManifestDiagnostic({ path: 'x', pluginId: 'p', fields: ['dropped'], severity: 'warn' });
  const d = host.getDiagnostics();
  assert.ok(d.recentLogs.some(l => l.message === 'first'));
  assert.ok(d.recentLogs.some(l => l.message.includes('dropped')), '诊断必须同时进宿主 log');
  assert.equal(d.manifestDiagnostics.length, 1);
});
