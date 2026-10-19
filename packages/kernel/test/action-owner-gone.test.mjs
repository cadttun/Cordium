/**
 * ★★ `action_owner_gone` 只属于【本层】：处理器跑完时，它自己注册的动作已被撤下 ⇒ 结果作废。
 *
 * 守的口径（action-registry.mjs 的 dispatch）：
 *   · 本层自己的这道检查抛出的 ⇒ 原样抛给调用方（不套信封）、只计 handled、不进审计（结果作废不是处理器的错）；
 *   · 处理器内部再派发、从内层冒上来的 action_owner_gone ⇒ 与其他内层失败同一口径：
 *     套成本层的 action_failed（cause 指向内层）、计本层 failed、按「沿 cause 链只记一次」进审计。
 *     否则外层调用方收到 action_owner_gone，会以为外层的插件被停用了；
 *   · 判据是「哪一层的检查抛的」，不是错误码，也不是「本层属主此刻还在不在」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, ErrorCode, HOST_CALLER } from '../src/index.mjs';

const m = (id) => ({ id, version: '1.0.0', apiVersion: '1.0.0' });
const tick = () => new Promise(r => setTimeout(r, 0));
const recordOf = (host, id) => host.getDiagnostics().plugins.find(p => p.id === id);
const countsOf = (host, id) => {
  const { since, ...counts } = recordOf(host, id).counters;
  return counts;
};
const errorLogsOf = host => host.getDiagnostics().recentLogs.filter(l => l.details?.outcome === 'error');
const who = l => ({ action: l.details.action, ownerId: l.details.ownerId, callerPluginId: l.details.callerPluginId });
const zero = { handled: 0, failed: 0, timedOut: 0, dispatched: 0 };

/**
 * 一条 `depth` 层的嵌套派发链，最内层在执行中途被停用：
 * `p.l0` 的处理器挂起；第 i 层（i ≥ 1）的处理器 await 第 i-1 层；最外层由宿主派发。
 * 处理器挂起期间依次停用 `stopIds`，再放行最内层，返回最外层调用方收到的错误。
 */
async function stopMidway(depth, stopIds = ['p.l0']) {
  const host = new CordiumHost();
  let release;
  host.registerPlugin(m('p.l0'), {
    activate(ctx) { ctx.registerAction('act.l0', { handler: () => new Promise(r => { release = r; }) }); }
  });
  for (let i = 1; i < depth; i++) {
    host.registerPlugin(m(`p.l${i}`), {
      activate(ctx) { ctx.registerAction(`act.l${i}`, { handler: () => ctx.dispatchAction(`act.l${i - 1}`) }); }
    });
  }
  await host.boot();
  const pending = host.dispatchActionAsHost(`act.l${depth - 1}`).catch(e => e);
  await tick();
  assert.equal(typeof release, 'function', '最内层处理器已在执行（挂起中）');
  for (const id of stopIds) await host.deactivatePlugin(id);
  release('late');
  return { host, err: await pending };
}

test('★ 本层自己的检查：处理器跑完时它的动作已被撤下 ⇒ 原样抛 action_owner_gone，只计 handled，不进审计', async () => {
  const { host, err } = await stopMidway(1);
  assert.equal(err.code, ErrorCode.ACTION_OWNER_GONE);
  assert.equal(err.cause, undefined, '★ 本层的判定不套信封');
  assert.match(err.message, /owner 'p\.l0'/);
  assert.deepEqual(countsOf(host, 'p.l0'), { ...zero, handled: 1 });
  assert.equal(errorLogsOf(host).length, 0, '★ 结果作废不是处理器的错：不记审计');
});

test('★★ 内层的 action_owner_gone 冒到外层 ⇒ 外层调用方收到外层自己的 action_failed（cause 指向内层）', async () => {
  const { host, err } = await stopMidway(2);
  assert.equal(err.code, ErrorCode.ACTION_FAILED, '★ 外层的插件好好的：不得让它的调用方以为它被停用了');
  assert.equal(err.pluginId, 'p.l1');
  assert.equal(err.cause.code, ErrorCode.ACTION_OWNER_GONE, '原因链完整：内层的判定原样留在 cause 上');
  assert.match(err.cause.message, /owner 'p\.l0'/);
  assert.equal(recordOf(host, 'p.l1').state, 'active');
});

test('★★ 计数：外层这次以失败结束 ⇒ 外层计 failed；内层结果作废 ⇒ 只计 handled', async () => {
  const { host } = await stopMidway(2);
  assert.deepEqual(countsOf(host, 'p.l1'), { ...zero, handled: 1, failed: 1, dispatched: 1 });
  assert.deepEqual(countsOf(host, 'p.l0'), { ...zero, handled: 1 });
});

test('★★ 审计：内层的作废本身不记 ⇒ 由最先把它当成失败的外层记一条 warn（码保留）', async () => {
  const { host } = await stopMidway(2);
  const logs = errorLogsOf(host);
  assert.deepEqual(logs.map(who), [{ action: 'act.l1', ownerId: 'p.l1', callerPluginId: HOST_CALLER }]);
  assert.equal(logs[0].level, 'warn');
  assert.equal(logs[0].details.code, ErrorCode.ACTION_OWNER_GONE);
});

test('★ 三层链：作废发生在最内层 ⇒ 外面两层逐层套信封、各计 failed，审计只在紧挨着它的那层记一条', async () => {
  const { host, err } = await stopMidway(3);
  assert.equal(err.code, ErrorCode.ACTION_FAILED);
  assert.equal(err.pluginId, 'p.l2');
  assert.equal(err.cause.code, ErrorCode.ACTION_FAILED);
  assert.equal(err.cause.pluginId, 'p.l1');
  assert.equal(err.cause.cause.code, ErrorCode.ACTION_OWNER_GONE);
  assert.deepEqual(countsOf(host, 'p.l2'), { ...zero, handled: 1, failed: 1, dispatched: 1 });
  assert.deepEqual(countsOf(host, 'p.l1'), { ...zero, handled: 1, failed: 1, dispatched: 1 });
  assert.deepEqual(countsOf(host, 'p.l0'), { ...zero, handled: 1 });
  assert.deepEqual(errorLogsOf(host).map(who), [{ action: 'act.l1', ownerId: 'p.l1', callerPluginId: 'p.l2' }]);
});

test('★ 内外两层都在执行中被停用 ⇒ 外层处理器以失败结束、没走到本层的检查 ⇒ 仍是 action_failed', async () => {
  const { host, err } = await stopMidway(2, ['p.l1', 'p.l0']);
  assert.equal(err.code, ErrorCode.ACTION_FAILED);
  assert.equal(err.cause.code, ErrorCode.ACTION_OWNER_GONE);
  assert.deepEqual(countsOf(host, 'p.l1'), { ...zero, handled: 1, failed: 1, dispatched: 1 });
  assert.equal(errorLogsOf(host).length, 1);
});
