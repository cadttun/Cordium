// 原地替换 replacePlugin：升级插件 / 开发期热重载的内核入口
//
// 定案：
//   · 同 id 换 manifest + 代码；依赖方先级联停下，换完按依赖顺序拉回来（unregister + register 做不到：有依赖方时拒绝）；
//   · 入口同步校验（not found / 权限未登记 / 新版本不满足依赖方范围 / 新依赖成环），失败零副作用；
//   · 新代码激活失败 ⇒ 换回旧代码重新激活，再抛新代码的原始错误；
//   · 原来不是 ACTIVE ⇒ 只换不启。
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost } from '../src/host.mjs';

const SERVICE = 'service.demo';
const m = (id, extra = {}) => ({ id, version: '1.0.0', apiVersion: '1.0.0', ...extra });
const st = (host, id) => host.getDiagnostics().plugins.find(p => p.id === id)?.state;

function makeHost() {
  const host = new CordiumHost();
  host.declareServiceContracts({ [SERVICE]: { access: 'public' } });
  return host;
}

/** 提供者：服务返回 tag，并记录钩子调用 */
function provider(tag, calls = []) {
  return {
    activate(ctx) {
      calls.push(`activate:${tag}`);
      ctx.provideService(SERVICE, { who: () => tag });
    },
    deactivate() { calls.push(`deactivate:${tag}`); }
  };
}

test('替换 ACTIVE 插件：旧代码停、新代码起，服务换成新实现，ctx.manifest 是新版本', async () => {
  const host = makeHost();
  const calls = [];
  host.registerPlugin(m('p', { provides: [SERVICE] }), provider('v1', calls));
  await host.boot();
  assert.equal(host.getInternalService(SERVICE).who(), 'v1');

  let seen;
  await host.replacePlugin(m('p', { version: '1.1.0', provides: [SERVICE] }), {
    activate(ctx) { seen = ctx.manifest.version; return provider('v2', calls).activate(ctx); }
  });

  assert.deepEqual(calls, ['activate:v1', 'deactivate:v1', 'activate:v2']);
  assert.equal(st(host, 'p'), 'active');
  assert.equal(host.getInternalService(SERVICE).who(), 'v2');
  assert.equal(seen, '1.1.0');
  assert.equal(host.getDiagnostics().plugins.find(p => p.id === 'p').version, '1.1.0');
});

test('★ 有必需依赖方的提供者也能替换：依赖方先停、换完被拉回来，重新取到的是新实现', async () => {
  const host = makeHost();
  const calls = [];
  host.registerPlugin(m('p', { provides: [SERVICE] }), provider('v1', calls));
  let got = [];
  host.registerPlugin(m('c', { dependencies: { p: '^1.0.0' } }), {
    activate(ctx) { calls.push('activate:c'); got.push(ctx.getService(SERVICE).who()); },
    deactivate() { calls.push('deactivate:c'); }
  });
  await host.boot();

  // 对照：unregister + register 这条路走不通
  assert.throws(() => host.unregisterPlugin('p'), hasCode('plugin_has_dependents'));

  await host.replacePlugin(m('p', { version: '1.2.0', provides: [SERVICE] }), provider('v2', calls));
  assert.deepEqual(calls, ['activate:v1', 'activate:c', 'deactivate:c', 'deactivate:v1', 'activate:v2', 'activate:c'],
    '依赖方先停；提供者换完后依赖方重新激活');
  assert.deepEqual(got, ['v1', 'v2']);
  assert.equal(st(host, 'c'), 'active');
});

test('★ 新版本不满足依赖方的范围 ⇒ 同步拒绝，零副作用', async () => {
  const host = makeHost();
  const calls = [];
  host.registerPlugin(m('p', { provides: [SERVICE] }), provider('v1', calls));
  host.registerPlugin(m('c', { dependencies: { p: '^1.0.0' } }), { activate() {} });
  await host.boot();

  assert.throws(() => host.replacePlugin(m('p', { version: '2.0.0', provides: [SERVICE] }), provider('v2', calls)),
    hasCode('dependency_version_mismatch', /'c' requires \^1\.0\.0/));
  assert.deepEqual(calls, ['activate:v1']);
  assert.equal(st(host, 'p'), 'active');
  assert.equal(st(host, 'c'), 'active');
  assert.equal(host.getInternalService(SERVICE).who(), 'v1');
});

