/**
 * ★★ 依赖没齐时，**诊断快照必须说得出原因**。
 *
 * ── 修的是什么 ──────────────────────────────────────────────────────
 *   `boot()` 遇到缺失依赖会抛 `missing_dependency`（响亮，这是对的），
 *   但**回滚之后**快照里只剩 `state: 'discovered'` + `error: null` —— 实测：
 *
 *     plugin.needs-ghost   state = discovered   error = null
 *     ★ 运维者事后完全看不出「这个插件为什么没起来」
 *
 *   ⇒ 快照的 `plugins[]` 补一项 `unresolvedDependencies: [{ id, reason }]`，
 *     `reason ∈ {'missing', 'version_mismatch'}`。
 *
 * ── 为什么是【诊断字段】而不是新状态 ────────────────────────────────
 *   对照 OSGi：它也没有 `waiting_dependencies` 这样的状态 ——
 *   「等待依赖」被表达为「尚未进入 `RESOLVED`」。本仓同理：
 *   状态机保持 7 态，把「等什么」放进可观察的数据面。
 *
 * ── 只报 { id, reason }，不带版本号 ────────────────────────────────
 *   期望范围在快照的 `dependencies` 里、实际版本在对方的 `version` 里，**都已经有了**。
 *   再带一份就是造第二真相源 —— 本仓已为「同值不同源」踩过坑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, LifecycleState, UnresolvedReason, UNRESOLVED_REASON_VALUES } from '../src/index.mjs';

/** 登记一批插件，boot（吞掉失败），返回快照里按 id 索引的插件记录 */
async function snapshotOf(manifests) {
  const host = new CordiumHost();
  for (const m of manifests) host.registerPlugin(m, { activate() {} });
  await host.boot().catch(() => {});
  return new Map(host.getDiagnostics().plugins.map(p => [p.id, p]));
}

const base = (id, extra = {}) => ({ id, version: '1.0.0', apiVersion: '1.0.0', ...extra });

test('★ 必需依赖【根本不存在】⇒ reason=missing（此前只有 state=discovered + error=null）', async () => {
  const snap = await snapshotOf([base('plugin.needs-ghost', { dependencies: { 'plugin.ghost': '^1.0.0' } })]);
  assert.deepEqual(snap.get('plugin.needs-ghost').unresolvedDependencies,
    [{ id: 'plugin.ghost', reason: 'missing' }]);
});

test('★ 必需依赖【版本不符】⇒ reason=version_mismatch', async () => {
  const snap = await snapshotOf([
    base('plugin.dep'),
    base('plugin.needs-newer', { dependencies: { 'plugin.dep': '^2.0.0' } })
  ]);
  assert.deepEqual(snap.get('plugin.needs-newer').unresolvedDependencies,
    [{ id: 'plugin.dep', reason: 'version_mismatch' }]);
});

test('★ 正向对照：依赖齐备 ⇒ 【空数组】，不是缺字段、也不是 null', async () => {
  // ★ 没有这条，上面两条可能是恒真的（比如实现无脑返回一条错误）
  const snap = await snapshotOf([
    base('plugin.a'),
    base('plugin.b', { dependencies: { 'plugin.a': '^1.0.0' } })
  ]);
  const b = snap.get('plugin.b');
  assert.deepEqual(b.unresolvedDependencies, [], '依赖满足时必须交空数组');
  assert.ok(Object.hasOwn(b, 'unresolvedDependencies'), '键必须存在（消费方按 hasOwn 判）');
});

test('★ 只收【必需】依赖：可选依赖缺席是它的正常形态，不得报进 unresolved', async () => {
  const snap = await snapshotOf([base('plugin.opt', { optionalDependencies: { 'plugin.maybe': '^1.0.0' } })]);
  assert.deepEqual(snap.get('plugin.opt').unresolvedDependencies, [],
    '可选依赖缺席按设计放行（取服务时得 optional_unavailable），报出来是噪音');
});

