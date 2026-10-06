/**
 * @file packages/kernel/test/input-validation.test.mjs
 * @description 公开入口的错类型输入一律给带码的 CordiumError，不漏引擎级 TypeError。
 *
 * 实测漏网的两类：
 *   · 按 id / 服务名取东西的方法收到 symbol / 无原型对象 ⇒ 拼报文时 `${x}` 抛 TypeError；
 *   · 构造 / 声明时的选项传 null ⇒ 解构 null 抛 TypeError。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, CordiumError } from '../src/index.mjs';
import { describeValue } from '../src/internal.mjs';
import { hasCode } from './fixtures/errors.mjs';

const WEIRD = [Symbol('s'), Object.create(null), 42, null, undefined, {}, []];


test('宿主按 id / 服务名的公开方法：非字符串 ⇒ invalid_argument', async () => {
  const host = new CordiumHost();
  for (const v of WEIRD) {
    const label = describeValue(v);
    for (const [name, call] of [
      ['activatePlugin', () => host.activatePlugin(v)],
      ['deactivatePlugin', () => host.deactivatePlugin(v)],
      ['unregisterPlugin', () => host.unregisterPlugin(v)],
      ['getService', () => host.getService(v, 'plugin.x')],
      ['getInternalService', () => host.getInternalService(v)]
    ]) {
      assert.throws(call, err => err instanceof CordiumError && err.code === 'invalid_argument', `${name}(${label})`);
    }
  }
});

test('声明服务契约：无原型对象 / symbol 作名 ⇒ invalid_contract（不是 TypeError）', () => {
  const host = new CordiumHost();
  for (const v of [Symbol('s'), Object.create(null)]) {
    assert.throws(() => host.declareServiceContract(v), err => err instanceof CordiumError && err.code === 'invalid_contract');
  }
});

test('new CordiumHost(null) 视同不传选项', () => {
  assert.equal(new CordiumHost(null).defaultActionTimeoutMs, new CordiumHost().defaultActionTimeoutMs);
});

test('describeValue：任何值都能渲染，不抛', () => {
  for (const v of [...WEIRD, () => 1, new Proxy({}, {})]) assert.equal(typeof describeValue(v), 'string');
  assert.equal(describeValue(Object.create(null)), '[object Object]');
  assert.equal(describeValue(Symbol('s')), 'Symbol(s)');
});

// ── 第三方代码抛出 / 交来的「怪值」不得在宿主的错误路径上再炸 ──
const THROWN = [undefined, null, Symbol('t'), 42, Object.create(null), { get message() { throw new Error('getter'); } }];

test('★ 清理回调 / 停用钩子抛任意值：停用照常走完（后续 disposer 仍执行，状态到 disabled），错误进日志', async () => {
  for (const thrown of THROWN) {
    const host = new CordiumHost();
    let ctx;
    host.registerPlugin({ id: 'p.a', version: '1.0.0', apiVersion: '1.0.0' }, { activate(c) { ctx = c; }, deactivate() { throw thrown; } });
    await host.boot();
    let earlier = 0;
    ctx.scope.addDisposer(() => { earlier += 1; });
    ctx.scope.addDisposer(() => { throw thrown; });
    await host.deactivatePlugin('p.a');
    const d = host.getDiagnostics();
    assert.equal(d.plugins[0].state, 'disabled', describeValue(thrown));
    assert.equal(earlier, 1, `${describeValue(thrown)}：抛错的清理回调之后的回调必须照跑（否则监听器泄漏）`);
    assert.ok(d.recentErrors.some(e => /Dispose hook/.test(e.message)));
  }
});

test('★ activate 抛任意值：boot 回滚并原样抛出该值，诊断里 error 是字符串', async () => {
  for (const thrown of THROWN) {
    const host = new CordiumHost();
    host.registerPlugin({ id: 'p.a', version: '1.0.0', apiVersion: '1.0.0' }, { activate() { throw thrown; } });
    await assert.rejects(host.boot(), e => e === thrown);
    const d = host.getDiagnostics();
    assert.equal(d.plugins[0].state, 'failed');
    assert.equal(typeof d.plugins[0].error, 'string', describeValue(thrown));
  }
});

test('★ log 的 message：symbol / 对象一律存成字符串（不抛、不存活引用）', async () => {
  const host = new CordiumHost();
  let ctx;
  host.registerPlugin({ id: 'p.a', version: '1.0.0', apiVersion: '1.0.0' }, { activate(c) { ctx = c; } });
  await host.boot();
  ctx.log('info', Symbol('s'));
  const obj = { toString: () => 'before' };
  host.log('info', obj);
  obj.toString = () => 'after';
  const logs = host.getDiagnostics().recentLogs.slice(-2).map(e => e.message);
  assert.deepEqual(logs, ['[p.a] Symbol(s)', 'before']);
});

test('★ manifest 是抛错的 getter / Proxy，或 getter 每次读都变 ⇒ invalid_manifest，且只按读到的那一份校验', async () => {
  const host = new CordiumHost();
  const base = { id: 'p.g', version: '1.0.0', apiVersion: '1.0.0' };
  assert.throws(() => host.registerPlugin({ ...base, get apiVersion() { throw new Error('g'); } }), hasCode('invalid_manifest', /could not be read/));
  assert.throws(() => host.registerPlugin(new Proxy(base, { ownKeys() { throw new Error('k'); } })), hasCode('invalid_manifest'));
  const trap = () => { throw new Error('trap'); };
  assert.throws(() => host.registerPlugin({ ...base, provides: new Proxy([], { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap }) }),
    hasCode('invalid_manifest', /malformed/), '字段值是抛错的 Proxy ⇒ 同样带码');
  let reads = 0;
  host.registerPlugin({ version: '1.0.0', apiVersion: '1.0.0', get id() { reads += 1; return reads === 1 ? 'p.ok' : 'BAD ID'; } });
  assert.deepEqual(host.getDiagnostics().plugins.map(p => p.id), ['p.ok'], '先查后用：校验与登记用的是同一次读取');
});

test('★ 契约声明了 methods，实现是查方法就抛错的 Proxy ⇒ invalid_implementation', async () => {
  const host = new CordiumHost();
  host.declareServiceContract('svc.x', { access: 'public', methods: ['m'] });
  let ctx;
  host.registerPlugin({ id: 'p.a', version: '1.0.0', apiVersion: '1.0.0', provides: ['svc.x'] }, { activate(c) { ctx = c; } });
  await host.boot();
  const trap = () => { throw new Error('trap'); };
  assert.throws(() => ctx.provideService('svc.x', new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap })),
    hasCode('invalid_implementation', /trap/));
});

// ════════════════════════════════════════════════════════════════════════════
// ★★ registerAction 的选项：白名单 + 类型门
//    此前**两处 fail-open**，都是「静默」形态 —— 不报错、不崩，只是门悄悄没了：
//      ① 裸解构 ⇒ 未知键被静默丢弃：`requiredPermission` 拼错 = **权限门直接消失**；
//         `timeoutMs` 拼成 `timeout` = 静默回退宿主默认 30s；
//      ② `if (requiredPermission)` + `|| null` ⇒ '' / 0 / false 落成「无门」。
//    ★ 白名单口径取自本仓自己的分界线（`host-util.mjs` readOptions 注释 +
//      `host.mjs` declareServiceContract 那段自述）：**选项袋硬拒、声明式字段表才丢弃+诊断**。
//      `registerAction` 的第三参是纯选项袋 ⇒ 与 CordiumHost 构造 / registerPlugin / replacePlugin 同族。
// ════════════════════════════════════════════════════════════════════════════

/** 起一个宿主，在 activate 里注册一个动作，返回它抛的错（不抛则 null）。 */
async function tryRegisterAction(options) {
  const host = new CordiumHost();
  host.declarePermissions(['perm.ok']);
  let caught = null;
  host.registerPlugin(
    { id: 'p.reg', version: '1.0.0', apiVersion: '1.0.0', permissions: ['perm.ok'] },
    { activate(ctx) { try { ctx.registerAction('a.x', options); } catch (err) { caught = err; } } }
  );
  await host.boot();
  return caught;
}