test('★ 新代码激活失败 ⇒ 换回旧代码重新激活，依赖方也回来，抛出新代码的原始错误', async () => {
  const host = makeHost();
  const calls = [];
  host.registerPlugin(m('p', { provides: [SERVICE] }), provider('v1', calls));
  host.registerPlugin(m('c', { dependencies: { p: '^1.0.0' } }), { activate() { calls.push('activate:c'); } });
  await host.boot();

  const boom = new Error('new code is broken');
  await assert.rejects(
    host.replacePlugin(m('p', { version: '1.1.0', provides: [SERVICE] }), { activate() { throw boom; } }),
    err => err === boom
  );
  assert.equal(st(host, 'p'), 'active', '回滚后旧代码在跑');
  assert.equal(host.getDiagnostics().plugins.find(p => p.id === 'p').version, '1.0.0', 'manifest 也换回来了');
  assert.equal(host.getInternalService(SERVICE).who(), 'v1');
  assert.equal(st(host, 'c'), 'active', '依赖方被拉回来');
  assert.deepEqual(calls, ['activate:v1', 'activate:c', 'deactivate:v1', 'activate:v1', 'activate:c']);
});

test('原来不是 ACTIVE ⇒ 只换不启；「用户停用」标记保留（boot 仍跳过）', async () => {
  const host = makeHost();
  const calls = [];
  host.registerPlugin(m('p', { provides: [SERVICE] }), provider('v1', calls));
  await host.replacePlugin(m('p', { version: '1.0.1', provides: [SERVICE] }), provider('v2', calls));
  assert.deepEqual(calls, [], '未启动的插件替换时不跑任何钩子');
  await host.boot();
  assert.equal(host.getInternalService(SERVICE).who(), 'v2');

  await host.deactivatePlugin('p');
  await host.replacePlugin(m('p', { version: '1.0.2', provides: [SERVICE] }), provider('v3', calls));
  assert.equal(st(host, 'p'), 'disabled');
  await host.boot();
  assert.equal(st(host, 'p'), 'disabled', '用户停用的插件替换后仍不被 boot 拉起');
  await host.activatePlugin('p');
  assert.equal(host.getInternalService(SERVICE).who(), 'v3');
});

test('入口校验：未注册 / 权限未登记 / 新依赖成环 ⇒ 同步抛出', async () => {
  const host = makeHost();
  assert.throws(() => host.replacePlugin(m('ghost'), null), hasCode('plugin_not_found', /'ghost'/));

  host.registerPlugin(m('a', { dependencies: { b: '*' } }), null);
  host.registerPlugin(m('b'), null);
  assert.throws(() => host.replacePlugin(m('b', { permissions: ['perm.nope'] }), null), hasCode('undeclared_permission'));
  assert.throws(() => host.replacePlugin(m('b', { dependencies: { a: '*' } }), null), hasCode('cyclic_dependency', /'b'/));
  await host.boot();
  assert.equal(st(host, 'a'), 'active', '被拒绝的替换没有留下任何东西');
});

test('★ 鉴权快照随替换更新：新 manifest 申请的权限生效，删掉的权限失效', async () => {
  const host = new CordiumHost();
  host.declareServiceContracts({ secrets: { access: 'sensitive', requiredPermission: 'perm.secrets' } });
  host.registerPlugin(m('vault', { provides: ['secrets'] }), { activate(ctx) { ctx.provideService('secrets', { read: () => 's3cret' }); } });
  let ctx;
  const consumer = { activate(c) { ctx = c; } };
  host.registerPlugin(m('app', { dependencies: { vault: '*' } }), consumer);
  await host.boot();
  assert.throws(() => ctx.getService('secrets'), hasCode('access_denied'));

  await host.replacePlugin(m('app', { dependencies: { vault: '*' }, permissions: ['perm.secrets'] }), consumer);
  assert.equal(ctx.getService('secrets').read(), 's3cret');

  await host.replacePlugin(m('app', { dependencies: { vault: '*' } }), consumer);
  assert.throws(() => ctx.getService('secrets'), hasCode('access_denied'));
});

test('manifest.hotReload：只收布尔，缺省 false；诊断里可见', async () => {
  const host = makeHost();
  assert.throws(() => host.registerPlugin(m('a', { hotReload: 'yes' }), null), hasCode('invalid_manifest', /hotReload must be a boolean/));
  host.registerPlugin(m('a', { hotReload: true }), null);
  host.registerPlugin(m('b'), null);
  const diag = Object.fromEntries(host.getDiagnostics().plugins.map(p => [p.id, p.hotReload]));
  assert.deepEqual(diag, { a: true, b: false });
  await host.replacePlugin(m('a'), null);
  assert.equal(host.getDiagnostics().plugins.find(p => p.id === 'a').hotReload, false, '随替换更新');
});
