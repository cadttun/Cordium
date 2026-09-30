/**
 * @file packages/plugins/test/isolation.test.mjs
 * @description 最小可用版：callIsolated（worker 故障隔离 / process + 权限模型）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hasCode } from './fixtures/errors.mjs';
import { callIsolated } from '../src/isolation.mjs';

const TARGET = fileURLToPath(new URL('./fixtures/isolated/targets.mjs', import.meta.url));
const OUTSIDE = fileURLToPath(new URL('../package.json', import.meta.url));   // 目标模块目录之外

for (const mode of ['worker', 'process']) {
  test(`${mode}：正常调用（同步 / 异步 / default 导出）`, async () => {
    assert.equal(await callIsolated(TARGET, 'add', [1, 2], { mode }), 3);
    assert.equal(await callIsolated(TARGET, 'later', ['x'], { mode }), 'x');
    assert.equal(await callIsolated(TARGET, undefined, ['c'], { mode }), 'hello c');
  });

  test(`${mode} ★ 同步死循环被超时真正打断（callWithTimeout 做不到）`, async () => {
    const started = Date.now();
    await assert.rejects(callIsolated(TARGET, 'spin', [], { mode, timeoutMs: 300, pluginId: 'hog' }), hasCode('call_timeout', /hog/));
    assert.ok(Date.now() - started < 5000, '超时后必须及时返回，宿主事件循环没被占住');
  });

  test(`${mode}：插件抛错 ⇒ isolated_call_failed，原错误名 / code 进报文`, async () => {
    await assert.rejects(callIsolated(TARGET, 'boom', [], { mode }), hasCode('isolated_call_failed', /boom.*plugin_boom|plugin_boom.*boom/));
    await assert.rejects(callIsolated(TARGET, 'notAFunction', [], { mode }), hasCode('isolated_call_failed', /not a function/));
    await assert.rejects(callIsolated(TARGET, 'giveFunction', [], { mode }), hasCode('isolated_call_failed', /result_not_cloneable|DataClone/));
  });
}

test('★ process：默认禁读目标模块目录之外的文件；显式 allowFsRead 后放行', async () => {
  await assert.rejects(callIsolated(TARGET, 'readFile', [OUTSIDE], { mode: 'process' }), hasCode('isolated_call_failed', /ERR_ACCESS_DENIED/));
  const n = await callIsolated(TARGET, 'readFile', [OUTSIDE], { mode: 'process', allowFsRead: [path.dirname(OUTSIDE)] });
  assert.ok(n > 0);
});

test('worker 档不限制文件系统（它只管故障隔离，文档如实写明）', async () => {
  assert.ok(await callIsolated(TARGET, 'readFile', [OUTSIDE], { mode: 'worker' }) > 0);
});

test('入参校验在起隔离环境之前（fail-loud，零副作用）', async () => {
  await assert.rejects(callIsolated('./relative.mjs', 'add'), hasCode('invalid_argument'));
  await assert.rejects(callIsolated(TARGET, 'add', 'nope'), hasCode('invalid_argument'));
  await assert.rejects(callIsolated(TARGET, 'add', [], { mode: 'vm' }), hasCode('invalid_argument'));
  await assert.rejects(callIsolated(TARGET, 'add', [], { timeoutMs: Infinity }), hasCode('invalid_timeout'));
  await assert.rejects(callIsolated(TARGET, 'add', [() => 1]), hasCode('invalid_argument', /cloneable/));
  await assert.rejects(callIsolated(TARGET, 'add', [], { mode: 'process', allowFsRead: ['rel'] }), hasCode('invalid_argument'));
});

// ── process 档此前走 fork 默认的 JSON 序列化 —— 与 worker 档语义不一致 ──
test('★ worker / process 同一传值语义（结构化克隆）：Map / TypedArray / Date / BigInt / undefined 原样到达', async () => {
  const args = [new Map([[1, 2]]), new Uint8Array(3), new Date(0), 10n, undefined];
  const expected = ['[object Map]:1', '[object Uint8Array]', '[object Date]', '[object BigInt]', '[object Undefined]'];
  for (const mode of ['worker', 'process']) {
    assert.deepEqual(await callIsolated(TARGET, 'kinds', args, { mode }), expected, mode);
  }
});

test('★ 同时存活的隔离环境 ≤ CPU 核数：超出排队，全部完成，排队不吃超时预算', async () => {
  const { availableParallelism } = await import('node:os');
  const n = availableParallelism() * 4;
  const t0 = Date.now();
  // 4 批 × 400ms、超时 1000ms：若排队时间也算进超时，后几批必然 call_timeout
  const results = await Promise.all(Array.from({ length: n }, () => callIsolated(TARGET, 'sleep', [400], { timeoutMs: 1000 })));
  assert.equal(results.length, n);
  assert.ok(results.every(v => v === 400));
  assert.ok(Date.now() - t0 >= 4 * 400, '4 倍核数的任务至少分 4 批 ⇒ 总耗时不可能只有一批的时间');
});

// ── 大数据：worker 档零拷贝 ──
test('★ worker：transfer 把 ArrayBuffer 移交过去（零拷贝，调用方那块被清空）', async () => {
  const buf = new Uint8Array(1024).buffer;
  assert.equal(await callIsolated(TARGET, 'byteLen', [buf], { transfer: [buf] }), 1024);
  assert.equal(buf.byteLength, 0, '移交后本地不再持有这块内存');
  const kept = new Uint8Array(16).buffer;
  assert.equal(await callIsolated(TARGET, 'byteLen', [kept]), 16);
  assert.equal(kept.byteLength, 16, '不传 transfer ⇒ 照常复制，本地不受影响');
});

test('★ worker：返回值里的二进制原样取回（自动移交，内容正确）', async () => {
  const u8 = await callIsolated(TARGET, 'makeBytes', [8]);
  assert.ok(u8 instanceof Uint8Array);
  assert.deepEqual([...u8], [7, 7, 7, 7, 7, 7, 7, 7]);
  const obj = await callIsolated(TARGET, 'makeBytesObj', [4]);
  assert.equal(obj.label, 'x');
  assert.deepEqual([...obj.data], [9, 9, 9, 9]);
});

test('transfer 参数校验：非 ArrayBuffer / process 档 ⇒ invalid_argument', async () => {
  await assert.rejects(callIsolated(TARGET, 'byteLen', [1], { transfer: [new Uint8Array(1)] }), hasCode('invalid_argument', /ArrayBuffer/));
  const b = new ArrayBuffer(1);
  await assert.rejects(callIsolated(TARGET, 'byteLen', [b], { mode: 'process', transfer: [b] }), hasCode('invalid_argument', /worker/));
  assert.equal(b.byteLength, 1, '被拒的调用不得移交走调用方的内存');
});

test('不可克隆的参数（process 档）⇒ invalid_argument，且不留挂起的子进程', async () => {
  await assert.rejects(callIsolated(TARGET, 'add', [() => 1], { mode: 'process' }), hasCode('invalid_argument', /cloneable/));
});

test('transferables：取顶层与一层成员里的 ArrayBuffer（去重），跳过共享内存与更深层', async () => {
  const { transferables } = await import('../src/transferables.mjs');
  const a = new ArrayBuffer(1), b = new Uint8Array(2), c = new Uint8Array(3);
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  assert.deepEqual(transferables(a), [a]);
  assert.deepEqual(transferables(b), [b.buffer]);
  assert.deepEqual(transferables([a, b, a]), [a, b.buffer], '数组成员 + 去重');
  assert.deepEqual(transferables({ x: c, y: 1, s: shared }), [c.buffer], '普通对象成员；SharedArrayBuffer 不可移交');
  assert.deepEqual(transferables({ deep: { c } }), [], '只看一层：更深的照常复制');
  assert.deepEqual(transferables(null), []);
  assert.deepEqual(transferables('s'), []);
});

// ── 多 agent 同时灌大数据：排队 / 在途字节 / 单环境内存 三道闸 ──
async function withLimits(next, fn) {
  const { configureIsolation } = await import('../src/isolation.mjs');
  const before = configureIsolation();
  configureIsolation(next);
  try { return await fn(); } finally { configureIsolation(before); }
}

test('★ 排队满 ⇒ 立即 isolation_busy（不无限堆积）；已接收的照常完成', async () => {
  await withLimits({ maxConcurrent: 1, maxQueued: 1 }, async () => {
    const running = callIsolated(TARGET, 'sleep', [200]);
    const queued = callIsolated(TARGET, 'sleep', [10]);
    await assert.rejects(callIsolated(TARGET, 'add', [1, 2], { pluginId: 'agent-3' }), hasCode('isolation_busy', /queued/));
    assert.deepEqual(await Promise.all([running, queued]), [200, 10]);
    assert.equal(await callIsolated(TARGET, 'add', [1, 2]), 3, '腾出位置后可重试成功');
  });
});

test('★ 在途字节超限 ⇒ isolation_busy；单个超大调用在空闲时仍放行；结束后额度归还', async () => {
  await withLimits({ maxPendingBytes: 1000 }, async () => {
    const big = callIsolated(TARGET, 'byteLen', [new ArrayBuffer(4000)]);   // 独占：大于上限也放行
    await assert.rejects(callIsolated(TARGET, 'byteLen', [new ArrayBuffer(10)]), hasCode('isolation_busy', /maxPendingBytes/));
    assert.equal(await big, 4000);
    assert.equal(await callIsolated(TARGET, 'byteLen', [new ArrayBuffer(10)]), 10, '额度已归还');
  });
});

test('被拒 / 出错的调用都归还名额与额度（不泄漏）', async () => {
  await withLimits({ maxConcurrent: 1, maxQueued: 0, maxPendingBytes: 100 }, async () => {
    await assert.rejects(callIsolated(TARGET, 'boom', [new ArrayBuffer(50)]), hasCode('isolated_call_failed'));
    await assert.rejects(callIsolated(TARGET, 'add', [() => 1]), hasCode('invalid_argument'));
    await assert.rejects(callIsolated(TARGET, 'spin', [], { timeoutMs: 100 }), hasCode('call_timeout'));
    assert.equal(await callIsolated(TARGET, 'byteLen', [new ArrayBuffer(90)]), 90, '名额 1 / 排队 0 / 额度 100 仍完整可用');
  });
});

test('configureIsolation：只读 / 局部修改 / 校验；调大并发立刻放行排队中的调用', async () => {
  const { configureIsolation } = await import('../src/isolation.mjs');
  const now = configureIsolation();
  assert.ok(Object.isFrozen(now) && now.maxConcurrent >= 1 && now.maxQueued >= 0 && now.maxPendingBytes >= 1);
  for (const bad of [null, [], 1, { maxConcurrent: 0 }, { maxQueued: -1 }, { maxPendingBytes: 1.5 }, { nope: 1 }]) {
    assert.throws(() => configureIsolation(bad), hasCode('invalid_argument'));
  }
  assert.deepEqual(configureIsolation(), now, '校验失败不改任何值');
  await withLimits({ maxConcurrent: 1 }, async () => {
    const a = callIsolated(TARGET, 'sleep', [300]);
    const b = callIsolated(TARGET, 'sleep', [300]);
    await new Promise(r => setTimeout(r, 50));
    const t0 = Date.now();
    configureIsolation({ maxConcurrent: 2 });
    await b;
    assert.ok(Date.now() - t0 < 550, 'b 不必等 a 跑完');
    await a;
  });
});

for (const mode of ['worker', 'process']) {
  test(`★ ${mode}：堆超 maxMemoryMb ⇒ 只终止该环境，isolated_call_failed，宿主无恙`, async () => {
    const t0 = Date.now();
    // 超时给足 20s：必须是内存闸先触发（32MB 约 0.2s 撑满；没有闸则一路涨到默认堆上限，要 10s 以上）
    await assert.rejects(callIsolated(TARGET, 'heapHog', [], { mode, maxMemoryMb: 32, timeoutMs: 20000 }), hasCode('isolated_call_failed'));
    assert.ok(Date.now() - t0 < 3000, `内存闸应在数百毫秒内生效，实际 ${Date.now() - t0}ms`);
    assert.equal(await callIsolated(TARGET, 'add', [1, 2], { mode }), 3);
  });
}

test('maxMemoryMb 校验', async () => {
  for (const bad of [0, 15, 1.5, '64', Infinity]) {
    await assert.rejects(callIsolated(TARGET, 'add', [1, 2], { maxMemoryMb: bad }), hasCode('invalid_argument', /maxMemoryMb/));
  }
});

test('payloadBytes：二进制按整个底层 buffer 计且去重；字符串按长度；大容器有界', async () => {
  const { payloadBytes, PAYLOAD_SCAN_NODES } = await import('../src/payload.mjs');
  const buf = new ArrayBuffer(1000);
  assert.equal(payloadBytes([new Uint8Array(buf, 0, 10)]), 1000, '视图克隆时复制整块 buffer');
  assert.equal(payloadBytes([buf, new Uint8Array(buf), buf]), 1000, '同一块只计一次');
  assert.equal(payloadBytes(['abcd', 1, null]), 4 + 8 + 8, '容器本身不计，标量各 8');
  assert.equal(payloadBytes({ m: new Map([['k', new ArrayBuffer(5)]]), s: new Set(['xy']) }), 1 + 5 + 2);
  const cyc = { a: 'z' }; cyc.self = cyc;
  assert.equal(payloadBytes(cyc), 1, '环只走一次');
  const t0 = Date.now();
  assert.ok(payloadBytes(new Array(2_000_000).fill(1)) <= PAYLOAD_SCAN_NODES * 8 + 8);
  assert.ok(Date.now() - t0 < 500, '100 万级容器不逐项展开');
  let visited = 0;
  const huge = new Array(1_000_000).fill(0);
  huge[Symbol.iterator] = function* () { for (let i = 0; i < this.length; i++) { visited += 1; yield 0; } };
  payloadBytes([huge]);
  assert.ok(visited <= PAYLOAD_SCAN_NODES + 1, `最多展开 PAYLOAD_SCAN_NODES 项，实际 ${visited}`);
  const hostile = new Proxy({}, { ownKeys() { throw new Error('x'); } });
  assert.equal(typeof payloadBytes([hostile]), 'number', '怪对象不抛');
});

// ── 隔离端抛出的「怪值」不得打崩宿主 ──
for (const mode of ['worker', 'process']) {
  test(`★ ${mode}：目标函数抛 undefined / null / symbol / 数字 / message / name / code 抛错的对象 ⇒ isolated_call_failed`, async () => {
    for (const kind of ['undefined', 'null', 'symbol', 'number', 'badMessage', 'badName', 'badCode']) {
      // 必须是隔离端【正常回报】的失败（call failed），不是隔离端在整理错误时自己崩了（crashed / exited）
      await assert.rejects(callIsolated(TARGET, 'throwValue', [kind], { mode }), hasCode('isolated_call_failed', /isolated call failed/), `${mode} ${kind}`);
    }
  });
}

test('★ worker：异步里未捕获地抛 undefined / null / symbol / 数字 ⇒ isolated_call_failed（此前 undefined / null 让宿主进程崩溃）', async () => {
  for (const kind of ['undefined', 'null', 'symbol', 'number']) {
    await assert.rejects(callIsolated(TARGET, 'throwLater', [kind]), hasCode('isolated_call_failed', /crashed/), kind);
  }
});

test('★ 选项 / pluginId / 模块 URL 的怪值 ⇒ 入口处带码拒绝（此前或漏裸错误，或在回调里打崩宿主）', async () => {
  await assert.rejects(callIsolated(TARGET, 'add', [], { get mode() { throw new Error('g'); } }), hasCode('invalid_argument', /options/));
  await assert.rejects(callIsolated(TARGET, 'boom', [], { pluginId: { toString() { throw new Error('ts'); } } }), hasCode('invalid_argument', /pluginId/));
  if (process.platform === 'win32') {
    await assert.rejects(callIsolated('file:///no-drive/x.mjs', 'default', [], { mode: 'process' }), hasCode('invalid_argument', /local file/));
  }
});

// ★ 兜底定位：隔离端的原始栈跨线程 / 进程带回，报文附插件位置
for (const mode of ['worker', 'process']) {
  test(`${mode}：插件抛错 ⇒ 报文带插件文件行号，cause.stack 是隔离端原始栈`, async () => {
    const err = await callIsolated(TARGET, 'boom', [], { mode }).then(() => null, e => e);
    assert.equal(err?.code, 'isolated_call_failed');
    assert.match(err.message, /\(at file:.*targets\.mjs:6:\d+\)$/);
    assert.match(err.cause.stack, /targets\.mjs:6/);
    const notFn = await callIsolated(TARGET, 'notAFunction', [], { mode }).then(() => null, e => e);
    assert.equal(notFn.cause.stack, null);
    assert.doesNotMatch(notFn.message, /\(at /);
  });
}
