/**
 * @file packages/kernel/test/service-shape.test.mjs
 * @description 服务契约的接口形状（`methods`）—— 声明期校验 + 注册期校验。
 *
 * ★ 缺陷背景：契约此前只登记访问级别。提供者拼错方法名照样注册成功，
 *   消费者调用时才拿到引擎级 `TypeError: … is not a function` —— 不带 code、不指向提供者。
 * ★ 口径：只查「列出的名字在实现上是函数」（含原型链），不查参数 / 返回值；
 *   未声明 `methods` 的契约行为零变化；句柄不收窄。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { contractInfo } from './fixtures/inspect.mjs';
import { CordiumHost } from '../src/index.mjs';

const SERVICE = 'svc.shape';

/** 宿主 + 一个 provides 了 SERVICE 的插件；provide(ctx) 决定它注册什么 */
function setup(contract, provide) {
  const host = new CordiumHost();
  host.declareServiceContract(SERVICE, { access: 'public', ...contract });
  host.registerPlugin(
    { id: 'p', version: '1.0.0', apiVersion: '1.0.0', provides: [SERVICE] },
    { activate(ctx) { provide(ctx); } }
  );
  return host;
}

// ─────────────────────────── 注册期 ───────────────────────────

test('★ 缺方法 ⇒ invalid_implementation，报文一次列全缺失项并点名提供者', async () => {
  const host = setup({ methods: ['chat', 'listModels', 'ping'] }, ctx => {
    ctx.provideService(SERVICE, { ping() { return 'pong'; } });
  });
  await assert.rejects(host.boot(), hasCode('invalid_implementation',
    /plugin 'p' cannot provide 'svc\.shape'.*'chat', 'listModels'/));
});

test('★ 门禁在写表之前：被拒后服务表没有残留，随后正确实现可注册', async () => {
  const host = new CordiumHost();
  host.declareServiceContract(SERVICE, { access: 'public', methods: ['chat'] });
  const outcome = {};
  host.registerPlugin(
    { id: 'p', version: '1.0.0', apiVersion: '1.0.0', provides: [SERVICE] },
    { activate(ctx) {
      try { ctx.provideService(SERVICE, { chta() {} }); } catch (e) { outcome.first = e; }
      assert.equal(contractInfo(host, SERVICE).providerCount, 0, '被拒的实现不得落表');
      ctx.provideService(SERVICE, { chat: () => 'ok' });
    } }
  );
  await host.boot();
  assert.ok(hasCode('invalid_implementation')(outcome.first));
  assert.equal(host.getInternalService(SERVICE).chat(), 'ok');
});

test('非对象实现（原始值 / null）⇒ 缺全部方法', async () => {
  for (const impl of [null, 42, 'chat']) {
    const host = setup({ methods: ['chat'] }, ctx => ctx.provideService(SERVICE, impl));
    await assert.rejects(host.boot(), hasCode('invalid_implementation', /'chat'/), `impl=${String(impl)}`);
  }
});

test('同名属性但不是函数 ⇒ 视为缺失', async () => {
  const host = setup({ methods: ['chat'] }, ctx => ctx.provideService(SERVICE, { chat: 'not a function' }));
  await assert.rejects(host.boot(), hasCode('invalid_implementation', /'chat'/));
});

test('★ 类实例（方法在原型上）⇒ 通过 —— 不得按自有属性误拒', async () => {
  class Impl { chat() { return 'from-proto'; } }
  const host = setup({ methods: ['chat'] }, ctx => ctx.provideService(SERVICE, new Impl()));
  await host.boot();
  assert.equal(host.getInternalService(SERVICE).chat(), 'from-proto');
});

test('函数本身作为实现：按其属性查', async () => {
  const fn = Object.assign(() => 0, { chat: () => 'fn-chat' });
  const host = setup({ methods: ['chat'] }, ctx => ctx.provideService(SERVICE, fn));
  await host.boot();
  assert.equal(host.getInternalService(SERVICE).chat(), 'fn-chat');
});

test('★ 作用域实现同一判定', async () => {
  const host = setup({ methods: ['chat'] }, ctx => ctx.scoped('agent:a').provideService(SERVICE, { nope() {} }));
  await assert.rejects(host.boot(), hasCode('invalid_implementation', /'chat'/));
});

test('★ 回归：未声明 methods 的契约，任意实现照旧通过', async () => {
  const host = setup({}, ctx => ctx.provideService(SERVICE, { whatever() { return 1; } }));
  await host.boot();
  assert.equal(host.getInternalService(SERVICE).whatever(), 1);
  assert.equal(contractInfo(host, SERVICE).methods, null);
});

test('句柄不收窄 —— 契约外的方法照样可调', async () => {
  const host = setup({ methods: ['chat'] }, ctx => ctx.provideService(SERVICE, { chat: () => 'c', extra: () => 'e' }));
  await host.boot();
  assert.equal(host.getInternalService(SERVICE).extra(), 'e');
});

// ─────────────────────────── 声明期 ───────────────────────────

