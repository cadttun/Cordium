/**
 * ★★ 日志出口：构造选项 `onLog` 与日志序号 `seq`。
 *
 * 口径（host.mjs 的 log / #enqueueLog / #drainLogQueue / #deliverLog）：
 *   · 每条日志带 seq：从 1 起、每记一条 +1，错误与普通日志共用一条序列；被拒的调用（非法级别）不占号；
 *   · 只增不替：环形缓冲照旧；onLog 拿到的是副本，改它不影响宿主；
 *   · 不同步回调：先排队，等当前同步代码跑完，在微任务里按 seq 顺序送；
 *   · 回调同步抛错 / 返回的 promise 被拒：进环形缓冲记一条 warn、不送回给它；连续失败只记第一次，成功一次后复位；
 *   · 回调执行期间同步记的日志只进环形缓冲、不送回（否则「收一条记一条」会无限循环）；
 *   · 送达前同步记了超过 maxLogSize 条：挤掉最旧的，补记一条 warn 报丢了几条，seq 的断处可见。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, ErrorCode } from '../src/index.mjs';

const m = (id) => ({ id, version: '1.0.0', apiVersion: '1.0.0' });
// setImmediate 在微任务清空之后：送达（以及补记的 warn）都已完成
const settle = () => new Promise(r => setImmediate(r));
const SINK_FAILED = 'onLog callback failed';
const sinkFailures = (host) => host.getDiagnostics().recentLogs.filter(l => l.level === 'warn' && l.message.startsWith(SINK_FAILED));

test('★★ 每条日志恰好送一次、按 seq 顺序；不同步回调（log() 返回时还没送）', async () => {
  const got = [];
  const host = new CordiumHost({ onLog: e => got.push(e) });
  host.log('info', 'a');
  host.log('warn', 'b');
  host.log('error', 'c', { k: 1 });
  assert.deepEqual(got, [], 'log() 返回时不得已经回调');
  await settle();
  assert.deepEqual(got.map(e => [e.seq, e.level, e.message]), [[1, 'info', 'a'], [2, 'warn', 'b'], [3, 'error', 'c']]);
  assert.deepEqual(got, host.getDiagnostics().recentLogs, '送出的就是环形缓冲里的那几条');
  assert.equal(typeof got[2].stack, 'string');

  // 插件的 ctx.log 与宿主内部的日志走同一个出口，seq 一路连续
  let ctx;
  host.registerPlugin(m('p.log'), { activate(c) { ctx = c; } });
  await host.boot();
  ctx.log('info', 'from plugin');
  await settle();
  assert.ok(got.some(e => e.message === '[p.log] from plugin'));
  assert.deepEqual(got.map(e => e.seq), got.map((_, i) => i + 1), 'seq 连续、不重不漏');
});

test('★ 交出的是副本：回调改它，宿主的记录不变', async () => {
  const host = new CordiumHost({ onLog: (e) => { e.message = 'tampered'; e.details.k = 999; } });
  host.log('info', 'orig', { k: 1 });
  await settle();
  const [rec] = host.getDiagnostics().recentLogs;
  assert.equal(rec.message, 'orig');
  assert.deepEqual(rec.details, { k: 1 });
});

test('★★ 回调同步抛错：不影响 log() 与后续送达；记一条 warn、不送回给它；连续失败只记第一次', async () => {
  let mode = 'throw';
  const got = [];
  const host = new CordiumHost({
    onLog: (e) => {
      got.push(e.message);
      if (mode === 'throw') throw new Error('sink boom');
    }
  });
  host.log('info', 'a');
  host.log('info', 'b');
  await settle();
  assert.equal(sinkFailures(host).length, 1, '连续失败只记第一次');
  assert.match(sinkFailures(host)[0].message, /sink boom/);
  mode = 'ok';
  host.log('info', 'c');
  await settle();
  mode = 'throw';
  host.log('info', 'd');
  await settle();
  assert.equal(sinkFailures(host).length, 2, '成功送达一次后复位：再失败要再记');
  assert.deepEqual(got, ['a', 'b', 'c', 'd'], '失败记录本身不送回给回调');
});

test('★★ 回调返回的 promise 被拒：接住（不出 unhandledRejection），记录口径同上', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let mode = 'reject';
    const got = [];
    const host = new CordiumHost({
      onLog: async (e) => {
        got.push(e.message);
        if (mode === 'reject') throw new Error('async sink boom');
      }
    });
    host.log('info', 'a');
    host.log('info', 'b');
    await settle();
    assert.equal(sinkFailures(host).length, 1, '连续失败只记第一次');
    assert.match(sinkFailures(host)[0].message, /async sink boom/);
    mode = 'ok';
    host.log('info', 'c');
    await settle();
    mode = 'reject';
    host.log('info', 'd');
    await settle();
    assert.equal(sinkFailures(host).length, 2, '成功送达一次后复位：再失败要再记');
    assert.deepEqual(got, ['a', 'b', 'c', 'd'], '失败记录本身不送回给回调');
    assert.deepEqual(unhandled, [], '拒绝必须被接住');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('★★ 回调执行期间同步记的日志只进环形缓冲，不送回（否则「收一条记一条」会无限循环）', async () => {
  const got = [];
  let echoes = 0;
  const host = new CordiumHost({
    onLog: (e) => {
      got.push(e.message);
      if (echoes < 3) host.log('info', `echo ${++echoes}`);
    }
  });
  host.log('info', 'original');
  await settle();
  assert.deepEqual(got, ['original']);
  assert.deepEqual(host.getDiagnostics().recentLogs.map(l => [l.seq, l.message]), [[1, 'original'], [2, 'echo 1']]);
});

test('★ 送达前同步记了超过 maxLogSize 条：挤掉最旧的，补记一条 warn 报丢了几条，seq 的断处可见', async () => {
  const got = [];
  const host = new CordiumHost({ maxLogSize: 5, onLog: e => got.push(e) });
  for (let i = 0; i < 8; i++) host.log('info', `m${i}`);
  await settle();
  assert.deepEqual(got.slice(0, 5).map(e => e.message), ['m3', 'm4', 'm5', 'm6', 'm7'], '留下的是最新的');
  assert.equal(got[5].level, 'warn');
  assert.equal(got[5].details.dropped, 3);
  assert.deepEqual(got.map(e => e.seq), [4, 5, 6, 7, 8, 9], '被挤掉的 1～3 号从 seq 的断处看得出');
});

test('★ 没有 onLog 也带 seq：错误与普通日志共用一条序列；非法级别被拒、不占号；不起任何送达', async () => {
  const host = new CordiumHost();
  host.log('info', 'a');
  host.log('error', 'b');
  assert.throws(() => host.log('nope', 'x'), { code: ErrorCode.INVALID_ARGUMENT });
  host.log('warn', 'c');
  await settle();
  const d = host.getDiagnostics();
  assert.deepEqual(d.recentLogs.map(l => l.seq), [1, 2, 3], '没有 onLog：微任务跑完也不多出任何一条');
  assert.deepEqual(d.recentErrors.map(l => l.seq), [2]);
});

test('★ onLog 必须是函数；undefined 视同不传', () => {
  for (const bad of [null, 'log', 1, {}]) {
    assert.throws(() => new CordiumHost({ onLog: bad }), { code: ErrorCode.INVALID_OPTION }, `onLog = ${String(bad)}`);
  }
  assert.doesNotThrow(() => new CordiumHost({ onLog: undefined }));
});

test('★ 内核自己的审计也走同一个出口：派发失败的那条 warn 带结构化 details', async () => {
  const got = [];
  const host = new CordiumHost({ onLog: e => got.push(e) });
  host.registerPlugin(m('p.bad'), { activate(c) { c.registerAction('act.bad', { handler: () => { throw new Error('handler boom'); } }); } });
  await host.boot();
  await assert.rejects(host.dispatchActionAsHost('act.bad'), { code: ErrorCode.ACTION_FAILED });
  await settle();
  const audit = got.find(e => e.details?.outcome === 'error');
  assert.ok(audit, '派发失败的审计要送到 onLog');
  assert.equal(audit.details.action, 'act.bad');
  assert.equal(audit.details.ownerId, 'p.bad');
});