test('★★ 两者同源：unresolved 为空 ⇔ boot 不因依赖而拒绝（判据一致性的可观测形态）', async () => {
  // ★ 这条守的是「#orderingEdges（抛错）与 #unresolvedDependencies（返回清单）共用一份判定」。
  //   若哪天有人把其中一份改了，会出现「诊断说没问题、boot 却拒绝」—— 最难查的那种不一致。
  const cases = [
    { label: '缺失', manifests: [base('p.x', { dependencies: { 'p.ghost': '^1.0.0' } })] },
    { label: '版本不符', manifests: [base('p.dep'), base('p.x', { dependencies: { 'p.dep': '^9.0.0' } })] },
    { label: '齐备', manifests: [base('p.dep'), base('p.x', { dependencies: { 'p.dep': '^1.0.0' } })] }
  ];
  for (const { label, manifests } of cases) {
    const snap = await snapshotOf(manifests);
    const unresolved = snap.get('p.x').unresolvedDependencies;
    // 单独再跑一次，看 boot 到底拒不拒
    const host = new CordiumHost();
    for (const m of manifests) host.registerPlugin(m, { activate() {} });
    const bootError = await host.boot().then(() => null, err => err.code);
    const rejectedForDeps = bootError === 'missing_dependency' || bootError === 'dependency_version_mismatch';
    // ★ 只比【静态】那两类：`cycle` / `not_running` 是**诊断面**的事实，不参与 boot 的抛错判定
    //   （环由拓扑排序自己报；「依赖还没跑起来」根本不是错误）。
    const staticUnresolved = unresolved.filter(u => u.reason === 'missing' || u.reason === 'version_mismatch');
    assert.equal(staticUnresolved.length > 0, rejectedForDeps,
      `[${label}] 静态诊断=${JSON.stringify(staticUnresolved)}，而 boot 的结论是 ${bootError ?? '成功'} —— 两者必须一致`);
  }
});

test('★ 重构回归：拆分出纯查询后，两个错误码与【报文逐字】不变（既有调用方按它们断言）', async () => {
  const missing = new CordiumHost();
  missing.registerPlugin(base('plugin.m', { dependencies: { 'plugin.ghost': '^1.0.0' } }), { activate() {} });
  await assert.rejects(() => missing.boot(),
    err => err.code === 'missing_dependency'
      && err.message === "Missing dependency 'plugin.ghost' required by 'plugin.m'",
    '缺失依赖的码与报文必须逐字不变');

  const mismatch = new CordiumHost();
  mismatch.registerPlugin(base('plugin.d'), { activate() {} });
  mismatch.registerPlugin(base('plugin.n', { dependencies: { 'plugin.d': '^2.0.0' } }), { activate() {} });
  await assert.rejects(() => mismatch.boot(),
    err => err.code === 'dependency_version_mismatch'
      && err.message === "Version mismatch for dependency 'plugin.d': expected ^2.0.0, got 1.0.0",
    '版本不符的码与报文必须逐字不变');
});

test('★ 判别力自检：报出来的 id 必须真的是那个缺失的（不是随便一个依赖）', async () => {
  const snap = await snapshotOf([
    base('plugin.ok-dep'),
    base('plugin.multi', { dependencies: { 'plugin.ok-dep': '^1.0.0', 'plugin.absent': '^1.0.0' } })
  ]);
  const ids = snap.get('plugin.multi').unresolvedDependencies.map(d => d.id);
  assert.deepEqual(ids, ['plugin.absent'], '只该报缺席的那个；满足的 plugin.ok-dep 不得出现');
});

// ════════════════════════════════════════════════════════════════════════════
// ★★ 覆盖面扩展：诊断面不止「缺 / 版本不符」。
//    此前只有那两类 ⇒ **环依赖**与**依赖没跑起来**两种情况下，插件同样停在
//    `discovered`、`error: null`，而 `unresolvedDependencies` 是**空数组** ——
//    正是本文件开头要修的那个症状，换了个成因又回来了。
// ════════════════════════════════════════════════════════════════════════════

