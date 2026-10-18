/**
 * 预览面（`@cordium/plugins/testing`）的门禁 —— 与内核侧同档同判据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as testingApi from '../src/testing.mjs';
import * as runtimeApi from '../src/runtime.mjs';
import { validatePluginManifest } from '../src/runtime.mjs';
import { loadPlugins } from '../src/loader.mjs';

test('★ 夹具符号不得出现在任何稳定子入口（否则它悄悄变成了稳定承诺）', () => {
  const stable = { ...runtimeApi };
  const leak = Object.keys(testingApi).filter(name => name in stable);
  assert.deepEqual(leak, [], '\n预览面泄漏：\n' + leak.join('\n'));
});

test('★ makePluginManifest 造出来的清单必须真的过 validatePluginManifest', () => {
  const manifest = testingApi.makePluginManifest({ id: 'plug.fixture' });
  assert.doesNotThrow(() => validatePluginManifest(manifest));
  // ★ 判别性：手写一份漏 name 的清单会被拒（证明校验真的在跑，不是恒真）
  const { name, ...noName } = manifest;
  assert.throws(() => validatePluginManifest(noName), /name/i);
});

test('★ writePluginModule 写出的是【真的能被加载器接受】的文件', async () => {
  const { CordiumHost } = await import('@cordium/kernel');
  const mod = testingApi.writePluginModule(testingApi.makePluginManifest({ id: 'plug.on-disk' }));
  try {
    const host = new CordiumHost();
    const loaded = await loadPlugins(host, [{ module: mod.path }]);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'plug.on-disk');
    await host.boot();
    assert.equal(host.getDiagnostics().plugins[0].state, 'active', '★ 夹具写出的文件必须真的能起起来');
  } finally {
    mod.cleanup();
  }
});

test('★ writePluginModule 的临时目录并发安全 + cleanup 真的清掉', async () => {
  const a = testingApi.writePluginModule(testingApi.makePluginManifest({ id: 'plug.a' }));
  const b = testingApi.writePluginModule(testingApi.makePluginManifest({ id: 'plug.b' }));
  try {
    assert.notEqual(a.dir, b.dir, '两次调用必须落在不同目录（并发用例不撞名）');
    assert.notEqual(a.path, b.path);
    const fs = await import('node:fs');
    assert.ok(fs.existsSync(a.path) && fs.existsSync(b.path));
  } finally {
    a.cleanup();
    b.cleanup();
  }
  const fs = await import('node:fs');
  assert.equal(fs.existsSync(a.dir), false, 'cleanup 必须真的删掉目录');
});

test('★ makePlugin 造的是「清单 + 实现」一对，且默认钩子可调用', async () => {
  const { manifest, entry } = testingApi.makePlugin({ id: 'plug.pair' });
  assert.doesNotThrow(() => validatePluginManifest(manifest));
  assert.equal(typeof entry.activate, 'function');
  assert.equal(typeof entry.deactivate, 'function');
  assert.equal(await entry.activate(), undefined, '默认 activate 是空实现');
});

test('★ 缺 id ⇒ 立刻报错（与内核侧同一口径）', () => {
  assert.throws(() => testingApi.makePluginManifest({}), /non-empty string `id`/);
  assert.throws(() => testingApi.makePlugin({ id: '' }), /non-empty string `id`/);
});
