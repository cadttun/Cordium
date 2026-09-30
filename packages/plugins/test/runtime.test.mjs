// runtime：描述符层 manifest 校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { validatePluginManifest } from '../src/runtime.mjs';

test('manifest 校验：id 格式与 API 版本兼容性', () => {
  assert.equal(validatePluginManifest({ id: 'demo.plugin', name: 'Demo', version: '1.0.0' }).id, 'demo.plugin');
  assert.throws(() => validatePluginManifest({ id: 'Demo', name: 'Demo', version: '1.0.0' }), hasCode('invalid_manifest'));
  assert.throws(() => validatePluginManifest({ id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: '2.0.0' }), hasCode('invalid_manifest'));
});

test('★ manifest 校验：name 必须是非空字符串（不把 123 / true / {} 转成字符串收下）', () => {
  for (const name of [undefined, null, '', '   ', 123, true, {}, ['Demo']]) {
    assert.throws(() => validatePluginManifest({ id: 'demo', name, version: '1.0.0' }), hasCode('invalid_manifest'), JSON.stringify(name));
  }
  assert.equal(validatePluginManifest({ id: 'demo', name: '  Demo ', version: '1.0.0' }).name, 'Demo');
});

test('manifest 校验：拒绝带前导零的版本号（SemVer §2）', () => {
  assert.throws(() => validatePluginManifest({ id: 'demo', name: 'Demo', version: '01.0.0' }));
});

test('★ 插件层 API 版本与内核契约版本同一（派生，不可漂移）', async () => {
  const { PLUGIN_API_VERSION } = await import('../src/runtime.mjs');
  const { KERNEL_API_VERSION } = await import('@cordium/kernel');
  assert.equal(PLUGIN_API_VERSION, KERNEL_API_VERSION);
});
