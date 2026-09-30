/**
 * @file packages/kernel/test/handle-cache-and-error-log.test.mjs
 * @description 回归门禁：服务句柄缓存 / 诊断留存 / ctx.ui 暴露面
 *
 * ── 守的三件事（均由实测驱动）──────────
 *   ① `wrapServiceHandle` 每次取方法都新建闭包 ⇒ 加**按句柄**的缓存
 *   ② 审计缓冲是共享环形，话多的 info 能把「出过事」冲掉 ⇒ 错误单独留存 + 带栈
 *   ③ `ctx.ui` 交出活注册表 ⇒ 收回（后来 ctx.ui 整体移除）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost } from '../src/index.mjs';

const SERVICE = 'service.demo';
const m = (id) => ({ id, version: '1.0.0', apiVersion: '1.0.0' });

// ═════════════════════ ① 句柄包装函数的缓存 ═════════════════════

function makeHandleHost() {
  const host = new CordiumHost();
  host.declareServiceContracts({ [SERVICE]: { access: 'public' } });
  host.registerPlugin(
    { id: 'plugin.p', version: '1.0.0', apiVersion: '1.0.0', provides: [SERVICE] },
    { async activate(ctx) { ctx.provideService(SERVICE, { ping: () => 'pong' }); } }
  );
  return host;
}

test('★ 句柄的方法标识必须稳定（不再每次取属性都新建闭包）', async () => {
  const host = makeHandleHost();
  let handle = null;
  host.registerPlugin(
    { id: 'plugin.c', version: '1.0.0', apiVersion: '1.0.0', dependencies: { 'plugin.p': '^1.0.0' } },
    { async activate(ctx) { handle = ctx.getService(SERVICE); } }
  );
  await host.boot();

  assert.equal(handle.ping, handle.ping, '同一个句柄上重复取同一方法必须拿到同一个函数（缓存生效）');
  assert.equal(handle.ping(), 'pong', '缓存不得改变行为');
});

test('★★ 缓存必须【按句柄】—— 两个消费者各持句柄时，绝不能共用同一个 check', async () => {
  // 这是本项最危险的陷阱：同一个实现对象会被多个句柄包着，
  // 而每个句柄的 check 闭包捕获的 callerPluginId 各不相同。
  // 若缓存按 target 全局共享，先建的那个 check 会串给所有人 ——
  // 于是 B 的句柄按 A 的身份判失效，且不会有任何报错。
  const host = makeHandleHost();
  const got = {};
  const mk = (id, key) => ({
    manifest: { id, version: '1.0.0', apiVersion: '1.0.0', dependencies: { 'plugin.p': '^1.0.0' } },
    entry: { async activate(ctx) { got[key] = ctx.getService(SERVICE); } }
  });
  const a = mk('plugin.a', 'a');
  const b = mk('plugin.b', 'b');
  host.registerPlugin(a.manifest, a.entry);
  host.registerPlugin(b.manifest, b.entry);
  await host.boot();

  assert.equal(got.a.ping(), 'pong');
  assert.equal(got.b.ping(), 'pong');

  // 停用 A ⇒ 只有 A 的句柄该失效
  await host.deactivatePlugin('plugin.a');
  assert.throws(() => got.a.ping(), err => err.code === 'service_unavailable', 'A 的句柄必须失效');
  assert.equal(got.b.ping(), 'pong', '★ B 的句柄必须照常可用 —— 共用缓存会让它误判失效');
});

test('★ 缓存不得冻结方法绑定（实现方换掉方法，句柄要调用新的那个）', async () => {
  // 用【干净宿主】：makeHandleHost() 已经注册了 plugin.p 提供同一个服务，
  // 直接再加一个提供者会撞名（「一个名字一个提供者」）—— 这里不需要那两个。
  const host = new CordiumHost();
  host.declareServiceContracts({ [SERVICE]: { access: 'public' } });
  const impl = { who: () => 'v1' };
  let handle = null;
  host.registerPlugin(
    { id: 'plugin.p2', version: '1.0.0', apiVersion: '1.0.0', provides: [SERVICE] },
    { async activate(ctx) { ctx.provideService(SERVICE, impl); } }
  );
  host.registerPlugin(
    { id: 'plugin.c2', version: '1.0.0', apiVersion: '1.0.0', dependencies: { 'plugin.p2': '^1.0.0' } },
    { async activate(ctx) { handle = ctx.getService(SERVICE); } }
  );
  await host.boot();

  assert.equal(handle.who(), 'v1');
  impl.who = () => 'v2';           // 实现方原地换方法
  assert.equal(handle.who(), 'v2',
    '★ 缓存只缓存包装壳，调用时必须【重新读】target[prop] —— 否则实现方换方法后句柄一直调旧的');
});

// ═════════════════════ ② 诊断留存 ═════════════════════

test('★★ 错误必须【不被 info 冲掉】（共享环形缓冲的真问题）', () => {
  const host = new CordiumHost({ maxLogSize: 5, maxErrorLogSize: 3 });
  host.log('error', '这是一条关键错误');
  for (let i = 0; i < 20; i++) host.log('info', `噪音 ${i}`);

  const recent = host.getDiagnostics().recentLogs.map(l => l.message);
  assert.ok(!recent.includes('这是一条关键错误'), '前置条件：共享环形里它确实被冲掉了（这正是问题所在）');

  const errors = host.getDiagnostics().recentErrors.map(l => l.message);
  assert.deepEqual(errors, ['这是一条关键错误'],
    '★ 错误有独立留存 —— 否则「出过事」会从诊断里凭空消失，而那是不可再生的证据');
});

test('★ 错误日志必须带栈（排查时「哪一行」比「什么错」值钱）', () => {
  const host = new CordiumHost();
  host.log('error', '带栈的错误');
  host.log('info', '普通日志');

  const errEntry = host.getDiagnostics().recentErrors[0];
  assert.ok(typeof errEntry.stack === 'string' && errEntry.stack.length > 0, '错误条目必须带 stack');
  assert.ok(!host.getDiagnostics().recentLogs[1].stack, 'info 不该付抓栈的代价');
});

test('★ 错误留存自身也有上限（不得无限增长）', () => {
  const host = new CordiumHost({ maxErrorLogSize: 3 });
  for (let i = 0; i < 10; i++) host.log('error', `错误 ${i}`);
  assert.equal(host.getDiagnostics().errorLogCount, 3, '错误留存必须封顶');
  assert.equal(host.getDiagnostics().recentErrors.at(-1).message, '错误 9', '保留的是最近的');
});

// ═════════════════════ ③ ctx.ui 暴露面 ═════════════════════
// ★ ctx.ui / bindUIHost 已整体移除（照搬上层应用 UI 包的接口形状，见 design/removed-apis.md）。
//   原先三条用例守的是「ctx.ui 不交出活注册表 / 宿主注入 scope / 停用后拒绝」—— 能力不存在，侧门也就不存在。

test('★ 内核不再提供 ctx.ui / bindUIHost（UI 能力应由上层声明为服务契约）', async () => {
  const host = new CordiumHost();
  let ctxRef = null;
  host.registerPlugin(m('plugin.ui.consumer'), { async activate(ctx) { ctxRef = ctx; } });
  await host.boot();
  assert.equal('ui' in ctxRef, false);
  assert.equal(typeof host.bindUIHost, 'undefined');
  // ★ registerUI 改名 registerUIContribution（与 getUIContributions 同一名词）
  assert.equal(typeof ctxRef.registerUIContribution, 'function', '通用 UI 贡献入口（带查重与所有权）保留');
  assert.equal('registerUI' in ctxRef, false, '旧名不得残留（无兼容负担，一步改到位）');
});
