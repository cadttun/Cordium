/**
 * @file packages/plugins/test/reload.test.mjs
 * @description 开发期热重载：reloadPlugin（重新 import + host.replacePlugin）与 watchPlugins（fs.watch）。
 *
 * 用真文件：热重载的要点就是「同一路径改了内容，Node 模块缓存不能给旧的」——注入 importModule 测不到这一点。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CordiumHost } from '@cordium/kernel';
import { hasCode } from './fixtures/errors.mjs';
import { loadPlugins } from '@cordium/plugins/loader';
import { reloadPlugin, watchPlugins } from '@cordium/plugins/reload';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cordium-reload-'));

/** 一个提供 service.demo 的插件源码；tag 区分版本 */
function source({ tag, version = '1.0.0', hotReload = true, activateThrows = false }) {
  return `export const manifest = { id: 'demo.hot', version: '${version}', apiVersion: '1.0.0', provides: ['service.demo']${hotReload ? ', hotReload: true' : ''} };
export function activate(ctx, config) {
  ${activateThrows ? "throw new Error('broken on purpose');" : ''}
  ctx.provideService('service.demo', { who: () => '${tag}:' + (config.suffix ?? '') });
}
`;
}

const USER = `export const manifest = { id: 'demo.user', version: '1.0.0', apiVersion: '1.0.0', dependencies: { 'demo.hot': '^1.0.0' } };
export function activate(ctx) { (globalThis.__cordiumReloadSeen ??= []).push(ctx.getService('service.demo').who()); }
`;

function makeHost() {
  const host = new CordiumHost();
  host.declareServiceContracts({ 'service.demo': { access: 'public' } });
  return host;
}

async function setup(opts = {}) {
  const dir = tmpDir();
  const file = path.join(dir, 'hot.mjs');
  fs.writeFileSync(file, source({ tag: 'v1', ...opts }));
  const host = makeHost();
  const entry = { module: file, config: { suffix: 'x' } };
  await loadPlugins(host, [entry]);
  await host.boot();
  return { dir, file, host, entry };
}

const who = host => host.getInternalService('service.demo').who();

test('改文件后 reloadPlugin ⇒ 换上新代码（同一路径不吃模块缓存），config 仍按清单注入', async () => {
  const { file, host, entry } = await setup();
  assert.equal(who(host), 'v1:x');

  fs.writeFileSync(file, source({ tag: 'v2', version: '1.0.1' }));
  const result = await reloadPlugin(host, entry);
  assert.deepEqual(result, { id: 'demo.hot', version: '1.0.1', previousVersion: '1.0.0' });
  assert.equal(who(host), 'v2:x');

  fs.writeFileSync(file, source({ tag: 'v3', version: '1.0.1' }));
  await reloadPlugin(host, entry);
  assert.equal(who(host), 'v3:x', '第二次重载同样拿到新内容');
});

test('★ 依赖方被停下再拉起，重新取到新实现', async () => {
  const { dir, file, host, entry } = await setup();
  const userFile = path.join(dir, 'user.mjs');
  fs.writeFileSync(userFile, USER);
  globalThis.__cordiumReloadSeen = [];
  await loadPlugins(host, [{ module: userFile }]);
  await host.boot();

  fs.writeFileSync(file, source({ tag: 'v2' }));
  await reloadPlugin(host, entry);
  assert.deepEqual(globalThis.__cordiumReloadSeen, ['v1:x', 'v2:x']);
  assert.equal(host.getDiagnostics().plugins.find(p => p.id === 'demo.user').state, 'active');
  delete globalThis.__cordiumReloadSeen;
});

test('★ 未声明 hotReload ⇒ invalid_usage 拒绝，旧代码原样在跑；force 可跳过', async () => {
  const { file, host, entry } = await setup({ hotReload: false });
  fs.writeFileSync(file, source({ tag: 'v2', hotReload: false }));
  await assert.rejects(reloadPlugin(host, entry), hasCode('invalid_usage', /running version and the new version/));
  assert.equal(who(host), 'v1:x');

  await reloadPlugin(host, entry, { force: true });
  assert.equal(who(host), 'v2:x');
});

test('正在跑的版本声明了、新版本去掉了 hotReload ⇒ 同样拒绝（两边都要写）', async () => {
  const { file, host, entry } = await setup();
  fs.writeFileSync(file, source({ tag: 'v2', hotReload: false }));
  await assert.rejects(reloadPlugin(host, entry), hasCode('invalid_usage', /the new version does not/));
  assert.equal(who(host), 'v1:x');
});

test('★ 新代码激活失败 ⇒ 抛原始错误，旧代码仍在跑；语法错 ⇒ plugin_load_failed 且带位置', async () => {
  const { file, host, entry } = await setup();
  fs.writeFileSync(file, source({ tag: 'v2', activateThrows: true }));
  await assert.rejects(reloadPlugin(host, entry), /broken on purpose/);
  assert.equal(who(host), 'v1:x');

  fs.writeFileSync(file, 'export const manifest = ;\n');
  await assert.rejects(reloadPlugin(host, entry), hasCode('plugin_load_failed', /\n {2}at file:.*hot\.mjs/));
  assert.equal(who(host), 'v1:x');
});

test('入口校验：未注册的插件 / 非本地文件 / 清单拼错', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'hot.mjs');
  fs.writeFileSync(file, source({ tag: 'v1' }));
  await assert.rejects(reloadPlugin(makeHost(), { module: file }), hasCode('plugin_not_found', /loadPlugins first/));
  await assert.rejects(reloadPlugin(makeHost(), { module: 'data:text/javascript,export const manifest={}' }), hasCode('invalid_argument', /local file/));
  await assert.rejects(reloadPlugin(makeHost(), { module: file, confg: {} }), hasCode('invalid_argument', /unknown field/));
  await assert.rejects(reloadPlugin({}, { module: file }), hasCode('invalid_argument', /CordiumHost/));
  assert.throws(() => watchPlugins(makeHost(), [{ module: './rel.mjs' }]), hasCode('invalid_argument'));
  assert.throws(() => watchPlugins(makeHost(), [], { debounceMs: -1 }), hasCode('invalid_argument'));
});

/** 等到 predicate 为真（轮询；文件监视的回调时机依平台而定） */
async function waitFor(predicate, ms = 5000) {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('waitFor: timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

test('★ watchPlugins：保存即重载；出错交给 onError 且监视继续；close 后不再重载', async () => {
  const { file, host, entry } = await setup();
  const reloads = [];
  const errors = [];
  const watcher = watchPlugins(host, [entry], { debounceMs: 20, onReload: r => reloads.push(r.version), onError: e => errors.push(e) });
  try {
    fs.writeFileSync(file, source({ tag: 'v2', version: '1.0.1' }));
    await waitFor(() => who(host) === 'v2:x');

    fs.writeFileSync(file, source({ tag: 'v3', activateThrows: true }));
    await waitFor(() => errors.length > 0);
    assert.equal(who(host), 'v2:x', '失败的重载不影响正在跑的代码');

    fs.writeFileSync(file, source({ tag: 'v4', version: '1.0.2' }));
    await waitFor(() => who(host) === 'v4:x');
    assert.ok(reloads.includes('1.0.2'));
  } finally {
    watcher.close();
  }
  fs.writeFileSync(file, source({ tag: 'v5' }));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(who(host), 'v4:x', 'close 之后改文件不再重载');
});
