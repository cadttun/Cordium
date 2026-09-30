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