test('★ registerAction 未知选项键 ⇒ invalid_option（此前静默丢弃：拼错 requiredPermission = 权限门消失）', async () => {
  for (const [label, options] of [
    ['未知键', { handler: () => 1, bogus: 1 }],
    ['requiredPermission 拼错', { handler: () => 1, requirdPermission: 'perm.ok' }],
    ['timeoutMs 拼成 timeout', { handler: () => 1, timeout: 5 }]
  ]) {
    const err = await tryRegisterAction(options);
    assert.equal(err?.code, 'invalid_option', `${label}：必须响亮失败，不能静默丢键`);
    assert.match(err.message, /unknown option\(s\)/, label);
  }
});

test('★ registerAction 的 requiredPermission 假值 / 非字符串 ⇒ invalid_argument（此前静默无门）', async () => {
  for (const v of ['', 0, false, null, 123, {}, []]) {
    const err = await tryRegisterAction({ handler: () => 1, requiredPermission: v });
    assert.equal(err?.code, 'invalid_argument', `requiredPermission = ${describeValue(v)} 必须被拒，不能悄悄变成「无门」`);
    assert.match(err.message, /requiredPermission must be a non-empty string/, describeValue(v));
  }
});

test('★ registerAction 正向对照：不写 requiredPermission 仍是「无门」、写了合法值仍生效（证明不是「什么都不让过」）', async () => {
  // ① 不写 ⇒ 无门放行
  const open = await tryRegisterAction({ handler: () => 1 });
  assert.equal(open, null, '不写 requiredPermission = 无门，必须注册成功');

  // ② 写了已声明的 ⇒ 注册成功，且**门真的生效**（无权限的调用方被拒）
  const host = new CordiumHost();
  host.declarePermissions(['perm.ok']);
  host.registerPlugin(
    { id: 'p.owner', version: '1.0.0', apiVersion: '1.0.0', permissions: ['perm.ok'] },
    { activate(ctx) { ctx.registerAction('a.gated', { requiredPermission: 'perm.ok', handler: () => 'secret' }); } }
  );
  host.registerPlugin(
    { id: 'p.without', version: '1.0.0', apiVersion: '1.0.0' },
    { activate() {} }
  );
  await host.boot();
  await assert.rejects(host.dispatchAction('p.without', 'a.gated'), hasCode('access_denied'),
    '★ 门必须真的生效 —— 只断言「注册成功」不足以证明门还在');

  // ③ 未声明的权限名 ⇒ 仍是 undeclared_permission（既有码不变）
  const undeclared = await tryRegisterAction({ handler: () => 1, requiredPermission: 'perm.nope' });
  assert.equal(undeclared?.code, 'undeclared_permission');
});

test('describeError：任何被抛出的值都给出一句话，自身绝不抛', async () => {
  const { describeError } = await import('../src/internal.mjs');
  assert.equal(describeError(new Error('m')), 'm');
  assert.equal(describeError(undefined), 'undefined');
  assert.equal(describeError(null), 'null');
  assert.equal(describeError(Symbol('s')), 'Symbol(s)');
  assert.equal(describeError(42), '42', '数字不是「undefined」（没有 message 就描述值本身）');
  assert.equal(describeError({ code: 'x' }), '[object Object]');
  assert.equal(describeError(Object.create(null)), '[object Object]');
  assert.equal(describeError({ get message() { throw new Error('g'); } }), '[object Object]');
  assert.equal(describeError({ message: Symbol('m') }), 'Symbol(m)');
});