test('★ 声明期：methods 写错 ⇒ invalid_contract，且契约不落表', () => {
  for (const bad of ['chat', 1, {}, [''], [1], ['a', 'a']]) {
    const host = new CordiumHost();
    assert.throws(() => host.declareServiceContract(SERVICE, { methods: bad }),
      hasCode('invalid_contract', /declares invalid methods/), `methods=${JSON.stringify(bad)}`);
    assert.equal(contractInfo(host, SERVICE), undefined, '写错的契约不得落表');
  }
});

test('方法名精确匹配：不 trim —— `\' chat\'` 与 `\'chat\'` 是两个名字', async () => {
  const host = setup({ methods: [' chat'] }, ctx => ctx.provideService(SERVICE, { chat() {} }));
  await assert.rejects(host.boot(), hasCode('invalid_implementation', /' chat'/));
});

test('诊断如实展示 methods，且是只读快照', () => {
  const host = new CordiumHost();
  const declared = ['chat', 'listModels'];
  host.declareServiceContract(SERVICE, { access: 'public', methods: declared });
  declared.push('late');   // 声明后改调用方手里的数组 ⇒ 不得影响契约
  const info = contractInfo(host, SERVICE);
  assert.deepEqual(info.methods, ['chat', 'listModels']);
  info.methods.push('tampered');
  assert.deepEqual(contractInfo(host, SERVICE).methods, ['chat', 'listModels'], '诊断是快照，改它不改契约');
});

test('methods 不是被丢弃字段：不产生 service-contract 诊断', () => {
  const host = new CordiumHost();
  host.declareServiceContract(SERVICE, { access: 'public', methods: ['chat'] });
  assert.equal(host.getDiagnostics().manifestDiagnostics?.some?.(d => d.path === 'service-contract') ?? false, false);
});

// ─────────────────────────── 句柄只读 / 访问器 ───────────────────────────

/** 宿主 + 提供者 p + 两个消费者 a / b（public 契约，无 methods） */
async function twoConsumers(impl) {
  const host = new CordiumHost();
  host.declareServiceContract(SERVICE, { access: 'public' });
  host.registerPlugin({ id: 'p', version: '1.0.0', apiVersion: '1.0.0', provides: [SERVICE] },
    { activate(ctx) { ctx.provideService(SERVICE, impl); } });
  const ctxs = {};
  for (const id of ['a', 'b']) {
    host.registerPlugin({ id, version: '1.0.0', apiVersion: '1.0.0' }, { activate(ctx) { ctxs[id] = ctx; } });
  }
  await host.boot();
  return { host, a: ctxs.a.getService(SERVICE), b: ctxs.b.getService(SERVICE) };
}

test('★ 句柄只读：写 / 删 / 定义 / 改原型一律 access_denied，其他消费者不受影响', async () => {
  const { host, a, b } = await twoConsumers({ ping() { return 'pong'; } });
  assert.throws(() => { a.ping = () => 'HIJACKED'; }, hasCode('access_denied'));
  assert.throws(() => { delete a.ping; }, hasCode('access_denied'));
  assert.throws(() => Object.defineProperty(a, 'ping', { value: () => 'x' }), hasCode('access_denied'));
  assert.throws(() => Object.setPrototypeOf(a, null), hasCode('access_denied'));
  assert.throws(() => Object.freeze(a), hasCode('access_denied'));
  assert.equal(b.ping(), 'pong', '另一个消费者拿到的仍是原方法');
  assert.equal(host.getInternalService(SERVICE).ping(), 'pong', '宿主装配路径同样未被改写');
});

test('★ 声明为方法的访问器（getter）注册时即拒 —— 不得先放行、后变脸', async () => {
  let n = 0;
  const host = setup({ methods: ['ping'] }, ctx => {
    ctx.provideService(SERVICE, { get ping() { return n++ === 0 ? () => 1 : undefined; } });
  });
  await assert.rejects(host.boot(), hasCode('invalid_implementation', /'ping'/));
});

test('原型链上的访问器同样拒；普通类方法照旧通过', async () => {
  class Getter { get ping() { return () => 1; } }
  const bad = setup({ methods: ['ping'] }, ctx => ctx.provideService(SERVICE, new Getter()));
  await assert.rejects(bad.boot(), hasCode('invalid_implementation'));
  class Plain { ping() { return 1; } }
  const ok = setup({ methods: ['ping'] }, ctx => ctx.provideService(SERVICE, new Plain()));
  await ok.boot();
  assert.equal(ok.getInternalService(SERVICE).ping(), 1);
});

test('★ 未声明 methods 时，方法中途不再是函数 ⇒ 句柄调用抛 invalid_implementation（不是裸 TypeError）', async () => {
  const impl = { ping() { return 'pong'; } };
  const { a } = await twoConsumers(impl);
  const call = a.ping;           // 先取到包装函数
  delete impl.ping;              // 提供者自己删掉（消费者删不了，见上面句柄只读）
  assert.throws(() => call(), hasCode('invalid_implementation', /'ping'/));
});
