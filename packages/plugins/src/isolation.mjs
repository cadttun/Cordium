/**
 * @file packages/plugins/src/isolation.mjs
 * @description 执行隔离（最小可用版）：把【一个导出函数】放到隔离环境里调一次。
 *
 * 两档（隔离分四层：依赖 / 故障 / 安全 / 恶意代码，这里覆盖前两层的一部分）：
 *
 * | mode | 原语 | 解决什么 | 不解决什么 |
 * |---|---|---|---|
 * | `'worker'`  | `worker_threads` | 故障隔离：同步死循环 / 长计算**真的能被超时打断**（`worker.terminate()`） | 同进程：代码仍能碰 FS / 网络 / 环境变量 |
 * | `'process'` | `child_process.fork` + Node 权限模型 | 权限隔离的一步：独立进程 + 默认**禁读写文件系统、禁子进程、禁 worker**（按 `allowFsRead` / `allowFsWrite` 显式放行） | ⚠️ **不是安全沙箱** —— 见下 |
 *
 * ⚠️⚠️ Node 官方文档（permissions.html）原话：权限模型「**does not protect against malicious code**」，
 *   「Malicious code can bypass the permission model」。⇒ `'process'` 档防的是**第一方插件的越权与失误**，
 *   不是恶意第三方代码。真正的恶意代码隔离（容器 / WASM）仍按其开工条件（第三方插件出现）另议。
 *   `node:vm` / `vm2` 一律不用（Node 官方：vm 不是安全机制；vm2 有 RCE CVE）。
 *
 * 形状约束（这就是边界声明说的「异步化」）：
 *   · 调用一律返回 Promise；
 *   · 参数与返回值走结构化克隆 —— **函数、类实例、ctx 都传不过去**；
 *     大参数跨线程 / 进程要复制一次；worker 档可用 `transfer` 把 ArrayBuffer **移交**过去（零拷贝），
 *     返回值里的二进制也自动移交回来（见 isolation-runner）。process 档走 IPC 管道，必然复制。
 *   · 每次调用新起一个隔离环境（worker ~20ms、process ~60ms 启动），不复用 ——
 *     适合「偶尔跑一段不可信 / 可能卡死的计算」，不适合高频小调用。
 *   · 三道闸（见「并发与内存闸」）：同时存活数 ≤ 上限（默认 CPU 核数，超出排队）；排队数有上限；
 *     在途负载总字节数有上限 —— 后两者超了立即抛 `isolation_busy`（背压：调用方稍后重试），不无限堆积。
 *   · 单个隔离环境的 JS 堆有上限（`maxMemoryMb`，默认 1024）：超了只杀它自己，报 `isolated_call_failed`。
 *     ⇒ 这是给「纯计算 / 数据进数据出」的插件逻辑用的，**不是**把整个插件（含 ctx）搬进隔离区。
 *
 * 目标函数写法：一个 ES 模块的具名导出（或 default），同步 / 异步皆可。
 */
import { Worker } from 'node:worker_threads';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { availableParallelism, totalmem } from 'node:os';
import { CordiumError, ErrorCode, MAX_TIMER_MS, describeValue, describeError, readOptions, firstFrame } from '@cordium/kernel/internal';
import { toModuleHref } from './module-href.mjs';
import { payloadBytes } from './payload.mjs';

const RUNNER = fileURLToPath(new URL('./isolation-runner.mjs', import.meta.url));
const MODES = ['worker', 'process'];

// ════════════════ 并发与内存闸 ════════════════
/**
 * ★ 为什么要这些闸：
 *   · 不设上限时同时存活数无上限 —— 200 路并发实测 RSS 峰值 +413MB；超出核数的并发也不会更快，只会互相抢 CPU。
 *   · 加了存活上限后，排队本身又无上限：每个排队的调用都攥着自己的参数不放（排 100 个 × 200MB = 20GB 常驻），
 *     多 agent 同时灌大数据时照样撑爆本进程。⇒ 排队数、在途字节数也设上限，超了立即拒（isolation_busy）。
 *
 * 在途字节 = 已接收（运行中 + 排队中）调用的参数大小之和（payloadBytes 估算）。
 * 单个调用大于上限时，只要当前没有别的在途负载就放行 —— 否则它永远跑不了；它本来就在调用方内存里。
 */
const DEFAULT_LIMITS = Object.freeze({
  maxConcurrent: Math.max(1, availableParallelism()),
  maxQueued: 256,
  maxPendingBytes: Math.floor(totalmem() / 4)
});
const LIMIT_MIN = { maxConcurrent: 1, maxQueued: 0, maxPendingBytes: 1 };
let limits = { ...DEFAULT_LIMITS };
let live = 0;
let pendingBytes = 0;
const waiting = [];

/**
 * 读 / 改本进程 callIsolated 的三道闸。不传参 ⇒ 只读。改动立即生效（上限调大会马上放行排队中的调用）。
 * @param {{ maxConcurrent?: number, maxQueued?: number, maxPendingBytes?: number }} [next] 只改给出的键
 * @returns {Readonly<{ maxConcurrent: number, maxQueued: number, maxPendingBytes: number }>} 生效后的上限
 */
