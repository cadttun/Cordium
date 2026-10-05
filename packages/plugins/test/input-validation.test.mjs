/**
 * @file packages/plugins/test/input-validation.test.mjs
 * @description plugins 各公开入口：选项传 null 视同不传；错类型给带码的 CordiumError。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CordiumHost, CordiumError } from '@cordium/kernel';
import { validatePluginManifest } from '@cordium/plugins/runtime';
import { resolvePluginDependencies, callWithTimeout } from '@cordium/plugins/ecosystem';
import { createPluginCatalog } from '@cordium/plugins/catalog';
import { loadPlugins } from '@cordium/plugins/loader';
import { callIsolated } from '@cordium/plugins/isolation';
import { reloadPlugin, watchPlugins } from '@cordium/plugins/reload';

const M = { id: 'plugin.a', name: 'A', version: '1.0.0' };
const TARGET = fileURLToPath(new URL('./fixtures/isolated/targets.mjs', import.meta.url));

test('选项对象传 null ⇒ 视同不传（此前解构 null 抛 TypeError）', async () => {
  assert.equal(validatePluginManifest(M, null).id, 'plugin.a');
  assert.deepEqual(resolvePluginDependencies([], null), []);
  assert.equal(await callWithTimeout(() => 7, [], null), 7);
  assert.equal(typeof createPluginCatalog(null).add, 'function');
  assert.deepEqual(await loadPlugins(new CordiumHost(), [], null), []);
  // callIsolated：null 选项走默认值，随后因模块不存在而失败 —— 失败也必须是带码的
  await assert.rejects(callIsolated('/definitely/missing.mjs', 'default', [], null), CordiumError);
});

test('resolvePluginDependencies：manifests 非数组 ⇒ invalid_argument（此前 "is not iterable"）', () => {
  for (const bad of [null, 0, {}, 'x', Object.create(null)]) {
    assert.throws(() => resolvePluginDependencies(bad), err => err instanceof CordiumError && err.code === 'invalid_argument');
  }
});

test('模块位置为无原型对象 ⇒ invalid_argument（报文渲染不再抛 TypeError）', async () => {
  await assert.rejects(callIsolated(Object.create(null)), err => err instanceof CordiumError && err.code === 'invalid_argument');
  await assert.rejects(loadPlugins(new CordiumHost(), [{ module: Object.create(null) }]),
    err => err instanceof CordiumError && err.code === 'invalid_argument');
});

test('★ 选项传字符串 / 数组 / 数字 ⇒ 带码拒绝（此前静默展开，所有选项落回默认值）', async () => {
  for (const bad of ['abc', [1], 5]) {
    assert.throws(() => validatePluginManifest(M, bad), err => err instanceof CordiumError && err.code === 'invalid_argument');
    assert.throws(() => resolvePluginDependencies([], bad), err => err instanceof CordiumError && err.code === 'invalid_argument');
    assert.throws(() => createPluginCatalog(bad), err => err instanceof CordiumError && err.code === 'invalid_argument');
    await assert.rejects(callWithTimeout(() => 1, [], bad), err => err instanceof CordiumError && err.code === 'invalid_argument');
    await assert.rejects(loadPlugins(new CordiumHost(), [], bad), err => err instanceof CordiumError && err.code === 'invalid_argument');
    await assert.rejects(callIsolated('/x.mjs', 'default', [], bad), err => err instanceof CordiumError && err.code === 'invalid_argument');
    assert.throws(() => new CordiumHost(bad), err => err instanceof CordiumError && err.code === 'invalid_option');
    assert.throws(() => new CordiumHost().declareServiceContract('svc.x', bad), err => err instanceof CordiumError && err.code === 'invalid_contract');
  }
});

test('★ 未知选项名一律拒，且正经选项名仍收下 —— 负向断言必须配正向对照', async () => {
  // 此前各入口对未知键【静默忽略】：`apiVersion` 拼成 `apiVersio`、`maxMemoryMb` 拼成
  // `maxMemoryMB`，调用照常成功、却悄悄用了默认值 —— 声明没生效且零报错。
  // 依据：RFC 9413《Maintaining Robust Protocols》已推翻「宽进」的鲁棒性原则，
  // 并点名对早期实现尤其有害 —— 现在容忍下来的写法会被后来的调用方照着抄。
  //
  // ★ 正向对照不是凑数：`allow` 缺省为空数组（fail-closed），若某入口忘了声明允许键，
  //   「拒绝一切」也能让负向断言通过 —— 只有正向对照能把它抓出来。
  const isNotOptionError = err => !(err instanceof CordiumError && /unknown option/.test(err.message));

  const cases = [
    ['CordiumHost 构造', () => new CordiumHost({ hostVersio: '1.0.0' }), () => new CordiumHost({ hostVersion: '1.0.0' })],
    ['validatePluginManifest', () => validatePluginManifest(M, { apiVersio: '1.0.0' }), () => validatePluginManifest(M, { apiVersion: '1.0.0' })],
    ['resolvePluginDependencies', () => resolvePluginDependencies([], { existingRegistr: null }), () => resolvePluginDependencies([], { existingRegistry: null })],
    ['createPluginCatalog', () => createPluginCatalog({ onDiagnostik: () => {} }), () => createPluginCatalog({ onDiagnostic: () => {} })],
    ['callWithTimeout', () => callWithTimeout(() => 1, [], { timeoutMS: 5 }), () => callWithTimeout(() => 1, [], { timeoutMs: 5 })],
    ['loadPlugins', () => loadPlugins(new CordiumHost(), [], { importModul: () => {} }), () => loadPlugins(new CordiumHost(), [], { importModule: () => {} })],
    ['reloadPlugin', () => reloadPlugin(new CordiumHost(), 'plugin.missing', { forcee: true }), () => reloadPlugin(new CordiumHost(), 'plugin.missing', { force: true })],
    ['watchPlugins', () => watchPlugins(new CordiumHost(), [], { debounceMS: 5 }), () => { const w = watchPlugins(new CordiumHost(), [], { debounceMs: 5 }); w.close(); }],
    ['callIsolated', () => callIsolated(TARGET, 'add', [1, 2], { maxMemoryMB: 64 }), () => callIsolated(TARGET, 'add', [1, 2], { maxMemoryMb: 64 })]
  ];

  for (const [label, bad, good] of cases) {
    await assert.rejects(async () => bad(),
      err => err instanceof CordiumError && /unknown option/.test(err.message),
      `${label}：拼错的选项名必须被拒`);
    // 正向：正经选项名必须过得了选项校验（后续可能因别的理由失败 —— 那不算数）
    try { await good(); }
    catch (err) {
      assert.ok(isNotOptionError(err), `${label}：正经选项名不该被选项校验拦下，实得「${err.message}」`);
    }
  }
});
