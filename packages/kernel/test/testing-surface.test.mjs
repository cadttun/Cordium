/**
 * 预览面（`./testing`）的门禁。
 *
 * ★ 这一档的承诺是「**可达但不承诺**」，所以它的门禁判据与其他面**相反**：
 *   · 稳定面守「不许随便增减」；
 *   · 预览面守「**不许悄悄变成稳定面**」—— 一旦某个夹具符号出现在主入口，
 *     它就从「随时可改」变成「要背 semver」，而没有任何人会注意到这件事发生了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as mainApi from '../src/index.mjs';
import * as internalApi from '../src/internal.mjs';
import * as testingApi from '../src/testing.mjs';

test('★ 夹具符号不得出现在主入口（否则它悄悄变成了稳定承诺）', () => {
  const leak = Object.keys(testingApi).filter(name => name in mainApi);
  assert.deepEqual(leak, [],
    '\n以下夹具符号同时出现在 index.mjs —— 预览面泄漏成稳定面：\n' + leak.join('\n'));
});

test('★ 夹具符号不得经 internal.mjs 抵达 plugins 包（那是跨包内部共享面，不是夹具面）', () => {
  const leak = Object.keys(testingApi).filter(name => name in internalApi);
  assert.deepEqual(leak, []);
});

test('★ 预览面必须是【显式具名导出】，不得 export *', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  for (const file of ['../src/testing.mjs', '../../plugins/src/testing.mjs']) {
    const p = fileURLToPath(new URL(file, import.meta.url));
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/\bexport\s*\*/.test(src), false,
      `${path.basename(p)} 用了 export * —— 预览面的目的是「不承诺」，export * 会让将来新加的符号自动变公开`);
  }
});

test('★ 预览面导出的是【值】不是类型（类型投影在 .d.mts 里，运行时取不到）', () => {
  assert.ok(Object.keys(testingApi).length >= 3, '夹具面至少要有 createTestHost / makeManifest / bootTestHost');
  for (const name of Object.keys(testingApi)) {
    assert.notEqual(typeof testingApi[name], 'undefined', `${name} 是 undefined（导出写错了？）`);
  }
});

test('★ createTestHost 不预装任何插件、不自动 boot（那是调用方该决定的事）', async () => {
  const host = testingApi.createTestHost();
  const diag = host.getDiagnostics();
  assert.equal(diag.totalPlugins, 0, '不得预装插件');
  assert.equal(diag.booted, false, '不得自动 boot');
});

test('★ makeManifest 造出来的清单必须真的能过 registerPlugin', async () => {
  const host = testingApi.createTestHost();
  const manifest = testingApi.makeManifest({ id: 'plug.fixture' });
  host.registerPlugin(manifest, { activate() {} });
  await host.boot();
  const diag = host.getDiagnostics();
  assert.equal(diag.totalPlugins, 1);
  assert.equal(diag.plugins[0].state, 'active', '★ 夹具造的清单必须能被真宿主接受');
});

test('★ makeManifest 缺 id ⇒ 立刻报错（不是造一份坏清单让它晚点炸）', () => {
  assert.throws(() => testingApi.makeManifest({}), /non-empty string `id`/);
  assert.throws(() => testingApi.makeManifest({ id: '' }), /non-empty string `id`/);
  assert.throws(() => testingApi.makeManifest(null), /non-empty string `id`/);
});

test('★ bootTestHost 一步到位，且失败时把真错抛出来（不吞）', async () => {
  const { bootTestHost, makeManifest } = testingApi;
  const host = await bootTestHost([
    { manifest: makeManifest({ id: 'plug.a' }), entry: { activate() {} } }
  ]);
  assert.equal(host.getDiagnostics().booted, true);
  assert.equal(host.getDiagnostics().totalPlugins, 1);

  // 依赖缺失 ⇒ boot 必须真的抛（夹具不得把装配失败变成静默）
  await assert.rejects(
    bootTestHost([{ manifest: makeManifest({ id: 'plug.b', dependencies: { 'plug.nope': '^1.0.0' } }), entry: { activate() {} } }]),
    /plug\.nope|missing_dependency/i
  );
});

test('★ assertErrorCode：没抛 / 抛错码 / 码对 三种情形都判得对', () => {
  const { assertErrorCode } = testingApi;
  assert.throws(() => assertErrorCode(undefined, 'x'), /nothing was thrown/, '没抛时必须说「没抛」而不是「undefined !== x」');
  assert.throws(() => assertErrorCode({ code: 'y' }, 'x'), /got 'y'/);
  assert.doesNotThrow(() => assertErrorCode({ code: 'x', message: 'm' }, 'x'));
});