test('★★ 环依赖：诊断说得出 cycle（此前为空数组，而 boot 仍抛 cyclic_dependency）', async () => {
  const snap = await snapshotOf([
    base('plugin.a', { dependencies: { 'plugin.b': '^1.0.0' } }),
    base('plugin.b', { dependencies: { 'plugin.a': '^1.0.0' } })
  ]);
  assert.deepEqual(snap.get('plugin.a').unresolvedDependencies, [{ id: 'plugin.b', reason: 'cycle' }]);
  assert.deepEqual(snap.get('plugin.b').unresolvedDependencies, [{ id: 'plugin.a', reason: 'cycle' }]);
});

test('★ 环的【下游】：被上游的环挡住 ⇒ not_running（它不在环上，不该报 cycle）', async () => {
  const snap = await snapshotOf([
    base('plugin.a', { dependencies: { 'plugin.b': '^1.0.0' } }),
    base('plugin.b', { dependencies: { 'plugin.a': '^1.0.0' } }),
    base('plugin.down', { dependencies: { 'plugin.a': '^1.0.0' } })
  ]);
  assert.deepEqual(snap.get('plugin.down').unresolvedDependencies, [{ id: 'plugin.a', reason: 'not_running' }]);
});

test('★★ 依赖【没跑起来】也报：eager 依赖 lazy ⇒ not_running（此前是空数组，看不出为什么）', async () => {
  const snap = await snapshotOf([
    base('plugin.lazybase', { activation: 'lazy' }),
    base('plugin.eager', { dependencies: { 'plugin.lazybase': '^1.0.0' } })
  ]);
  assert.equal(snap.get('plugin.eager').state, LifecycleState.DISCOVERED);
  assert.deepEqual(snap.get('plugin.eager').unresolvedDependencies,
    [{ id: 'plugin.lazybase', reason: 'not_running' }],
    '★ 依赖在、版本也对，但它没跑起来 —— 这正是「它为什么没起来」的答案');
});

test('★ 正向对照：依赖真的跑起来了 ⇒ 空数组（否则上面几条可能是恒真的）', async () => {
  const snap = await snapshotOf([
    base('plugin.dep'),
    base('plugin.user', { dependencies: { 'plugin.dep': '^1.0.0' } })
  ]);
  assert.deepEqual(snap.get('plugin.user').unresolvedDependencies, []);
  assert.equal(snap.get('plugin.user').state, LifecycleState.ACTIVE);
});

test('★★ boot 之前查询不得把「还没启动」当成「跑不起来」（否则 boot 前预检全废）', async () => {
  const host = new CordiumHost();
  host.registerPlugin(base('plugin.dep'), { activate() {} });
  host.registerPlugin(base('plugin.user', { dependencies: { 'plugin.dep': '^1.0.0' } }), { activate() {} });
  const pre = host.getDiagnostics();                     // ★ 还没 boot：人人都是 discovered
  assert.equal(pre.booted, false);
  assert.deepEqual(pre.plugins.find(p => p.id === 'plugin.user').unresolvedDependencies, [],
    '★ boot 之前所有插件都是 discovered —— 那不是「跑不起来」，不该报');
});

test('★★ 用户停用坏插件 ⇒ boot 不再因它抛（`deactivatePlugin` 就是那个隔离原语）', async () => {
  const host = new CordiumHost();
  host.registerPlugin(base('plugin.good'), { activate() {} });
  host.registerPlugin(base('plugin.broken', { dependencies: { 'plugin.ghost': '^1.0.0' } }), { activate() {} });
  await host.deactivatePlugin('plugin.broken');
  await host.boot();                                     // ★ 此前会抛 missing_dependency
  const byId = id => host.getDiagnostics().plugins.find(p => p.id === id);
  assert.equal(host.getDiagnostics().booted, true);
  assert.equal(byId('plugin.good').state, LifecycleState.ACTIVE);
  assert.equal(byId('plugin.broken').state, LifecycleState.DISABLED,
    '★ 被显式停用的插件必须显示 disabled —— 显示 discovered 的话，与「等着启动」无法区分');
  assert.deepEqual(byId('plugin.broken').unresolvedDependencies, [{ id: 'plugin.ghost', reason: 'missing' }],
    '★ 停用不等于把事实抹掉：它为什么起不来，快照里仍要说得出');
});

