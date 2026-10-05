/**
 * 跨主题的回归合集：监听器异步拒绝、作用域接管、依赖检查、级联停用、版本与 manifest 校验等。
 * ★ 每条都必须能判别：撤掉对应修复 ⇒ 本文件对应用例变红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { MessageChannel, CordiumHost, EffectScope } from '../src/index.mjs';
import { listenerCount } from './fixtures/inspect.mjs';

const tick = () => new Promise(r => setTimeout(r, 0));
const m = (id, extra = {}) => ({ id, version: '1.0.0', apiVersion: '1.0.0', ...extra });

// ─────────── 异步监听器拒绝不得变成 unhandledRejection（否则 Node 直接退出进程）───────────

async function captureUnhandled(fn) {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try { await fn(); await tick(); await tick(); } finally { process.off('unhandledRejection', onUnhandled); }
  return seen;
}

test('★ emit：async 监听器 reject ⇒ 走 onListenerError，不得 unhandledRejection', async () => {
  const ch = new MessageChannel();
  const reported = [];
  ch.onListenerError = (name, err) => reported.push(err.message);
  ch.subscribe('e', async () => { throw new Error('async boom'); });
  const unhandled = await captureUnhandled(() => ch.emit('e'));
  assert.deepEqual(unhandled, [], '异步拒绝不得逃逸为 unhandledRejection');
  assert.deepEqual(reported, ['async boom'], '必须经 onListenerError 上报');
});

test('★ broadcast（internal/service 等宿主通知走这里）同样接住异步拒绝', async () => {
  const ch = new MessageChannel();
  const reported = [];
  ch.onListenerError = (name, err) => reported.push(err.message);
  ch.subscribe('internal/x', async () => { throw new Error('watcher boom'); });
  const unhandled = await captureUnhandled(() => ch.broadcast('internal/x'));
  assert.deepEqual(unhandled, []);
  assert.deepEqual(reported, ['watcher boom']);
});

test('bail：async 监听器不得被当成「已拦截」—— 响亮失败并指向 serial', () => {
  const ch = new MessageChannel();
  ch.subscribe('q', async () => undefined);
  ch.subscribe('q', () => 'real answer');
  assert.throws(() => ch.bail('q'), hasCode('invalid_usage'));
});

// ─────────── 父作用域被回收后，子链不得被他人重建的同名父键「接管」───────────

test('★ 仍有子键时父键不得被回收（名字不空出来，就无从被重建接管）', () => {
  const ch = new MessageChannel();
  ch.ensureScope('team', null);          // A 建 team
  ch.ensureScope('writer', 'team');      // B 在 team 下建 writer
  ch.releaseScope('team');               // A 停用
  assert.equal(ch.scopeParentOf('team'), null, 'writer 还在 ⇒ team 必须仍存在');
  ch.ensureScope('evil', null);
  const rebuilt = ch.ensureScope('team', 'evil');   // 攻击者企图把 team 重建到自己下面
  assert.equal(rebuilt.created, false, '只能加入既有的 team，不能重建');
  assert.equal(ch.scopeParentOf('team'), null, 'team 的位置不得被改写');
});

test('★ 端到端：他人重建同名父键后，受害者的事件不得流进攻击者作用域', async () => {
  // 可达路径：C 以顶层写法 ctx.scoped('writer') 【加入】已有的 writer —— 加入者不持有 team。
  //   A、B 停用后 team 的声明者归零；修复前 team 被删而 writer.parent 仍指着名字 'team'。
  const host = new CordiumHost();
  host.declareServiceContracts({ 'svc.x': { access: 'public' } });
  const heard = [];
  let victim;
  host.registerPlugin(m('plugin.a'), { activate(ctx) { ctx.scoped('team'); } });
  host.registerPlugin(m('plugin.b'), { activate(ctx) { ctx.scoped('team').scoped('writer'); } });
  host.registerPlugin(m('plugin.c'), { activate(ctx) { victim = ctx.scoped('writer'); } });
  await host.boot();
  await host.deactivatePlugin('plugin.a');
  await host.deactivatePlugin('plugin.b');

  host.registerPlugin(m('plugin.evil', { provides: ['svc.x'] }), {
    activate(ctx) {
      const team = ctx.scoped('evil').scoped('team');     // 企图把 team 重建到自己下面
      team.provideService('svc.x', { who: () => 'EVIL' });
      ctx.scoped('evil').on('leak', v => heard.push(v));
    }
  });
  await host.activatePlugin('plugin.evil');

  victim.emit('leak', 'VICTIM-DATA');
  assert.deepEqual(heard, [], '受害者事件不得被攻击者的祖先监听器收到');
  // ⚠️ 不断言 getService：label 按设计是【共享键而非凭证】（见 ctx.scoped 注释），
  //   任何插件都能按名字加入 team 并在其中提供服务 —— 那是既有设计，不是本缺陷。
  //   本缺陷是【位置被改写】：修复前 team 被挂到 evil 之下，evil 作用域的监听器因此收到 writer 的事件。
});

test('回收仍然完整：子键释放后父键随之归零（不得因持有而泄漏）', () => {
  const ch = new MessageChannel();
  ch.ensureScope('team', null);
  ch.ensureScope('writer', 'team');
  ch.releaseScope('team');
  ch.releaseScope('writer');
  assert.equal(ch.scopeCount(), 0);
});

// ─────────── 直接 activatePlugin 也必须检查依赖 ───────────

const st = (host, id) => host.getDiagnostics().plugins.find(p => p.id === id)?.state;

test('★ 依赖未注册 ⇒ activatePlugin 拒绝（此前照样 active）', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('c', { dependencies: { ghost: '^9.0.0' } }), { activate() {} });
  await assert.rejects(host.activatePlugin('c'), hasCode('missing_dependency', /Missing dependency 'ghost'/));
  assert.equal(st(host, 'c'), 'failed');
});

test('★ 依赖已注册但未激活 ⇒ activatePlugin 拒绝（此前父 discovered、子 active）', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p'), { activate() {} });
  host.registerPlugin(m('c', { dependencies: { p: '*' } }), { activate() {} });
  await assert.rejects(host.activatePlugin('c'), hasCode('dependency_inactive'));
  await host.activatePlugin('p');
  await host.activatePlugin('c');
  assert.equal(st(host, 'c'), 'active', '依赖就绪后可正常激活');
});

test('版本不满足 ⇒ activatePlugin 拒绝', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p'), { activate() {} });
  host.registerPlugin(m('c', { dependencies: { p: '^2.0.0' } }), { activate() {} });
  await host.activatePlugin('p');
  await assert.rejects(host.activatePlugin('c'), hasCode('dependency_version_mismatch'));
});

// ★ resolveTopologicalOrder 已私有化 ⇒ 改经 boot() 观察（它是唯一调用方，且在任何激活之前调用）。
test('拓扑解析是纯查询：boot 因缺依赖失败时只抛错，不改插件状态', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('c', { dependencies: { p: '*' } }), {});
  await assert.rejects(() => host.boot(), hasCode('missing_dependency'));
  assert.equal(st(host, 'c'), 'discovered');
});

// ─────────── 级联停用 + 恢复 ───────────

function chain() {
  const host = new CordiumHost();
  const order = [];
  const plug = (id, deps = {}) => host.registerPlugin(m(id, { dependencies: deps }), {
    activate() { order.push('+' + id); }, deactivate() { order.push('-' + id); }
  });
  plug('base'); plug('mid', { base: '*' }); plug('top', { mid: '*' }); plug('other');
  return { host, order };
}

test('★ 停用提供者 ⇒ 依赖方按「由外到内」先停（传递）', async () => {
  const { host, order } = chain();
  await host.boot();
  order.length = 0;
  await host.deactivatePlugin('base');
  assert.deepEqual(order, ['-top', '-mid', '-base']);
  assert.deepEqual(['base', 'mid', 'top', 'other'].map(id => st(host, id)), ['disabled', 'disabled', 'disabled', 'active'],
    '无关插件不受影响');
});

test('★ 提供者重新激活 ⇒ 被级联停用的依赖方按顺序恢复', async () => {
  const { host, order } = chain();
  await host.boot();
  await host.deactivatePlugin('base');
  order.length = 0;
  await host.activatePlugin('base');
  assert.deepEqual(order, ['+base', '+mid', '+top']);
});

test('用户显式停用的依赖方不随提供者恢复', async () => {
  const { host } = chain();
  await host.boot();
  await host.deactivatePlugin('top');     // 用户意图
  await host.deactivatePlugin('base');
  await host.activatePlugin('base');
  assert.equal(st(host, 'mid'), 'active');
  assert.equal(st(host, 'top'), 'disabled', '用户停掉的不得被自动拉起');
});

test('★ boot() 不得复活用户显式停用的插件（及其依赖方）', async () => {
  const { host } = chain();
  await host.boot();
  await host.deactivatePlugin('mid');
  host.registerPlugin(m('late'), { activate() {} });
  await host.boot();
  assert.equal(st(host, 'late'), 'active');
  assert.equal(st(host, 'mid'), 'disabled', '此前 boot 会把它重新拉起');
  assert.equal(st(host, 'top'), 'disabled');
});

test('boot 失败回滚不算用户停用：修好后重试 boot 能起来', async () => {
  const host = new CordiumHost();
  let fail = true;
  host.registerPlugin(m('a'), { activate() {} });
  host.registerPlugin(m('b', { dependencies: { a: '*' } }), { activate() { if (fail) throw new Error('boom'); } });
  // 保留报文断言：插件自抛的错误须原样透传（非 CordiumError、无 code），报文即被测对象
  await assert.rejects(host.boot(), /boom/);  // 保留报文断言：插件自抛的错误须原样透传，报文即被测对象
  fail = false;
  await host.boot();
  assert.equal(st(host, 'a'), 'active');
  assert.equal(st(host, 'b'), 'active');
});

// ─────────── 版本比较与 manifest 校验 ───────────

import { compareSemVer, validateManifest } from '../src/index.mjs';
import { createPluginCatalog } from '@cordium/plugins/catalog';
import { validatePluginManifest } from '@cordium/plugins/runtime';

test('★ catalog 降级检查：含连字符的预发布段不得被截断', () => {
  const c = createPluginCatalog();
  c.add({ id: 'p', name: 'P', version: '1.0.0-rc-2' });
  assert.throws(() => c.add({ id: 'p', name: 'P', version: '1.0.0-rc-1' }), hasCode('version_conflict'), 'rc-2 → rc-1 是降级');
  const d = createPluginCatalog();
  d.add({ id: 'q', name: 'Q', version: '1.0.0-x-9' });
  assert.throws(() => d.add({ id: 'q', name: 'Q', version: '1.0.0-x-10' }), hasCode('version_conflict'), '「x-9」>「x-10」（非数字标识符按字典序）');
  assert.equal(compareSemVer('1.0.0-rc-2', '1.0.0-rc-1'), 1);
});

test('catalog importIndex 原子：任一条非法 ⇒ 一条都不写入', () => {
  const c = createPluginCatalog();
  const bad = JSON.stringify({ schemaVersion: 'plugin-catalog/v1', apiVersion: '1.0.0',
    entries: [{ manifest: { id: 'good', name: 'G', version: '1.0.0' } }, { manifest: { id: 'BAD ID', name: 'B', version: '1.0.0' } }] });
  assert.throws(() => c.importIndex(bad), hasCode('invalid_manifest'));
  assert.deepEqual(c.list(), [], '半导入不得发生');
});

test('catalog exportIndex 不依赖 this（解构调用可用）', () => {
  const { exportIndex, add } = createPluginCatalog();
  add({ id: 'p', name: 'P', version: '1.0.0' });
  assert.match(exportIndex(), /"p"/);
});

test('★ 插件层 validateManifest 拒绝非字符串 id / version', () => {
  assert.throws(() => validatePluginManifest({ id: 1, name: 'x', version: '1.0.0' }), hasCode('invalid_manifest'));
  assert.throws(() => validatePluginManifest({ id: ['abc'], name: 'x', version: '1.0.0' }), hasCode('invalid_manifest'));
  assert.throws(() => validatePluginManifest({ id: 'abc', name: 'x', version: ['1.0.0'] }), hasCode('invalid_manifest'));
});

test('★ 内核层 validateManifest 与插件层对齐：id 字符集 / SemVer 版本 / apiVersion 主版本', () => {
  const base = { id: 'ok.plugin', version: '1.0.0', apiVersion: '1.0.0' };
  assert.doesNotThrow(() => validateManifest(base));
  assert.throws(() => validateManifest({ ...base, id: 'A B' }), hasCode('invalid_manifest'));
  assert.throws(() => validateManifest({ ...base, id: '__proto__' }), hasCode('invalid_manifest'));
  assert.throws(() => validateManifest({ ...base, version: 'banana' }), hasCode('invalid_manifest'));
  assert.throws(() => validateManifest({ ...base, apiVersion: '9.0.0' }), hasCode('incompatible_api_version'));
  assert.doesNotThrow(() => validateManifest({ ...base, apiVersion: '1.4.2' }), '同主版本兼容');
});

test('依赖名 __proto__ 不得被静默吞掉（成为普通键，随后按缺失依赖报错）', () => {
  const man = validateManifest({ id: 'x', version: '1.0.0', apiVersion: '1.0.0', dependencies: { ['__proto__']: '*' } });
  assert.deepEqual(Object.keys(man.dependencies), ['__proto__']);
  assert.equal(Object.getPrototypeOf(man.dependencies), Object.prototype, '不得改写原型');
});

// ─────────── scope / ctx / action / 诊断 ───────────

test('★ activate 结束后插件自行 dispose scope ⇒ 当场抛错，状态与资源不脱钩', async () => {
  const host = new CordiumHost();
  let ctx;
  host.registerPlugin(m('p'), { activate(c) { ctx = c; c.on('ping', () => {}); } });
  await host.boot();
  assert.throws(() => ctx.scope.dispose(), hasCode('scope_owned_by_host'));
  assert.equal(ctx.scope.active, true);
  assert.equal(listenerCount(host, 'ping'), 1, '监听器不得被摘');
});

test('★ 退订 / once 触发后 disposer 一并归还（常驻插件不得无上限增长）', async () => {
  const host = new CordiumHost();
  let ctx;
  host.registerPlugin(m('p'), { activate(c) { ctx = c; } });
  await host.boot();
  const base = ctx.scope.disposers.size;
  for (let i = 0; i < 100; i += 1) ctx.on('t', () => {})();
  for (let i = 0; i < 100; i += 1) ctx.once('o', () => {});
  ctx.emit('o');
  assert.equal(ctx.scope.disposers.size, base);
});

test('★ 停用后的旧 ctx 不得再 emit / parallel / serial / bail / waterfall', async () => {
  const host = new CordiumHost();
  let stale;
  const heard = [];
  host.registerPlugin(m('a'), { activate(c) { stale = c; } });
  host.registerPlugin(m('b'), { activate(c) { c.on('x', v => heard.push(v)); } });
  await host.boot();
  await host.deactivatePlugin('a');
  assert.throws(() => stale.emit('x', 'ghost'), hasCode('scope_disposed'));
  assert.throws(() => stale.bail('x'), hasCode('scope_disposed'));
  assert.throws(() => stale.waterfall('x', () => {}), hasCode('scope_disposed'));
  assert.throws(() => stale.parallel('x'), hasCode('scope_disposed'));
  assert.throws(() => stale.serial('x'), hasCode('scope_disposed'));
  assert.deepEqual(heard, []);
});

test('registerAction：缺 handler 立即拒绝；同插件重复注册拒绝（不静默覆盖）', async () => {
  const host = new CordiumHost();
  const errors = [];
  host.registerPlugin(m('p'), { activate(c) {
    try { c.registerAction('none', {}); } catch (e) { errors.push(e); }
    c.registerAction('dup', { handler: () => 'first' });
    try { c.registerAction('dup', { handler: () => 'second' }); } catch (e) { errors.push(e); }
  } });
  await host.boot();
  assert.ok(hasCode('invalid_argument')(errors[0]));
  assert.ok(hasCode('duplicate_action', /already registered by plugin 'p'/)(errors[1]));
  assert.equal(await host.dispatchAction('p', 'dup'), 'first');
});

test('★ 执行期间属主被停用 ⇒ 迟到结果被丢弃（不得交给调用方）', async () => {
  const host = new CordiumHost();
  let release;
  host.registerPlugin(m('o'), { activate(c) { c.registerAction('slow', { handler: () => new Promise(r => { release = r; }) }); } });
  host.registerPlugin(m('c'), { activate() {} });
  await host.boot();
  const p = host.dispatchAction('c', 'slow');
  await tick();
  await host.deactivatePlugin('o');
  release('late');
  await assert.rejects(p, hasCode('action_owner_gone'));
});

test('★ 诊断 / UI 查询交副本：外部改不动审计日志与 UI 贡献的属主', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('u'), { activate(c) { c.registerUIContribution({ id: 'panel.1', type: 'panel' }); } });
  await host.boot();
  host.log('info', 'orig');
  host.getDiagnostics().recentLogs.at(-1).message = 'tampered';
  assert.equal(host.getDiagnostics().recentLogs.at(-1).message, 'orig');
  host.getUIContributions()[0].ownerId = 'evil';
  await host.deactivatePlugin('u');
  assert.equal(host.getUIContributions().length, 0, '属主停用后贡献必须被摘除');
});

test('★ 审计 details 存快照：插件记完日志后改自己的对象，改不动审计记录', async () => {
  const host = new CordiumHost();
  const details = { who: 'orig', nested: { n: 1 } };
  host.registerPlugin(m('w'), { activate(c) { c.log('error', 'rec', details); } });
  await host.boot();
  details.who = 'tampered';
  details.nested.n = 999;
  const read = () => host.getDiagnostics().recentLogs.find(l => l.message === '[w] rec');
  assert.deepEqual(read().details, { who: 'orig', nested: { n: 1 } }, '写入侧：不得共享调用方的引用');
  read().details.nested.n = 42;
  assert.equal(read().details.nested.n, 1, '读出侧：诊断副本不得是审计记录的写入口');
  host.getDiagnostics().recentErrors.at(-1).details.who = 'x';
  assert.equal(host.getDiagnostics().recentErrors.at(-1).details.who, 'orig', 'recentErrors 同一口径');
});

test('不可克隆的 details（函数）不抛错，留下可见标记', () => {
  const host = new CordiumHost();
  assert.doesNotThrow(() => host.log('warn', 'fn', { cb: () => {} }));
  assert.equal(host.getDiagnostics().recentLogs.at(-1).details.unclonable, true);
});

// ─────────── 其它：ecosystem / 超时 / 构造参数 / 定时器 ───────────

import { resolvePluginDependencies, callWithTimeout } from '@cordium/plugins/ecosystem';

test('ecosystem 与内核判定一致：* / latest 不再特判放行', () => {
  assert.throws(() => resolvePluginDependencies([
    { id: 'a', name: 'A', version: '1.0.0-beta' },
    { id: 'b', name: 'B', version: '1.0.0', dependencies: { a: '*' } }
  ]), err => err.code === 'dependency_version_mismatch', '预发布版本不满足 *（SemVer 规则，内核同样拒绝）');
  // ★ 'latest' 是 npm dist-tag 不是版本范围 —— 注册 / 校验期即拒（invalid_manifest），
  //   不再拖到解析期报成 dependency_version_mismatch（那会把错误归到提供者头上）。
  assert.throws(() => resolvePluginDependencies([
    { id: 'a', name: 'A', version: '1.0.0' },
    { id: 'b', name: 'B', version: '1.0.0', dependencies: { a: 'latest' } }
  ]), err => err.code === 'invalid_manifest');
});

test('★ 非法依赖范围串两层都在校验期拒绝（invalid_manifest），合法写法照常', () => {
  const base = { id: 'p', version: '1.0.0', apiVersion: '1.0.0' };
  for (const bad of ['>>>x', 'not a range', '^1.0.0 || >>>', '1.x.y', 'latest']) {
    for (const field of ['dependencies', 'optionalDependencies']) {
      assert.throws(() => validateManifest({ ...base, [field]: { a: bad } }),
        err => err.code === 'invalid_manifest' && err.pluginId === 'p' && err.message.includes(field),
        `kernel ${field}: ${bad}`);
    }
    assert.throws(() => validatePluginManifest({ ...base, name: 'P', dependencies: { a: bad } }),
      err => err.code === 'invalid_manifest', `plugin: ${bad}`);
  }
  for (const ok of ['*', '', '  ', '^1.0.0', '>=1.2.3 <2.0.0', '1.x', '~0.1', '1.0.0 - 2.0.0', '^1.0.0 || ^2.0.0']) {
    assert.doesNotThrow(() => validateManifest({ ...base, dependencies: { a: ok } }), `合法：${JSON.stringify(ok)}`);
  }
});

test('ecosystem 深依赖链不栈溢出（迭代 DFS）', () => {
  const chain = Array.from({ length: 20000 }, (_, i) =>
    ({ id: `p${i}`, name: 'P', version: '1.0.0', dependencies: i ? [`p${i - 1}`] : [] }));
  assert.equal(resolvePluginDependencies(chain.reverse()).length, 20000);
});

test('ecosystem：已注册插件自身的问题不拖垮无关候选；非 Map registry 响亮报错；权限按集合比较', () => {
  const registry = new Map([['old', { manifest: { id: 'old', version: '1.0.0', dependencies: 'garbage' } }]]);
  assert.deepEqual(resolvePluginDependencies([{ id: 'c', name: 'C', version: '1.0.0' }], { existingRegistry: registry }).map(x => x.id), ['c']);
  assert.throws(() => resolvePluginDependencies([], { existingRegistry: {} }), err => err.code === 'invalid_registry');
  const reg2 = new Map([['p', { manifest: { id: 'p', version: '1.0.0', apiVersion: '1.0.0', permissions: ['y', 'x'] } }]]);
  assert.doesNotThrow(() => resolvePluginDependencies([{ id: 'p', name: 'P', version: '1.0.0', permissions: ['x', 'y'] }], { existingRegistry: reg2 }));
});

test('callWithTimeout：非法 timeoutMs 响亮失败（此前 Infinity/NaN 被 Node 改成 1ms）', async () => {
  for (const bad of [Infinity, NaN, 2 ** 31, 0, -1]) {
    await assert.rejects(callWithTimeout(() => 1, [], { timeoutMs: bad }), err => err.code === 'invalid_timeout');
  }
  assert.equal(await callWithTimeout(() => 42, [], { timeoutMs: 100 }), 42);
});

test('构造参数校验：非法值响亮失败，缺省取默认', () => {
  assert.throws(() => new CordiumHost({ maxLogSize: -1 }), hasCode('invalid_option'));
  assert.throws(() => new CordiumHost({ hostVersion: 'banana' }), hasCode('invalid_option'));
  assert.throws(() => new CordiumHost({ actionTimeoutMs: 'abc' }), hasCode('invalid_option'));
  assert.equal(new CordiumHost().maxLogSize, 500);
});

test('scope.untrackTimer：一次性定时器触发后可移出托管集合', async () => {
  const host = new CordiumHost();
  let ctx;
  host.registerPlugin(m('p'), { activate(c) { ctx = c; } });
  await host.boot();
  const id = ctx.scope.trackTimer(setTimeout(() => ctx.scope.untrackTimer(id), 0));
  assert.equal(ctx.scope.timers.size, 1);
  await tick();
  assert.equal(ctx.scope.timers.size, 0);
});

// ─────────── 权限词表 / activate 期间 dispatch ───────────

test('★ 插件申请未登记的权限 ⇒ 注册失败（禁止自造权限名互相授权）', () => {
  const host = new CordiumHost();
  assert.throws(
    () => host.registerPlugin(m('a', { permissions: ['made.up'] }), {}),
    hasCode('undeclared_permission', /undeclared permission 'made\.up'/)
  );
  assert.equal(host.getDiagnostics().plugins.length, 0, '门禁必须早于写表');
  host.declarePermissions(['made.up']);
  assert.doesNotThrow(() => host.registerPlugin(m('a', { permissions: ['made.up'] }), {}));
});

test('★ action 用未登记的权限名守门 ⇒ 注册失败（拼错的权限名不得静默生效）', async () => {
  const host = new CordiumHost();
  host.declarePermissions(['perm.sens']);
  const errors = [];
  host.registerPlugin(m('b'), { activate(c) {
    try { c.registerAction('x', { requiredPermission: 'perm.sen', handler: () => 1 }); } catch (e) { errors.push(e); }
  } });
  await host.boot();
  assert.ok(hasCode('undeclared_permission', /undeclared permission 'perm\.sen'/)(errors[0]));
});

test('契约的 requiredPermission 即宿主定义，自动入词表；非法名拒绝', () => {
  const host = new CordiumHost();
  host.declareServiceContract('svc.s', { access: 'sensitive', requiredPermission: 'perm.s' });
  assert.deepEqual(host.getDiagnostics().permissions, ['perm.s']);
  assert.doesNotThrow(() => host.registerPlugin(m('c', { permissions: ['perm.s'] }), {}));
  assert.throws(() => host.declarePermissions(['Bad Name']), hasCode('invalid_permission'));
  assert.throws(() => host.declarePermissions('perm.x'), hasCode('invalid_argument'));
});

test('★ activate() 期间 ctx.dispatch 与 getService 口径一致：允许', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('o'), { activate(c) { c.registerAction('ping', { handler: () => 'pong' }); } });
  let got;
  host.registerPlugin(m('q', { dependencies: { o: '*' } }), { async activate(c) { got = await c.dispatchAction('ping'); } });
  await host.boot();
  assert.equal(got, 'pong');
});

test('仍拒绝未激活 / 已停用的调用方', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('o'), { activate(c) { c.registerAction('ping', { handler: () => 'pong' }); } });
  host.registerPlugin(m('idle'), {});
  await host.activatePlugin('o');
  await assert.rejects(host.dispatchAction('idle', 'ping'), hasCode('access_denied'));
});

// ─────────── 收尾检查 ───────────

test('★ 可选提供者已安装但被停用 ⇒ optional_unavailable（按设计降级，而非通用错误）', async () => {
  const host = new CordiumHost();
  host.declareServiceContracts({ 'svc.o': { access: 'declared', optionalProvider: 'p' } });
  let ctx;
  host.registerPlugin(m('p', { provides: ['svc.o'] }), { activate(c) { c.provideService('svc.o', { x: () => 1 }); } });
  host.registerPlugin(m('c', { optionalDependencies: { p: '*' } }), { activate(c) { ctx = c; } });
  await host.boot();
  assert.equal(ctx.getService('svc.o').x(), 1);
  await host.deactivatePlugin('p');
  assert.equal(st(host, 'c'), 'active', '可选依赖不参与级联');
  assert.throws(() => ctx.getService('svc.o'), err => err.code === 'optional_unavailable');
});

test('★ 多余的 releaseScope 不得把仍有子键的父键删掉（防计数下溢接管）', () => {
  const ch = new MessageChannel();
  ch.declareScope('p', null);
  ch.declareScope('c', 'p');
  for (let i = 0; i < 5; i += 1) ch.releaseScope('p');
  assert.equal(ch.scopeParentOf('p'), null, 'p 仍有子键 c，不得被回收');
  ch.ensureScope('evil', null);
  assert.equal(ch.ensureScope('p', 'evil').created, false);
  assert.equal(ch.scopeParentOf('p'), null);
  ch.releaseScope('p');   // 归还上面 ensureScope('p', …) 的那次加入
  ch.releaseScope('c');
  assert.equal(ch.scopeCount(), 1, 'c 回收后 p 随之回收，只剩 evil（回收不泄漏）');
});

test('★ 插件拿不到宿主挂的释放闭包（scope.disposers 只给占位）', async () => {
  const host = new CordiumHost();
  let ctx;
  host.registerPlugin(m('a'), { activate(c) { ctx = c; c.scoped('team'); } });
  await host.boot();
  for (const d of ctx.scope.disposers) assert.notEqual(typeof d, 'function');
});

test('未声明的父键随子键以顶层入表：他人不能再把它新建到自己下面', () => {
  const ch = new MessageChannel();
  ch.declareScope('c', 'p');
  assert.equal(ch.scopeParentOf('p'), null);
  ch.ensureScope('evil', null);
  ch.ensureScope('p', 'evil');
  assert.equal(ch.scopeParentOf('p'), null, 'p 的位置不得被改写');
});

test('bail 拒绝 async 监听器时仍上报其拒绝原因', async () => {
  const ch = new MessageChannel();
  const reported = [];
  ch.onListenerError = (n, e) => reported.push(e.message);
  ch.subscribe('q', async () => { throw new Error('real cause'); });
  assert.throws(() => ch.bail('q'), hasCode('invalid_usage'));
  await tick();
  assert.deepEqual(reported, ['real cause']);
});

test('★ 两层 manifest 版本判定一致：宽松写法与越界数字两层都拒绝', () => {
  const base = { id: 'ok', version: '1.0.0', apiVersion: '1.0.0' };
  for (const bad of ['v1.0.0', ' 1.0.0', '1.0.0+build', '9007199254740992.0.0']) {
    assert.throws(() => validateManifest({ ...base, version: bad }), hasCode('invalid_manifest'), `kernel: ${bad}`);
    assert.throws(() => validatePluginManifest({ ...base, name: 'x', version: bad }), hasCode('invalid_manifest'), `plugin: ${bad}`);
  }
  const c = createPluginCatalog();
  assert.throws(() => c.add({ id: 'big', name: 'B', version: '9007199254740992.0.0' }), hasCode('invalid_manifest'));
});

// ─────────── 释放回调抛错不得短路其余释放 ───────────

test('★ 一条释放回调抛错 ⇒ 其余释放照常走完、dispose 不 reject（状态永久停在 STOPPING 的那条路被堵死）', async () => {
  // 为什么这条要紧：宿主侧是 `await scope.dispose(...)` 之后才置 DISABLED。
  // 只要 dispose 能 reject，一条释放回调抛错就能让插件状态既回不到 ACTIVE、也到不了 DISABLED。
  // 判别性：撤掉 scope.mjs 第 3 步的 try/catch ⇒ 本用例在 `await scope.dispose()` 处变红。
  const released = [];
  const reported = [];
  const scope = new EffectScope('plugin.release-throws', {
    releaseService: (name) => {
      released.push(`service:${name}`);
      if (name === 'svc.first') throw new Error('release boom');
    },
    releaseUIContribution: (id) => {
      released.push(`ui:${id}`);
      if (id === 'ui.two') throw new Error('ui boom');
    },
    onDisposeError: (ownerId, err) => reported.push(`${ownerId}|${err.message}`)
  });
  scope.trackService('svc.first');      // 两段循环各埋一个会抛的，两处的隔离都得被测到
  scope.trackService('svc.second');
  scope.trackUIContribution('ui.one');
  scope.trackUIContribution('ui.two');

  await scope.dispose();

  assert.deepEqual(released, ['service:svc.first', 'service:svc.second', 'ui:ui.one', 'ui:ui.two'],
    '抛错的那条不得短路其后的一切释放');
  assert.deepEqual(reported, ['plugin.release-throws|release boom', 'plugin.release-throws|ui boom'],
    '两处抛错都要上报，不是被吞掉');
  assert.equal(scope.active, false, 'dispose 走完 ⇒ 已停活');
});
