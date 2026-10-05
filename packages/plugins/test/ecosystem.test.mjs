// ecosystem：依赖解析与超时工具。
// 「全仓插件权限必须落在白名单内」属上层应用的仓库级门禁；能力词表不在 cordium 里（见 ecosystem.mjs 顶部说明）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePluginDependencies, callWithTimeout, normalizeDependencies } from '../src/ecosystem.mjs';

test('resolvePluginDependencies 按拓扑序返回（依赖先于被依赖者）', () => {
  const order = resolvePluginDependencies([
    { id: 'plugin-c', name: 'Plugin C', version: '1.0.0', dependencies: { 'plugin-b': '*' } },
    { id: 'plugin-a', name: 'Plugin A', version: '1.0.0', dependencies: {} },
    { id: 'plugin-b', name: 'Plugin B', version: '1.0.0', dependencies: { 'plugin-a': '*' } }
  ]).map(m => m.id);
  assert.equal(order.length, 3);
  assert.ok(order.indexOf('plugin-a') < order.indexOf('plugin-b'));
  assert.ok(order.indexOf('plugin-b') < order.indexOf('plugin-c'));
});

test('resolvePluginDependencies 检出循环依赖', () => {
  assert.throws(() => resolvePluginDependencies([
    { id: 'cycle-1', name: 'Cycle 1', version: '1.0.0', dependencies: { 'cycle-2': '*' } },
    { id: 'cycle-2', name: 'Cycle 2', version: '1.0.0', dependencies: { 'cycle-1': '*' } }
  ]), err => err.code === 'cyclic_dependency');
});

test('resolvePluginDependencies 检出缺失依赖与版本不满足', () => {
  assert.throws(() => resolvePluginDependencies([
    { id: 'lonely', name: 'L', version: '1.0.0', dependencies: { 'ghost': '*' } }
  ]), err => err.code === 'missing_dependency');
  assert.throws(() => resolvePluginDependencies([
    { id: 'base', name: 'B', version: '1.0.0' },
    { id: 'needs-two', name: 'N', version: '1.0.0', dependencies: { base: '^2.0.0' } }
  ]), err => err.code === 'dependency_version_mismatch');
});

test('resolvePluginDependencies 拒绝候选批次内重复 ID', () => {
  assert.throws(() => resolvePluginDependencies([
    { id: 'dup', name: 'D', version: '1.0.0' },
    { id: 'dup', name: 'D', version: '1.0.0' }
  ]), err => err.code === 'duplicate_plugin');
});

// ★ 补齐「与已装 registry 冲突」两条分支：此前无任何用例 —— 把版本冲突判定改成恒假，全量照样全绿。
test('resolvePluginDependencies：候选与已装 registry 同 id 冲突 ⇒ version_conflict / implementation_conflict', () => {
  const installed = new Map([['p', { manifest: { id: 'p', name: 'P', version: '1.0.0', apiVersion: '1.0.0', permissions: ['x'], implementationId: 'impl.a' } }]]);
  assert.throws(
    () => resolvePluginDependencies([{ id: 'p', name: 'P', version: '1.1.0' }], { existingRegistry: installed }),
    err => err.code === 'version_conflict' && err.pluginId === 'p'
  );
  // 同版本但权限不同 ⇒ implementation_conflict
  // ⚠️ 不用 implementationId 构造：validatePluginManifest 的白名单不保留该字段，
  //   ecosystem 里 implementationId 那一支当前不可达（待定）。
  assert.throws(
    () => resolvePluginDependencies([{ id: 'p', name: 'P', version: '1.0.0', permissions: ['y'] }], { existingRegistry: installed }),
    err => err.code === 'implementation_conflict' && err.pluginId === 'p'
  );
  // 正向对照：同版本、同描述 ⇒ 放行（否则上两条可能是「一律拒绝」伪装成判别）
  assert.doesNotThrow(() => resolvePluginDependencies(
    [{ id: 'p', name: 'P', version: '1.0.0', permissions: ['x'] }], { existingRegistry: installed }));
});

test('normalizeDependencies：只收对象形式（数组写法已取消），非对象输入 fail-loud', () => {
  // 数组项写不下版本范围 ⇒ 一律拒，而不是「归一成 *」把约束悄悄吞掉
  assert.deepEqual(normalizeDependencies({ a: '^1.0.0' }), { a: '^1.0.0' });
  assert.throws(() => normalizeDependencies(['a', 'b']), err => err.code === 'invalid_manifest' && /got an array/.test(err.message));
  assert.throws(() => normalizeDependencies('a'), err => err.code === 'invalid_dependencies');
});

test('callWithTimeout 超时即中止并抛 call_timeout', async () => {
  const hanging = () => new Promise(resolve => setTimeout(() => resolve('done'), 500));
  await assert.rejects(
    () => callWithTimeout(hanging, [], { timeoutMs: 50, pluginId: 'slow-plugin' }),
    err => err.code === 'call_timeout' && err.message.includes('timed out')
  );
});

test('★ 边界钉：callWithTimeout 拦不住【同步】阻塞 —— 同步函数跑完才轮到计时器，结果照常返回', async () => {
  // 这不是期望的行为，而是【如实钉住】的限制：超时只对异步等待有效（见 callWithTimeout 的 JSDoc）。
  // 若将来改用 worker_threads 真正打断同步阻塞，本测试会变红 —— 届时改写断言并同步文档。
  const busy = () => { const end = Date.now() + 80; while (Date.now() < end) { /* 占住事件循环 */ } return 'finished'; };
  const started = Date.now();
  const result = await callWithTimeout(busy, [], { timeoutMs: 10, pluginId: 'sync-hog' });
  assert.equal(result, 'finished', '同步函数不会被 10ms 超时打断');
  assert.ok(Date.now() - started >= 80, '调用方被阻塞了整段同步执行时间');
});
