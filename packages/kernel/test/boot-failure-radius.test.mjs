/**
 * ★★ 同一个 manifest 错误，在【静态装配期】与【动态加载期】的爆炸半径**不同** —— 这是有意的设计。
 *
 * ── 两个世界 ────────────────────────────────────────────────────────
 *   静态装配期（`boot()` 之前登记的那批）：**原子**。
 *     任一插件的必需依赖不满足（缺失 / 版本不符）⇒ `boot()` 在**激活任何插件之前**就抛错，
 *     宿主停在 `booted === false`，**所有**插件（含依赖齐备的健康插件）保持 `discovered`。
 *     ⇒ 不存在「半启动」：要么整份清单起来，要么一个都不起。
 *
 *   动态加载期（`boot()` 之后再登记 / 激活的）：**隔离**。
 *     同样的 manifest 错误只让那一个插件进 `failed`，宿主仍 `booted === true`，
 *     已经跑起来的插件不受任何影响。
 *
 * ── 为什么两个世界不同 ──────────────────────────────────────────────
 *   静态期那份清单是装配方**自己写的**（内置插件、写死的路径），依赖写错是装配错误，
 *   启动时就响亮地暴露最省事；动态期的插件来自外部，一个外来 manifest 打错字
 *   不该把已经跑起来的宿主整个拖垮。
 *
 * ── 为什么这条测试必须【两侧一起】断言 ──────────────────────────────
 *   只测一侧的话判据是恒真的：
 *     · 把静态期也改成「隔离」，静态侧那条仍绿；
 *     · 把动态期也改成「拖垮宿主」，动态侧那条仍绿。
 *   ⇒ 必须**同一个坏 manifest 跑两处、断言爆炸半径不同**，才真的把这份设计钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, LifecycleState } from '../src/index.mjs';

const HEALTHY = { id: 'plugin.healthy', version: '1.0.0', apiVersion: '1.0.0' };
/** 依赖一个根本不存在的 id —— 静态期与动态期用的是**同一份** manifest */
const BROKEN = { id: 'plugin.broken', version: '1.0.0', apiVersion: '1.0.0', dependencies: { 'plugin.nowhere': '^1.0.0' } };

const entry = { activate() {} };
const stateOf = (host, id) => host.getDiagnostics().plugins.find(p => p.id === id)?.state;

test('★ 静态装配期：坏依赖 ⇒ boot 拒绝，且【健康插件也没起来】（原子：要么全起，要么全不起）', async () => {
  const host = new CordiumHost();
  host.registerPlugin(HEALTHY, entry);
  host.registerPlugin(BROKEN, entry);

  await assert.rejects(() => host.boot(), (err) => err.code === 'missing_dependency');
  const diag = host.getDiagnostics();
  assert.equal(diag.booted, false);
  // ★ 这一条是「原子」的判据：依赖齐备的插件**同样**不得启动
  assert.equal(stateOf(host, 'plugin.healthy'), LifecycleState.DISCOVERED,
    '静态期一个插件起不来，整份清单都不起 —— 健康插件不得单独上线');
  assert.equal(stateOf(host, 'plugin.broken'), LifecycleState.DISCOVERED,
    '拒绝发生在激活之前，所以失败者停在 discovered，而不是 failed（它压根没跑过）');
});

test('★ 动态加载期：同一份坏 manifest ⇒ 只有它 failed，宿主照常运行', async () => {
  const host = new CordiumHost();
  host.registerPlugin(HEALTHY, entry);
  await host.boot();
  assert.equal(host.getDiagnostics().booted, true);

  host.registerPlugin(BROKEN, entry);
  await assert.rejects(() => host.activatePlugin('plugin.broken'), (err) => err.code === 'missing_dependency');

  const diag = host.getDiagnostics();
  assert.equal(diag.booted, true, '宿主不得被一个外来插件拖垮');
  assert.equal(stateOf(host, 'plugin.healthy'), LifecycleState.ACTIVE, '已跑起来的插件不受影响');
  assert.equal(stateOf(host, 'plugin.broken'), LifecycleState.FAILED);
});

// ★★ 观察向量必须含【错误通道】，不只是状态字段。
//   实测缺口：把静态预检条件从 `> 0` 改成 `> 999` 后，静态侧改以 `TypeError`（无码）崩，
//   但它的 `booted` / `healthy` / **连 `broken`** 都仍等于「原子拒绝」的期望值 ⇒
//   只补 `broken` 的版本**依然全绿**（对 `{booted,healthy,broken}` 这个向量，该变异是**观察等价**的）。
//   只有把「拒绝走的是哪条通道（`err.code`）」纳入观察，才杀得死它。
//   ⇒ 这正是「存活变异体 = 缺失的断言」：加宽观察向量，而不是只堆状态字段。
const codeOf = async fn => { try { await fn(); return null; } catch (err) { return err.code; } };
const radiusOf = host => ({
  booted: host.getDiagnostics().booted,
  healthy: stateOf(host, 'plugin.healthy'),
  broken: stateOf(host, 'plugin.broken')
});