// ═══════ 导出面：reason 取值集合（消费方提请后落地） ═══════
//
// 动机：消费方要「知道自己认全了没有」，而此前 `reason` 是**纯字面量、没导出** ——
//   只能跨仓读实现或暴力探测，两条路都不干净。同类的 LifecycleState / PluginKind 早就导出了。

test('★★ 实际产出的 reason 必须全部落在【导出的取值集合】里，且四类都真的产得出', async () => {
  // ★ 规矩 45：不能只断言 `Object.values(UnresolvedReason)` 等于一张手写列表 —— 那是拿导出物验导出物。
  //   这里【真的构造出四类场景】，收集实际产出，再与导出集合比。
  //
  // ★ 四类必须【分场景】跑，不能塞进同一个宿主：`cycle` 会让 `boot()` 直接抛错，
  //   而 `not_running` 依赖启动后的状态 ⇒ 混在一起时它根本不产出（实测：混跑只得到三类）。
  const scenarios = [
    [base('plugin.needs-ghost', { dependencies: { 'plugin.ghost': '^1.0.0' } })],            // missing
    [base('plugin.dep'), base('plugin.needs-newer', { dependencies: { 'plugin.dep': '^2.0.0' } })], // version_mismatch
    [base('plugin.cyc-a', { dependencies: { 'plugin.cyc-b': '^1.0.0' } }),
     base('plugin.cyc-b', { dependencies: { 'plugin.cyc-a': '^1.0.0' } })],                   // cycle
    [base('plugin.lazybase', { activation: 'lazy' }),
     base('plugin.eager', { dependencies: { 'plugin.lazybase': '^1.0.0' } })]                 // not_running
  ];

  const produced = new Set();
  for (const manifests of scenarios) {
    const snap = await snapshotOf(manifests);
    for (const p of snap.values()) for (const u of p.unresolvedDependencies ?? []) produced.add(u.reason);
  }

  // ① 产出 ⊆ 导出，且【四类都要真的产得出】—— 否则「都在集合里」可能只是因为只产出了一类
  assert.deepEqual([...produced].sort(), [...UNRESOLVED_REASON_VALUES].sort(),
    '★ 四类 reason 必须都能被真实场景产出，且产出集合与导出集合一致');

  // ② 覆盖正向：导出集合里的每一个值都确实出现过（防导出物列了一个永远不会发生的值）
  for (const v of UNRESOLVED_REASON_VALUES) {
    assert.ok(produced.has(v), `★ 导出的 '${v}' 从未被任何场景产出 ⇒ 它是空头承诺`);
  }
});

test('★ 导出物是冻结的，且值集由对象【派生】（不是另抄一份）', () => {
  assert.ok(Object.isFrozen(UnresolvedReason), 'UnresolvedReason 必须冻结');
  assert.ok(Object.isFrozen(UNRESOLVED_REASON_VALUES), 'UNRESOLVED_REASON_VALUES 必须冻结');
  // ★ 值集由对象【派生】⇒ 二者不可能各说各话（这是「不造第二真相源」的机械保证）
  assert.deepEqual([...UNRESOLVED_REASON_VALUES], Object.values(UnresolvedReason));
  // ⚠️ 本用例**不**证明「`host.mjs` 用的是这个常量」—— 那件事由上面那条
  //   「产出集合 == 导出集合」兜住：实现若在 `host.mjs` 里新写一个字面量，
  //   产出集合就会多出一个值，那条当场变红。（两处措辞不同，别把这条说成在验实现。）
});
