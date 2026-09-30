// catalog：插件元数据索引的导入导出、降级保护与字段剥除。
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { createPluginCatalog } from '../src/catalog.mjs';

test('catalog 导入/导出/解析 manifest，且不执行插件代码', () => {
  const catalog = createPluginCatalog();
  catalog.add({ id: 'rules.sample', name: '示例规则', version: '1.0.0', provides: ['rules.validate'], source: 'local' });
  const restored = createPluginCatalog();
  restored.importIndex(catalog.exportIndex());
  assert.equal(restored.resolve('rules.sample').manifest.name, '示例规则');
  assert.equal(restored.list().length, 1);
});

test('catalog 拒绝降级', () => {
  const catalog = createPluginCatalog();
  catalog.add({ id: 'provider.test', name: '测试', version: '2.0.0' });
  assert.throws(() => catalog.add({ id: 'provider.test', name: '测试', version: '1.0.0' }), hasCode('version_conflict'));
});

test('catalog：正式版排在预发布版之后', () => {
  const catalog = createPluginCatalog();
  catalog.add({ id: 'provider.test', name: '测试', version: '1.0.0-beta.2' });
  catalog.add({ id: 'provider.test', name: '测试', version: '1.0.0' });
  assert.throws(() => catalog.add({ id: 'provider.test', name: '测试', version: '1.0.0-beta.3' }), hasCode('version_conflict'));
});

test('catalog 条目字段（source / packageUrl）进 manifest 校验前剥掉，不被报成丢弃字段', () => {
  const seen = [];
  const catalog = createPluginCatalog({ onDiagnostic: d => seen.push(d) });
  catalog.add({ id: 'plugin.src', name: 'S', version: '1.0.0', source: 'local', packageUrl: 'file:///x' });
  assert.deepEqual(seen, [], '条目字段不是 manifest 字段，不得出现在丢字段诊断里');
});
