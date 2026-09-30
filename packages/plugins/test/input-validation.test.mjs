/**
 * @file packages/plugins/test/input-validation.test.mjs
 * @description plugins 各公开入口：选项传 null 视同不传；错类型给带码的 CordiumError。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, CordiumError } from '@cordium/kernel';
import { validatePluginManifest } from '@cordium/plugins/runtime';
import { resolvePluginDependencies, callWithTimeout } from '@cordium/plugins/ecosystem';
import { createPluginCatalog } from '@cordium/plugins/catalog';
import { loadPlugins } from '@cordium/plugins/loader';
import { callIsolated } from '@cordium/plugins/isolation';

const M = { id: 'plugin.a', name: 'A', version: '1.0.0' };

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
