/**
 * @file packages/plugins/test/manifest-diagnostics.test.mjs
 * @description 插件层白名单重建丢字段时必须可见（此前 catalog / ecosystem 静默丢，且丢失会被写进索引）。
 *
 * ★ 诊断形状与内核 `diffManifestFields` 同一份（path = 'plugin'），可直接交给 `host.recordManifestDiagnostic`。
 * ★ `validatePluginManifest` 的返回形状不动（已定稿）；新增 `validatePluginManifestDetailed` 是纯增量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost } from '@cordium/kernel';
import { validatePluginManifest, validatePluginManifestDetailed } from '../src/runtime.mjs';
import { createPluginCatalog } from '../src/catalog.mjs';
import { resolvePluginDependencies } from '../src/ecosystem.mjs';

const base = { id: 'demo.plugin', name: 'Demo', version: '1.0.0', apiVersion: '1.0.0' };

test('Detailed：丢字段 ⇒ 给出诊断；未知字段 warn、另一层字段 info', () => {
  const { manifest, diagnostic } = validatePluginManifestDetailed({ ...base, typo: 1, displayName: 'D' });
  assert.deepEqual(manifest, validatePluginManifest({ ...base, typo: 1, displayName: 'D' }), '★ manifest 与原入口逐字一致');
  assert.equal(diagnostic.path, 'plugin');
  assert.equal(diagnostic.pluginId, 'demo.plugin');
  assert.deepEqual(diagnostic.unknownFields, ['typo']);
  assert.deepEqual(diagnostic.crossLayerFields, ['displayName']);
  assert.equal(diagnostic.severity, 'warn');
});

test('Detailed：不丢字段 ⇒ diagnostic 为 null（空结果也要覆盖）', () => {
  assert.equal(validatePluginManifestDetailed(base).diagnostic, null);
});

test('catalog：add 丢字段 ⇒ onDiagnostic 收到；干净 manifest 不触发', () => {
  const seen = [];
  const catalog = createPluginCatalog({ onDiagnostic: d => seen.push(d) });
  catalog.add(base);
  assert.equal(seen.length, 0);
  catalog.add({ ...base, version: '1.1.0', implementationId: 'x' });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].unknownFields, ['implementationId']);
});

test('catalog：importIndex 路径同样上报（丢失在写进索引之前可见）', () => {
  const seen = [];
  const catalog = createPluginCatalog({ onDiagnostic: d => seen.push(d) });
  const raw = JSON.stringify({ schemaVersion: 'plugin-catalog/v1', apiVersion: '1.0.0',
    entries: [{ manifest: { ...base, extra: true }, source: 'local', packageUrl: null }] });
  catalog.importIndex(raw);
  assert.deepEqual(seen.map(d => d.unknownFields), [['extra']]);
});

test('catalog：onDiagnostic 须是函数', () => {
  assert.throws(() => createPluginCatalog({ onDiagnostic: 'nope' }), err => err.code === 'invalid_argument');
});

test('ecosystem：resolvePluginDependencies 丢字段 ⇒ onDiagnostic 收到', () => {
  const seen = [];
  resolvePluginDependencies([{ ...base, optionalDependencies: {} }], { onDiagnostic: d => seen.push(d) });
  assert.deepEqual(seen.map(d => d.crossLayerFields), [['optionalDependencies']]);
  assert.throws(() => resolvePluginDependencies([base], { onDiagnostic: 1 }), err => err.code === 'invalid_argument');
});

test('诊断可直接交给宿主 sink（同一形状）', () => {
  const host = new CordiumHost();
  const catalog = createPluginCatalog({ onDiagnostic: d => host.recordManifestDiagnostic(d) });
  catalog.add({ ...base, typo: 1 });
  const diags = host.getDiagnostics().manifestDiagnostics;
  assert.ok(diags.some(d => d.path === 'plugin' && d.pluginId === 'demo.plugin' && d.fields.includes('typo')),
    JSON.stringify(diags));
});

test('catalog：importIndex 失败（原子回滚）⇒ 不上报诊断', () => {
  const seen = [];
  const catalog = createPluginCatalog({ onDiagnostic: d => seen.push(d) });
  const raw = JSON.stringify({ schemaVersion: 'plugin-catalog/v1', apiVersion: '1.0.0',
    entries: [{ manifest: { ...base, extra: true } }, { manifest: { id: 'BAD' } }] });
  assert.throws(() => catalog.importIndex(raw));
  assert.deepEqual(seen, [], '导入被整体拒绝 ⇒ 那批条目没落地，不得报丢字段');
  assert.equal(catalog.list().length, 0);
});

test('catalog：平铺写法里的 source / packageUrl 是 catalog 条目字段，不得误报为丢字段', () => {
  const seen = [];
  const catalog = createPluginCatalog({ onDiagnostic: d => seen.push(d) });
  catalog.add({ ...base, source: 'local', packageUrl: 'file:///x.tgz' });
  assert.deepEqual(seen, []);
  assert.equal(catalog.resolve('demo.plugin').source, 'local');
});
