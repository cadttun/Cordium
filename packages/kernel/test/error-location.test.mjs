/**
 * @file packages/kernel/test/error-location.test.mjs
 * @description 兜底定位：出错时能不能一眼看出「哪个插件、什么码、哪一行」。
 *
 * ★ 分两类：
 *   · 有调用方的失败（服务 / 动作 / serial·waterfall）—— 调用方 catch 到 CordiumError：code / pluginId / cause（原错误带插件行号）；
 *   · 没有调用方的失败（emit 监听器、清理回调、生命周期钩子、启动回滚）—— 只进宿主日志，
 *     日志必须自带：插件 id、码、源头位置（文件:行:列）、栈、cause 链。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CordiumHost, CordiumError, ErrorCode, MessageChannel } from '../src/index.mjs';
import { errorDetails, firstFrame } from '../src/internal.mjs';

const THIS_FILE = fileURLToPath(import.meta.url).replace(/\\/g, '/');
// 栈里的位置是 file:///F:/… ；比对时只看文件名 + 行号，免受盘符 / 斜杠差异影响
const atThisFile = loc => typeof loc === 'string' && loc.includes('error-location.test.mjs:');
const lineOf = loc => Number(/:(\d+):\d+$/.exec(loc)?.[1]);

const register = (host, id, hooks, extra = {}) =>
  host.registerPlugin({ id, version: '1.0.0', apiVersion: '1.0.0', ...extra }, hooks);
const logs = host => host.getDiagnostics().recentLogs;
const errors = host => host.getDiagnostics().recentErrors;

// ════════════════ 工具函数 ════════════════

test('firstFrame：跳过 node: 内部帧与内核源文件帧，返回第一条插件帧；找不到 ⇒ null', () => {
  const stack = [
    'Error: x',
    '    at a (node:internal/process/task_queues:95:5)',
    '    at b (file:///F:/repo/packages/kernel/src/host.mjs:10:3)',
    '    at c (/usr/lib/node_modules/@cordium/kernel/src/channel.mjs:1:2)',
    '    at d (file:///C:/p/my-plugin.mjs:3:51)',
    '    at e (file:///C:/p/later.mjs:9:9)'
  ].join('\n');
  assert.equal(firstFrame(stack), 'file:///C:/p/my-plugin.mjs:3:51');
  assert.equal(firstFrame('Error\n    at file:///C:/p/anon.mjs:1:2'), 'file:///C:/p/anon.mjs:1:2', '无函数名的帧也认');
  // 插件里恰好有个叫 kernel 的目录，但不是 kernel/src/*.mjs ⇒ 不误判
  assert.equal(firstFrame('E\n    at f (file:///C:/kernel/my.mjs:4:1)'), 'file:///C:/kernel/my.mjs:4:1');
  assert.equal(firstFrame('Error\n    at x (node:internal/y:1:1)'), null);
  for (const v of [undefined, null, 42, {}]) assert.equal(firstFrame(v), null);
});

test('errorDetails：码 / 插件 / 源头位置 / cause 链；任何怪值都不抛', () => {
  const root = new Error('root cause');
  const env = new CordiumError(ErrorCode.ACTION_FAILED, 'wrapped', { cause: root, pluginId: 'p.x' });
  const d = errorDetails(env);
  assert.equal(d.code, 'action_failed');
  assert.equal(d.pluginId, 'p.x');
  assert.match(d.error, /^CordiumError: wrapped$/);
  assert.ok(atThisFile(d.at), `at 取最深一层（原始错误）的插件帧：${d.at}`);
  assert.equal(lineOf(d.at), lineOf(firstFrame(root.stack)));
  assert.equal(d.causes.length, 1);
  assert.match(d.causes[0].error, /^Error: root cause$/);
  assert.equal(typeof d.stack, 'string');

  const hostile = new Proxy({}, { get() { throw new Error('trap'); } });
  for (const v of [undefined, null, Symbol('s'), 'str', 7, hostile, { message: { toString() { throw 1; } } }, Object.create(null)]) {
    assert.doesNotThrow(() => errorDetails(v));
    assert.equal(typeof errorDetails(v).error, 'string');
  }
  const self = new Error('loop'); self.cause = self;
  assert.equal(errorDetails(self).causes, undefined, '自引用 cause 不重复展开');
});

test('errorDetails：深 cause 链只展开头 4 + 尾 4 层，【保留最深的原始错误】，并报省略数', () => {
  const root = new Error('the real one');
  let e = root;
  for (let i = 0; i < 10_000; i++) e = new CordiumError(ErrorCode.ACTION_FAILED, `layer ${i}`, { cause: e });
  const d = errorDetails(e);
  assert.equal(d.causes.length, 7);
  assert.equal(d.omittedCauses, 10_001 - 8);
  assert.match(d.causes.at(-1).error, /the real one/, '链尾的原始错误必须在');
  assert.ok(atThisFile(d.at));
  assert.ok(JSON.stringify(d).length < 64 * 1024, '体积有界');
});

test('errorDetails：超长栈截断', () => {
  const e = new Error('big'); e.stack = 'x'.repeat(100_000);
  assert.ok(errorDetails(e).stack.length <= 4097);
});

// ════════════════ 没有调用方的失败 ⇒ 日志自带定位 ════════════════

test('★ emit 监听器抛错：日志带插件 id、源头行号、栈（此前只有一句 message）', async () => {
  const host = new CordiumHost();
  let ctx;
  register(host, 'p.listener', { activate(c) { c.on('ev', () => { null.boom; }); } });
  register(host, 'p.emitter', { activate(c) { ctx = c; } });
  await host.boot();
  const expectedLine = lineOf(firstFrame(new Error().stack)) - 3;   // 上面 null.boom 那一行
  ctx.emit('ev');
  const entry = logs(host).find(l => /Channel listener for 'ev'/.test(l.message));
  assert.ok(entry, '必须进日志');
  assert.equal(entry.level, 'warn');
  assert.match(entry.message, /\(plugin 'p\.listener'\) threw: Cannot read properties of null/);
  assert.match(entry.message, / at file:.*error-location\.test\.mjs:\d+:\d+$/, '报文末尾带位置，扫一眼就能定位');
  assert.equal(entry.details.pluginId, 'p.listener');
  assert.ok(atThisFile(entry.details.at));
  assert.equal(lineOf(entry.details.at), expectedLine);
  assert.match(entry.details.stack, /TypeError/);
});

test('★ emit 异步监听器 reject：同样带插件 id 与位置', async () => {
  const host = new CordiumHost();
  let ctx;
  register(host, 'p.async', { activate(c) { c.on('ev', async () => { await null; throw new Error('async fail'); }); } });
  register(host, 'p.emitter', { activate(c) { ctx = c; } });
  await host.boot();
  ctx.emit('ev');
  await new Promise(r => setImmediate(r));
  const entry = logs(host).find(l => /async fail/.test(l.message));
  assert.ok(entry);
  assert.equal(entry.details.pluginId, 'p.async');
  assert.ok(atThisFile(entry.details.at));
});

test('★ 监听器归属由宿主注入：插件在 options 里冒充 owner 无效', async () => {
  const host = new CordiumHost();
  let ctx;
  register(host, 'p.liar', { activate(c) { c.on('ev', () => { throw new Error('x'); }, { owner: 'p.victim' }); } });
  register(host, 'p.emitter', { activate(c) { ctx = c; } });
  await host.boot();
  ctx.emit('ev');
  const entry = logs(host).find(l => /Channel listener/.test(l.message));
  assert.match(entry.message, /plugin 'p\.liar'/);
  assert.equal(entry.details.pluginId, 'p.liar');
});

test('★ once / watchService 的监听器出错同样归属到订阅者', async () => {
  const host = new CordiumHost();
  host.declareServiceContract('svc.w', { access: 'public' });
  let ctx;
  register(host, 'p.once', { activate(c) { c.once('ev', () => { throw new Error('once fail'); }); } });
  register(host, 'p.watch', { activate(c) { c.watchService('svc.w', () => { throw new Error('watch fail'); }); } });
  register(host, 'p.provider', { activate(c) { ctx = c; } }, { provides: ['svc.w'] });
  await host.boot();
  ctx.emit('ev');
  ctx.provideService('svc.w', { ping() { return 1; } });
  const once = logs(host).find(l => /once fail/.test(l.message));
  const watch = logs(host).find(l => /watch fail/.test(l.message));
  assert.equal(once?.details.pluginId, 'p.once');
  assert.equal(watch?.details.pluginId, 'p.watch');
});

test('★ 清理回调抛错：details.at 指向插件那一行，不是内核（entry.stack 才是记日志处）', async () => {
  const host = new CordiumHost();
  register(host, 'p.messy', { activate(c) { c.scope.addDisposer(() => { throw new Error('cleanup broke'); }); } });
  await host.boot();
  await host.deactivatePlugin('p.messy');
  const entry = errors(host).find(l => /Dispose hook of plugin 'p\.messy' threw: cleanup broke/.test(l.message));
  assert.ok(entry);
  assert.equal(entry.details.pluginId, 'p.messy');
  assert.ok(atThisFile(entry.details.at), entry.details.at);
  assert.match(entry.message, /error-location\.test\.mjs:\d+:\d+$/);
});

test('★ activate 抛错：日志带码 / 位置；抛 CordiumError 时 message 带 [码]', async () => {
  const host = new CordiumHost();
  register(host, 'p.bad', { activate() { throw new Error('activate broke'); } });
  await assert.rejects(host.boot());
  const entry = errors(host).find(l => /Plugin 'p\.bad' failed to activate: activate broke/.test(l.message));
  assert.ok(entry);
  assert.equal(entry.details.pluginId, 'p.bad');
  assert.ok(atThisFile(entry.details.at));

  const host2 = new CordiumHost({ lifecycleTimeoutMs: 20 });
  register(host2, 'p.hang', { activate: () => new Promise(() => {}) });
  await assert.rejects(host2.boot());
  const t = errors(host2).find(l => /Plugin 'p\.hang' failed to activate/.test(l.message));
  assert.match(t.message, /\[lifecycle_timeout\]/);
  assert.equal(t.details.code, 'lifecycle_timeout');
  assert.equal(t.details.pluginId, 'p.hang');
});

test('★ deactivate 抛错：warn 日志带插件 id 与位置', async () => {
  const host = new CordiumHost();
  register(host, 'p.d', { activate() {}, deactivate() { throw new Error('deactivate broke'); } });
  await host.boot();
  await host.deactivatePlugin('p.d');
  const entry = logs(host).find(l => /deactivate hook for p\.d/.test(l.message));
  assert.equal(entry.level, 'warn');
  assert.equal(entry.details.pluginId, 'p.d');
  assert.ok(atThisFile(entry.details.at));
});

test('★ 启动失败回滚：boot 日志带源头插件与码', async () => {
  const host = new CordiumHost();
  register(host, 'p.fine', { activate() {} });
  register(host, 'p.boom', { activate() { throw new CordiumError(ErrorCode.INVALID_USAGE, 'nope', { pluginId: 'p.boom' }); } }, { dependencies: { 'p.fine': '^1.0.0' } });
  await assert.rejects(host.boot());
  const entry = errors(host).find(l => /boot failed and rolled back/.test(l.message));
  assert.match(entry.message, /\[invalid_usage\]/);
  assert.equal(entry.details.code, 'invalid_usage');
  assert.equal(entry.details.pluginId, 'p.boom');
});

test('插件抛字符串 / undefined：日志照记，无位置可报时不编造', async () => {
  const host = new CordiumHost();
  let ctx;
  register(host, 'p.str', { activate(c) { c.on('a', () => { throw 'plain'; }); c.on('b', () => { throw undefined; }); } });
  register(host, 'p.e', { activate(c) { ctx = c; } });
  await host.boot();
  ctx.emit('a'); ctx.emit('b');
  const a = logs(host).find(l => /'a'/.test(l.message));
  const b = logs(host).find(l => /'b'/.test(l.message));
  assert.match(a.message, /threw: plain$/);
  assert.equal(a.details.at, undefined);
  assert.equal(a.details.pluginId, 'p.str');
  assert.match(b.message, /threw: undefined$/);
});

// ════════════════ 有调用方的失败 ⇒ 信封带归属 ════════════════

test('★ serial / waterfall：listener_failed 信封带出错监听器的插件 id', async () => {
  const host = new CordiumHost();
  let ctx;
  register(host, 'p.ok', { activate(c) { c.on('q', () => undefined); c.on('w', next => next()); } });
  register(host, 'p.fail', { activate(c) {
    c.on('q', () => { throw new Error('q fail'); });
    c.on('w', () => { throw new Error('w fail'); });
  } });
  register(host, 'p.caller', { activate(c) { ctx = c; } });
  await host.boot();
  for (const run of [() => ctx.serial('q')]) {
    const err = await run().then(() => null, e => e);
    assert.equal(err?.code, 'listener_failed');
    assert.equal(err.pluginId, 'p.fail');
    assert.match(err.message, /listener of plugin 'p\.fail' failed/);
  }
  // waterfall：p.ok 调 next() 冒上来的 p.fail 的错 ⇒ 归属是源头 p.fail，不是中间转手的 p.ok
  const w = (() => { try { ctx.waterfall('w', () => 'fallback'); } catch (e) { return e; } })();
  assert.equal(w?.code, 'listener_failed');
  assert.equal(w.pluginId, 'p.fail');
  assert.ok(atThisFile(errorDetails(w).at));
});

test('waterfall 异步：源头归属同样正确；兜底 / next 用法错仍原样送达', async () => {
  const ch = new MessageChannel();
  ch.subscribe('w', async (x, next) => next(), { owner: 'mid' });
  ch.subscribe('w', async () => { throw new Error('deep'); }, { owner: 'deep' });
  const err = await ch.waterfall('w', 1, () => 0).then(() => null, e => e);
  assert.equal(err.pluginId, 'deep');

  const ch2 = new MessageChannel();
  ch2.subscribe('w', (x, next) => next(), { owner: 'mid' });
  const own = new Error('fallback broke');
  assert.throws(() => ch2.waterfall('w', 1, () => { throw own; }), e => e === own);
});

test('MessageChannel 直接用（无宿主）：owner 未登记 ⇒ pluginId null，报文不带归属', async () => {
  const ch = new MessageChannel();
  ch.subscribe('q', () => { throw new Error('x'); });
  const err = await ch.serial('q').then(() => null, e => e);
  assert.equal(err.pluginId, null);
  assert.doesNotMatch(err.message, /of plugin/);
  const seen = [];
  ch.onListenerError = (name, e, owner) => seen.push(owner);
  ch.subscribe('e', () => { throw new Error('y'); }, { owner: 'someone' });
  ch.emit('e');
  assert.deepEqual(seen, ['someone']);
});

test('★ 服务 / 动作：调用方拿到的信封 cause 里有插件行号（端到端）', async () => {
  const host = new CordiumHost();
  host.declareServiceContract('svc.e', { access: 'public' });
  let ctx;
  register(host, 'p.svc', { activate(c) {
    c.provideService('svc.e', { run() { return JSON.parse('{oops'); } });
    c.registerAction('p.svc.act', { handler: () => { throw new Error('action broke'); } });
  } }, { provides: ['svc.e'] });
  register(host, 'p.user', { activate(c) { ctx = c; } });
  await host.boot();
  const s = (() => { try { ctx.getService('svc.e').run(); } catch (e) { return e; } })();
  assert.equal(s.code, 'service_failed');
  assert.equal(s.pluginId, 'p.svc');
  assert.ok(atThisFile(errorDetails(s).at));
  const a = await ctx.dispatchAction('p.svc.act').then(() => null, e => e);
  assert.equal(a.code, 'action_failed');
  assert.ok(atThisFile(firstFrame(a.cause.stack)));
});

test('THIS_FILE sanity', () => assert.ok(THIS_FILE.endsWith('error-location.test.mjs')));
