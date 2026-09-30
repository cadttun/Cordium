/**
 * @file packages/kernel/test/long-running.test.mjs
 * @description 长时间运行：常驻插件反复做同一件事，宿主内部表不得随次数增长。
 *
 * 判据用【宿主可观察的结构】（诊断 / 引用计数行为）而不是堆大小 —— 堆受 GC 时机影响，测试会抖。
 *   · 反复 privateScope().provideService：此前每次在契约里留一条永不删除的代次记录；
 *   · 反复 scoped(同名)：此前每次给作用域引用计数 +1、往 scope 挂一个 disposer；
 *   · ctx.log 超大 details：此前逐条深克隆（卡事件循环）且常驻在 500 槽缓冲里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost } from '../src/index.mjs';
import { LOG_DETAILS_BUDGET } from '../src/host-util.mjs';

const m = (id, extra = {}) => ({ id, version: '1.0.0', apiVersion: '1.0.0', ...extra });

/** 常驻插件；返回的对象 .ctx 总是【当前这次激活】的 ctx */
async function residentPlugin(host, extra) {
  const live = { ctx: null };
  host.registerPlugin(m('plugin.resident', extra), { activate(c) { live.ctx = c; } });
  await host.boot();
  return live;
}

test('反复 scoped(同名)：同一激活只登记一次（停用时一次释放就回收），旧句柄语义不变', async () => {
  const host = new CordiumHost();
  const { ctx } = await residentPlugin(host);
  const seen = [];
  ctx.scoped('agent');
  const disposers = ctx.scope.disposers.size;
  for (let i = 0; i < 1000; i++) ctx.scoped('agent').on('evt', v => seen.push(v))();
  assert.equal(ctx.scope.disposers.size, disposers, '★ 重复 scoped(同名) 不得每次往 scope 挂新 disposer');
  const a = ctx.scoped('agent');
  a.on('evt', v => seen.push(v));
  a.emit('evt', 1);
  ctx.scoped('agent').emit('evt', 2);            // 复用的键：同一个作用域
  assert.deepEqual(seen, [1, 2]);
  const scopes = () => host.getDiagnostics().channel.scopes.filter(s => s.key === 'agent').length;
  assert.equal(scopes(), 1);
  await host.deactivatePlugin('plugin.resident');
  assert.equal(scopes(), 0, '★ 停用后作用域必须回收 —— 若每次 scoped() 都 +1 计数而只释放一次，这里会残留');
  assert.throws(() => ctx.scoped('agent'), err => err.code === 'scope_disposed', '已登记过的 label 走复用路径，同样过生命周期门');
});

test('反复在 privateScope 里提供 / 撤销服务：旧句柄照样失效，重新注册代次单调', async () => {
  const host = new CordiumHost();
  host.declareServiceContracts({ 'svc.r': { access: 'public' } });
  const live = await residentPlugin(host, { provides: ['svc.r'] });
  const ctx = live.ctx;
  const epochs = [];
  ctx.watchService('svc.r', c => { if (c.action === 'registered') epochs.push(c.epoch); });
  for (let i = 0; i < 50; i++) ctx.privateScope().provideService('svc.r', { v: () => i });
  assert.deepEqual(epochs, Array.from({ length: 50 }, (_, i) => i + 1), '代次契约级单调，永不复用');

  // 全局槽：注销后重新注册 ⇒ 旧句柄不得复活
  ctx.provideService('svc.r', { v: () => 'first' });
  const old = ctx.getService('svc.r');
  await host.deactivatePlugin('plugin.resident');
  await host.activatePlugin('plugin.resident');
  live.ctx.provideService('svc.r', { v: () => 'second' });
  assert.throws(() => old.v(), err => err.code === 'service_unavailable');
  assert.equal(live.ctx.getService('svc.r').v(), 'second');
});

test('ctx.log 超大 details：换成截断标记（不深克隆、不常驻）；预算内照常快照', async () => {
  const host = new CordiumHost();
  const { ctx } = await residentPlugin(host);
  const last = () => host.getDiagnostics().recentLogs.at(-1).details;

  ctx.log('info', 'big-array', { rows: new Array(LOG_DETAILS_BUDGET.nodes + 1).fill(0) });
  assert.equal(last().truncated, true);
  ctx.log('info', 'big-string', { s: 'x'.repeat(LOG_DETAILS_BUDGET.bytes + 1) });
  assert.equal(last().truncated, true);
  ctx.log('info', 'big-binary', { buf: new ArrayBuffer(LOG_DETAILS_BUDGET.bytes + 1) });
  assert.equal(last().truncated, true, '二进制按字节计（只有 1 个节点，不会被节点数挡住）');
  // ★ 视图按【底层整块 buffer】计：structuredClone 会复制整块 ArrayBuffer（此前只算视图的 byteLength，
  //   4 字节视图挂 2MB buffer 能过预算，快照却复制了整块）
  const head = new Uint8Array(new ArrayBuffer(LOG_DETAILS_BUDGET.bytes * 2), 0, 4);
  ctx.log('info', 'small-view-big-buffer', { head });
  assert.equal(last().truncated, true, '小视图挂大 buffer：按底层 buffer 计');
  const shared = new ArrayBuffer(LOG_DETAILS_BUDGET.bytes / 2 + 1);
  ctx.log('info', 'same-buffer-twice', { a: new Uint8Array(shared), b: new Uint8Array(shared) });
  assert.equal(last().truncated, undefined, '同一 buffer 的多个视图只计一次');
  ctx.log('info', 'big-map', new Map(Array.from({ length: LOG_DETAILS_BUDGET.nodes + 1 }, (_, i) => [i, i])));
  assert.equal(last().truncated, true);
  const wide = {};
  for (let i = 0; i <= LOG_DETAILS_BUDGET.nodes; i++) wide['k' + i] = i;
  ctx.log('info', 'wide-object', wide);
  assert.equal(last().truncated, true);

  const small = { rows: new Array(100).fill(1), m: new Map([[1, 2]]) };
  ctx.log('info', 'small', small);
  assert.deepEqual(last(), small, '预算内：原样快照');
  const cyclic = { a: 1 }; cyclic.self = cyclic;
  ctx.log('info', 'cyclic', cyclic);
  assert.equal(last().a, 1, '环引用：有界遍历不死循环，快照照常');
});