test('★★ 判据本身：同一份坏 manifest，两处的爆炸半径（含错误通道）必须【不同】', async () => {
  const staticHost = new CordiumHost();
  staticHost.registerPlugin(HEALTHY, entry);
  staticHost.registerPlugin(BROKEN, entry);
  const staticCode = await codeOf(() => staticHost.boot());

  const dynamicHost = new CordiumHost();
  dynamicHost.registerPlugin(HEALTHY, entry);
  await dynamicHost.boot();
  dynamicHost.registerPlugin(BROKEN, entry);
  const dynamicCode = await codeOf(() => dynamicHost.activatePlugin('plugin.broken'));

  // ★ 正反两侧都【逐字段点名】—— 只说「不同」的话，靠别的原因凑出不同也能过
  assert.deepEqual({ ...radiusOf(staticHost), code: staticCode },
    { booted: false, healthy: LifecycleState.DISCOVERED, broken: LifecycleState.DISCOVERED, code: 'missing_dependency' },
    '静态侧必须【以 missing_dependency 拒绝】，而不是以别的错崩掉');
  assert.deepEqual({ ...radiusOf(dynamicHost), code: dynamicCode },
    { booted: true, healthy: LifecycleState.ACTIVE, broken: LifecycleState.FAILED, code: 'missing_dependency' },
    '动态侧必须【以 missing_dependency 拒绝】，且只有它自己 failed');
  assert.notDeepEqual(radiusOf(staticHost), radiusOf(dynamicHost),
    '两侧爆炸半径若变得相同，说明有人把其中一个世界改成了另一个的语义');
});

test('★ 门禁自检：radius 每个字段都取到了值，且两侧在【每一个】字段上都不同', async () => {
  const staticHost = new CordiumHost();
  staticHost.registerPlugin(HEALTHY, entry);
  staticHost.registerPlugin(BROKEN, entry);
  await staticHost.boot().catch(() => {});

  const dynamicHost = new CordiumHost();
  dynamicHost.registerPlugin(HEALTHY, entry);
  await dynamicHost.boot();
  dynamicHost.registerPlugin(BROKEN, entry);
  await dynamicHost.activatePlugin('plugin.broken').catch(() => {});

  const a = radiusOf(staticHost);
  const b = radiusOf(dynamicHost);
  for (const [k, v] of Object.entries(a)) assert.notEqual(v, undefined, `静态侧 ${k} 取不到值 —— 判据退化`);
  for (const [k, v] of Object.entries(b)) assert.notEqual(v, undefined, `动态侧 ${k} 取不到值 —— 判据退化`);
  for (const k of ['booted', 'healthy', 'broken']) {
    assert.notDeepEqual(a[k], b[k], `字段 ${k} 两侧相同 ⇒ 它没有参与判别，判据被削弱`);
  }
});

test('★ 装配方要自己决定隔离谁：boot 前一次拿到【全部】未满足依赖，摘掉后 boot 成功', async () => {
  const host = new CordiumHost();
  host.registerPlugin(HEALTHY, entry);
  host.registerPlugin({ ...BROKEN, id: 'plugin.broken-a', dependencies: { 'plugin.ghost-a': '^1.0.0' } }, entry);
  host.registerPlugin({ ...BROKEN, id: 'plugin.broken-b', dependencies: { 'plugin.ghost-b': '^1.0.0' } }, entry);

  // ★ boot 之前是纯查询、零副作用 —— 而且一次给全，不像 boot 自己那样只报碰到的第一个
  const pre = host.getDiagnostics();
  assert.equal(pre.booted, false);
  assert.equal(stateOf(host, 'plugin.healthy'), LifecycleState.DISCOVERED, '查询不得有任何副作用');
  const guilty = pre.plugins.filter(p => p.unresolvedDependencies.length > 0).map(p => p.id);
  assert.deepEqual(guilty, ['plugin.broken-a', 'plugin.broken-b'], '一次列出全部有问题的插件');

  for (const id of guilty) await host.unregisterPlugin(id);
  await host.boot();
  assert.equal(host.getDiagnostics().booted, true);
  assert.equal(stateOf(host, 'plugin.healthy'), LifecycleState.ACTIVE);
});

test('★ 摘不动的情况：坏插件有必需依赖方 ⇒ unregisterPlugin 拒绝，须从叶子往上摘', async () => {
  const host = new CordiumHost();
  host.registerPlugin(HEALTHY, entry);
  host.registerPlugin(BROKEN, entry);
  host.registerPlugin({ id: 'plugin.leaf', version: '1.0.0', apiVersion: '1.0.0', dependencies: { 'plugin.broken': '^1.0.0' } }, entry);

  // ★ 包一层 `async` 不是为了好看：`unregisterPlugin` 的**入口**拒绝是同步抛出，
  //   而 `assert.rejects(() => 同步抛)` 接不住 —— 那个错误会**原样逃逸**并让测试以它判失败
  //   （不是断言失败，看不出「本来想断言什么」）。包一层 async 把同步抛转成拒绝，
  //   正好对应源码注释里说的两条错误通道（入口同步抛 / 排队后 Promise 拒绝）。
  await assert.rejects(async () => host.unregisterPlugin('plugin.broken'),
    (err) => err.code === 'plugin_has_dependents',
    '有必需依赖方时必须拒绝 —— 否则会留下取不到服务的活插件');
  // 先摘叶子，再摘它
  await host.unregisterPlugin('plugin.leaf');
  await host.unregisterPlugin('plugin.broken');
  await host.boot();
  assert.equal(host.getDiagnostics().booted, true);
});