export function configureIsolation(next) {
  if (next !== undefined) {
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'configureIsolation: limits must be an object');
    }
    for (const [key, value] of Object.entries(next)) {
      if (!(key in LIMIT_MIN)) {
        throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `configureIsolation: unknown limit '${key}' (expected ${Object.keys(LIMIT_MIN).join(', ')})`);
      }
      if (!Number.isSafeInteger(value) || value < LIMIT_MIN[key]) {
        throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `configureIsolation: ${key} must be an integer >= ${LIMIT_MIN[key]}, got ${String(value)}`);
      }
    }
    limits = { ...limits, ...next };
    drain();
  }
  return Object.freeze({ ...limits });
}

/** 登记在途字节；排队满 / 字节超 ⇒ 同步抛 isolation_busy（调用方据此退避重试） */
function reserve(bytes, pluginId) {
  if (live >= limits.maxConcurrent && waiting.length >= limits.maxQueued) {
    throw new CordiumError(ErrorCode.ISOLATION_BUSY,
      `callIsolated: ${live} running and ${waiting.length} queued (maxQueued ${limits.maxQueued}); retry later`, { pluginId });
  }
  if (pendingBytes > 0 && pendingBytes + bytes > limits.maxPendingBytes) {
    throw new CordiumError(ErrorCode.ISOLATION_BUSY,
      `callIsolated: ${pendingBytes} bytes in flight + ${bytes} would exceed maxPendingBytes ${limits.maxPendingBytes}; retry later`, { pluginId });
  }
  pendingBytes += bytes;
}
function acquire() {
  if (live < limits.maxConcurrent) { live += 1; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));
}
function drain() {
  while (waiting.length > 0 && live < limits.maxConcurrent) { live += 1; waiting.shift()(); }
}
function release() {
  live -= 1;
  drain();
}

// Node 22+ 为 --permission；Node 20 为 --experimental-permission（engines >=20）
const PERMISSION_FLAG = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';

/**
 * 在隔离环境里调用 `module` 的导出 `exportName`。
 *
 * @param {string|URL} module 绝对路径或 file: URL（相对路径不收：相对谁会随调用方漂移）
 * @param {string} [exportName='default']
 * @param {any[]} [args=[]] 须可结构化克隆
 * @param {object} [options]
 * @param {'worker'|'process'} [options.mode='worker']
 * @param {number} [options.timeoutMs=3000] 超时即**终止**隔离环境（不是停止等待）
 * @param {string} [options.pluginId='unknown'] 报错归属
 * @param {string[]} [options.allowFsRead=[]] 仅 `process`：额外可读路径（模块自身所在目录自动放行）
 * @param {string[]} [options.allowFsWrite=[]] 仅 `process`：可写路径
 * @param {number} [options.maxMemoryMb=1024] 隔离环境的 JS 堆上限（MB）；超了只终止这个环境 ⇒ isolated_call_failed。
 *   ⚠️ ArrayBuffer / Buffer 的数据不在 JS 堆里，不受此限（Node 的限制，实测）。
 * @param {ArrayBuffer[]} [options.transfer=[]] 仅 `worker`：**移交**而非复制的 ArrayBuffer（须出现在 args 里）。
 *   移交后调用方手里的那块内存被清空（byteLength 变 0）—— 这是零拷贝的代价，调用后别再用它。
 * @returns {Promise<any>}
 * @throws {CordiumError} `isolation_busy`：排队已满或在途字节超限（见 configureIsolation）—— 未起任何环境，可重试
 */
export async function callIsolated(module, exportName = 'default', args = [], options) {
  const { mode = 'worker', timeoutMs = 3000, pluginId = 'unknown', allowFsRead = [], allowFsWrite = [], transfer = [], maxMemoryMb = 1024 } = readOptions(options, 'callIsolated');
  // ★ pluginId 先验：它会被拼进每条报错；非字符串（如 toString 抛错的对象）此前在子环境回消息的
  //   事件回调里拼报文时抛出 ⇒ 未捕获异常直接打崩宿主进程（实测）。
  if (typeof pluginId !== 'string') {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `callIsolated: pluginId must be a string, got ${describeValue(pluginId)}`);
  }
  const href = toModuleHref(module, 'callIsolated: module');
  if (typeof exportName !== 'string' || !exportName) {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'callIsolated: exportName must be a non-empty string', { pluginId });
  }
  if (!Array.isArray(args)) throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'callIsolated: args must be an array', { pluginId });
  if (!MODES.includes(mode)) {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `callIsolated: mode must be one of ${MODES.join(', ')}, got '${String(mode)}'`, { pluginId });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new CordiumError(ErrorCode.INVALID_TIMEOUT, `callIsolated: timeoutMs must be a finite number in (0, ${MAX_TIMER_MS}], got ${String(timeoutMs)}`, { pluginId });
  }
  for (const [name, list] of [['allowFsRead', allowFsRead], ['allowFsWrite', allowFsWrite]]) {
    if (!Array.isArray(list) || !list.every(p => typeof p === 'string' && path.isAbsolute(p))) {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `callIsolated: ${name} must be an array of absolute paths`, { pluginId });
    }
  }
  if (!Array.isArray(transfer) || !transfer.every(b => b instanceof ArrayBuffer)) {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'callIsolated: transfer must be an array of ArrayBuffer', { pluginId });
  }
  if (transfer.length > 0 && mode !== 'worker') {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, "callIsolated: transfer is only supported in 'worker' mode (process IPC always copies)", { pluginId });
  }
  if (!Number.isSafeInteger(maxMemoryMb) || maxMemoryMb < 16) {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `callIsolated: maxMemoryMb must be an integer >= 16, got ${String(maxMemoryMb)}`, { pluginId });
  }
  // process 档要放行目标模块所在目录的读权限 ⇒ 先把 href 解析成本地路径。
  // ★ 放在排队之前：此前在 spawn 里才解析，Windows 上无盘符的 file: URL 在那里抛出引擎级 TypeError（实测）
  let moduleDir = null;
  if (mode === 'process' && href.startsWith('file:')) {
    try { moduleDir = path.dirname(fileURLToPath(href)); } catch (err) {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `callIsolated: module URL is not a local file path (${describeError(err)})`, { pluginId, cause: err });
    }
  }
  const request = { href, exportName, args };
  // ★ 不在本进程预先 structuredClone(args) 验可克隆：那等于把大参数多复制一整遍（200MB 实测多花 ~65ms、峰值多一份内存）。
  //   Worker 构造 / child.send 遇到不可克隆的值会【同步】抛（实测）⇒ 在那里转成 invalid_argument，效果一样。
  const notCloneable = err => new CordiumError(ErrorCode.INVALID_ARGUMENT,
    `callIsolated: args must be structured-cloneable (${describeError(err)})`, { pluginId, cause: err });

  const spawn = mode === 'worker'
    ? () => {
        let w;
        try { w = new Worker(RUNNER, { workerData: request, transferList: transfer, stdout: false, stderr: false, resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb } }); } catch (err) { throw notCloneable(err); }
        return { channel: w, kill: () => w.terminate() };
      }
    : () => {
        const reads = [path.dirname(RUNNER), ...(moduleDir ? [moduleDir] : []), ...allowFsRead];
        const execArgv = [PERMISSION_FLAG, `--max-old-space-size=${maxMemoryMb}`, ...reads.map(p => `--allow-fs-read=${p}`), ...allowFsWrite.map(p => `--allow-fs-write=${p}`)];
        // ★ serialization: 'advanced' —— fork 默认走 JSON：Map / TypedArray 变普通对象、Date 变字符串、
        //   undefined 变 null、BigInt 直接抛（实测）。advanced 即结构化克隆，与 worker 档同一语义。
        const c = fork(RUNNER, [], { execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {}, serialization: 'advanced' });
        const kill = () => { c.kill(); };
        // send 遇到不可克隆的值同步抛 ⇒ 必须先收掉子进程，否则它挂着 IPC 永不退出
        try { c.send(request); } catch (err) {
          kill();
          throw notCloneable(err);
        }
        return { channel: c, kill };
      };

  const bytes = payloadBytes(args);
  reserve(bytes, pluginId);
  try {
    await acquire();
    try {
      return await awaitReply(spawn(), { mode, timeoutMs, pluginId });
    } finally {
      release();
    }
  } finally {
    pendingBytes -= bytes;
  }
}

/** 等隔离环境回一条消息（或超时 / 崩溃 / 退出），然后一律收掉它 */
async function awaitReply({ channel, kill }, { mode, timeoutMs, pluginId }) {
  let timer = null;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new CordiumError(ErrorCode.CALL_TIMEOUT,
          `Plugin '${pluginId}' isolated call timed out after ${timeoutMs}ms (${mode} terminated)`, { pluginId }));
      }, timeoutMs);
      channel.once('message', (msg) => {
        if (msg?.ok) return resolve(msg.value);
        // ★ 隔离端回来的栈指向插件文件：报文里带上源头位置，cause.stack 保留全栈（跨进程也能定位到行）
        const at = firstFrame(msg?.stack);
        reject(new CordiumError(ErrorCode.ISOLATED_CALL_FAILED,
          `Plugin '${pluginId}' isolated call failed: ${msg?.name ?? 'Error'}${msg?.code ? ` [${msg.code}]` : ''}: ${msg?.message ?? ''}${at ? ` (at ${at})` : ''}`,
          { pluginId, cause: msg }));
      });
      channel.once('error', err => reject(new CordiumError(ErrorCode.ISOLATED_CALL_FAILED,
        `Plugin '${pluginId}' isolated ${mode} crashed: ${describeError(err)}`, { pluginId, cause: err })));
      channel.once('exit', code => reject(new CordiumError(ErrorCode.ISOLATED_CALL_FAILED,
        `Plugin '${pluginId}' isolated ${mode} exited (code ${code}) without a result`, { pluginId })));
    });
  } finally {
    clearTimeout(timer);
    await kill();
  }
}
