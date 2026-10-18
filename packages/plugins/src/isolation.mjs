/**
 * @file packages/plugins/src/isolation.mjs
 * @description 执行隔离（最小可用版）：把【一个导出函数】放到隔离环境里调一次。
 *
 * 两档（隔离分四层：依赖 / 加载 / 故障 / 安全，这里覆盖【故障 + 安全】两层的一部分）：
 *
 * | mode | 原语 | 解决什么 | 不解决什么 |
 * |---|---|---|---|
 * | `'worker'`  | `worker_threads` | 故障隔离：同步死循环 / 长计算**真的能被超时打断**（`worker.terminate()`） | 同进程：代码仍能碰 FS / 网络 / 环境变量 |
 * | `'process'` | `child_process.fork` + Node 权限模型 | 权限隔离的一步：独立进程 + 默认**禁读写文件系统、禁子进程、禁 worker**（按 `allowFsRead` / `allowFsWrite` 显式放行） | ⚠️ **不是安全沙箱，也不断网** —— 见下 |
 *
 * ⚠️⚠️ Node 官方文档（permissions.html）原话：权限模型「**does not protect against malicious code**」，
 *   「Malicious code can bypass the permission model」。⇒ `'process'` 档防的是**第一方插件的越权与失误**，
 *   不是恶意第三方代码。真正的恶意代码隔离（容器 / WASM）仍按其开工条件（第三方插件出现）另议。
 *   `node:vm` / `vm2` 一律不用（Node 官方：vm 不是安全机制；vm2 有 RCE CVE）。
 *
 * ⚠️ **别把 `'process'` 档读成「断网档」**：Node 权限模型在**受支持 LTS 线（v22 / v24）上没有网络这一维** ——
 *   本机 v24.16.0 的 `--allow-*` 只有 7 个（addons / child-process / fs-read / fs-write / inspector /
 *   wasi / worker），**没有 `--allow-net`**（它是 v25.0.0 才引入的，而 v25 已经 EOL）。
 *   ⇒ 这一档的边界是「**文件系统 / 子进程 / worker 的越权与失误**」，**不含网络**：插件在 `'process'` 档里
 *   仍可任意发起连接。要断网只能靠操作系统层（容器 / 防火墙 / 独立用户 / seccomp）。
 *   （v25+ 上不传 `--allow-net` 确实会默认禁网，但那是**宿主 Node 版本的偶然结果**，不是本仓的保证 —— 别依赖它。）
 *
 * 形状约束（这就是边界声明说的「异步化」）：
 *   · 调用一律返回 Promise；
 *   · 参数与返回值走结构化克隆 —— **函数、类实例、ctx 都传不过去**；
 *     大参数跨线程 / 进程要复制一次；worker 档可用 `transfer` 把 ArrayBuffer **移交**过去（零拷贝），
 *     返回值里的二进制也自动移交回来（见 isolation-runner）。process 档走 IPC 管道，必然复制。
 *   · 每次调用新起一个隔离环境（worker ~20ms、process ~60ms 启动），不复用 ——
 *     适合「偶尔跑一段不可信 / 可能卡死的计算」，不适合高频小调用。
 *   · 三道闸（见「并发与内存闸」）：同时存活数 ≤ 上限（默认 CPU 核数，超出排队）；排队数有上限；
 *     在途负载总字节数有上限 —— 后两者超了立即抛 `isolation_busy`（背压：**未起任何环境**）。
 *     ⚠️ 两道闸的**口径要先知道**（都不是缺陷，是此前没写出来）：
 *       ① **`timeoutMs` 只算执行段，不含排队等待。** 计时器从 `spawn()` 起算（见 `awaitReply`），
 *          而排队发生在 `acquire()` 里、在它之前。排队位排满（`maxQueued` 默认 256）时，一个调用
 *          可能先等最多 `maxQueued × timeoutMs`（默认口径约 12.8 分钟）才轮到执行，而它拿到的
 *          报文写的是 `timed out after 3000ms`。★ 本模块**没有导出队列深度查询** ⇒ 调用方
 *          **无法从外部区分「在排队」与「在执行」**，要卡总预算只能在外层自己加。
 *       ② **上限对两档的硬度不同。** `worker` 档的 `kill` 是 `w.terminate()`（返回 Promise），
 *          `await` 真的等到线程停；`process` 档是 `c.kill()`（返回 boolean），`await` 是**空操作**，
 *          只是「信号已发出」。Windows 上两者等价（`kill` 走 `TerminateProcess`，子进程根本收不到
 *          `SIGTERM`，本机实测）；POSIX 上目标只要装了 `SIGTERM` 处理函数，Node 的默认终止行为就被
 *          移除，此时这道上限**不成立**（槽已归还、进程还活着，攥着最多 `maxMemoryMb` 不放）。
 *          ★ 本机（win32）**复现不出来** ⇒ 未改行为，登记在 `docs/开工中/README.md` §二。
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
import { randomUUID } from 'node:crypto';
import { CordiumError, ErrorCode, MAX_TIMER_MS, describeValue, describeError, readOptions, firstFrame } from '@cordium/kernel/internal';
import { toModuleHref } from './module-href.mjs';
import { payloadBytes } from './payload.mjs';

const RUNNER = fileURLToPath(new URL('./isolation-runner.mjs', import.meta.url));
const MODES = ['worker', 'process'];

/**
 * `args` 里**可达**的 ArrayBuffer 集合 —— `transfer` 项的合法性判据。
 *
 * ★ 为什么需要：Node 的 `transferList` 对**不在 `value` 里**的对象**照样 detach**（官方逐字：
 *   transferring 后「not usable on the sending side … **even if they are not contained in `value`**」）
 *   ⇒ 传一个不在 args 里的 buffer 会**静默清空调用方内存**、worker 又从未收到 ⇒ 零报错的数据丢失。
 *   本仓口径：越界输入必须响亮 ⇒ 判据是「每个 transfer 项都能在 args 里找到」。
 *
 * 走结构化克隆同款的容器：数组 / 普通对象（自有可枚举值）/ Map（键与值）/ Set；
 * 遇 `ArrayBuffer` 记它自己，遇 TypedArray / DataView 取 `.buffer`。防环 + 有界（同 payloadBytes 的考虑）。
 *
 * @param {unknown} args
 * @returns {Set<ArrayBuffer>}
 */
function reachableBuffers(args) {
  const out = new Set();
  const seen = new Set();
  const stack = [args];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (v instanceof ArrayBuffer) { out.add(v); continue; }
    if (ArrayBuffer.isView(v)) { out.add(v.buffer); continue; }
    if (v instanceof Map) { for (const [k, val] of v) stack.push(k, val); continue; }
    if (v instanceof Set) { for (const val of v) stack.push(val); continue; }
    if (Array.isArray(v)) { for (const item of v) stack.push(item); continue; }
    // 普通对象：只看自有可枚举值（与结构化克隆一致）；怪对象（抛错的 getter / Proxy）跳过
    try { for (const key of Object.keys(v)) stack.push(v[key]); } catch { /* 跳过不可读对象 */ }
  }
  return out;
}

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
// ★ 普通对象字面量即可 —— 判定走下面的 Object.hasOwn，不依赖这张表的原型。
//   ⚠️ 曾短暂改成 Object.create(null)：那会让「原型链上本来就没有这些名字」与
//      「查表不看原型链」两道防线**互相遮蔽** —— 任一单独存在都能通过测试，
//      于是没有任何用例能判别 hasOwn 那一行。防线数量超过测试能判别的数量，
//      等于把一处可验证的检查换成了两处不可验证的。只留 hasOwn。
const LIMIT_MIN = { maxConcurrent: 1, maxQueued: 0, maxPendingBytes: 1 };
/** @type {{ maxConcurrent: number, maxQueued: number, maxPendingBytes: number }} */
let limits = { ...DEFAULT_LIMITS };
let live = 0;
let pendingBytes = 0;
const waiting = [];

// ★ `err.cause.code` 的**第二码域**（隔离端自产的码）。本表**不完备**：插件自报的码由隔离端
//   原样透传、不可枚举。详见 isolation-codes.mjs 的文件头。
export { IsolationCode } from './isolation-codes.mjs';

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
      // ★★ 必须用 Object.hasOwn —— **不能用 `key in LIMIT_MIN`**。
      //
      //   `in` 会走原型链，于是 `toString` / `constructor` / `hasOwnProperty` / `__proto__`
      //   这些**继承来的**名字全都「存在」：
      //     · 校验形同虚设（它们不是合法上限名，却一律放行）；
      //     · 更糟的是下一行 `value < LIMIT_MIN[key]` 拿到的是**函数**，
      //       `数字 < 函数` 恒为 false ⇒ **任意数值都能过**；
      //     · 最终 `{ ...limits, ...next }` 把 `toString: 1` 这类键写进生效上限表并带进返回值。
      //
      //   实测（改前）：`configureIsolation({ toString: 1 })` 被接受，返回值含该键。
      //   ★ 同形外部案例：2026 年一批原型链键查找缺陷（joi / JSON 反序列化按路径写值 /
      //     某 HTTP 路由按方法名查表 / Electron contextBridge），修法一律是
      //     「只认自有属性」。其中路由那个与本处形状最接近：同样是查表拿到原型上的函数后崩。
      if (!Object.hasOwn(LIMIT_MIN, key)) {
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

/** 登记在途字节；排队满 / 字节超 ⇒ 同步抛 isolation_busy（**未起环境**，重试口径见 retry-class.mjs） */
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
/**
 * 申请一个并发槽。
 *
 * ★ 返回的对象**同时**是「等待项」与「句柄」—— 取消要能在**排队阶段**下手：
 *   此前 `waiting` 里只存 resolve 函数，一个还在排队的调用**没有任何可摘除的标识**，
 *   想取消它只能等它自己跑完。取消排队项的价值最大：它**一格 CPU 都没花过**。
 *
 * @returns {{ promise: Promise<void>, cancel: (reason: any) => boolean, settled: boolean }}
 */
function acquire() {
  if (live < limits.maxConcurrent) {
    live += 1;
    return { promise: Promise.resolve(), cancel: () => false, settled: true };
  }
  /** @type {any} */
  const slot = { settled: false };
  slot.promise = new Promise((resolve, reject) => {
    slot.resolve = resolve;
    slot.reject = reject;
  });
  // ★ cancel 是**闭包句柄**：拿不到它就没有取消能力（不接受 pluginId 这类可伪造的身份参数）。
  //   返回 true = 真的从队列里摘掉了；false = 它已经不在队列里（已被放行或已取消过）。
  slot.cancel = (reason) => {
    if (slot.settled) return false;
    const i = waiting.indexOf(slot);
    if (i < 0) return false;
    waiting.splice(i, 1);
    slot.settled = true;
    slot.reject(reason);
    return true;
  };
  waiting.push(slot);
  return slot;
}
function drain() {
  while (waiting.length > 0 && live < limits.maxConcurrent) {
    const slot = waiting.shift();
    if (slot.settled) continue;              // 已被取消（防御：取消时已从队列摘除，正常不会走到）
    slot.settled = true;
    live += 1;
    slot.resolve();
  }
}
function release() {
  live -= 1;
  drain();
}

// 权限模型：Node 22.13 起 `--permission` 为稳定开关（engines >=22.13.0，不再需要 --experimental-permission 回退）
const PERMISSION_FLAG = '--permission';

/**
 * `startIsolated` 与 `callIsolated` **共用**的选项形状。
 *
 * ★ 必须是一个**真类型**，不能只在其中一个入口把字段列全、另一个入口写「同某某」——
 *   JSDoc 的「同 X」是**散文**，`tsc` 解不出结构，会把参数退化成裸 `object`
 *   ⇒ 消费方失去全部字段提示与拼写检查（实测：`callIsolated` 曾因此退化成 `options?: object`）。
 *   ⇒ 两个入口**都引用这一个 typedef**，字段只在这里写一遍（不造第二真相源）。
 *
 * @typedef {object} IsolationOptions
 * @property {'worker'|'process'} [mode='worker']
 * @property {number} [timeoutMs=3000] 超时即**终止**隔离环境（不是停止等待）
 * @property {string} [pluginId='unknown'] 报错归属
 * @property {readonly string[]} [allowFsRead=[]] 仅 `process`：额外可读路径（模块自身所在目录自动放行）
 * @property {readonly string[]} [allowFsWrite=[]] 仅 `process`：可写路径
 * @property {number} [maxMemoryMb=1024] 隔离环境的 JS 堆上限（MB）；超了只终止这个环境 ⇒ `isolated_call_failed`。
 *   ⚠️ ArrayBuffer / Buffer 的数据不在 JS 堆里，不受此限（Node 的限制，实测）。
 * @property {readonly ArrayBuffer[]} [transfer=[]] 仅 `worker`：**移交**而非复制的 ArrayBuffer（**必须**出现在 `args` 里）。
 *   不在 `args` 里的 buffer 会被静默 detach 成数据丢失 ⇒ 带码拒绝。移交后调用方手里那块内存被清空（`byteLength` 变 0）—— 这是零拷贝的代价，调用后别再用它。
 */

/**
 * 在隔离环境里调用 `module` 的导出 `exportName`，返回**可取消的句柄**。
 *
 * ★ 为什么是 `{ promise, cancel }` 而不是 `options.signal`（形态上的硬约束）：
 *   1. `AbortSignal` **不可结构化克隆** ⇒ 过不了 worker / process 边界，
 *      而 `callIsolated` **本身就是那条边界**。把 signal 塞进 options，
 *      它最多只能被**父侧**读到 —— 那它取消的其实是「父侧等待」，不是隔离环境里的工作。
 *   2. 本仓**没有「发起调用的消费方」这个概念**：`callIsolated` 由装配方直接调，
 *      不在 `ctx` 上 ⇒ 没有地方安放「谁有权取消」。
 *      ⇒ 取消权限只能落在**持有句柄**这件事上（capability，CWE-441 的正确形态）。
 *   3. 业界对「跨线程取消」分三态处理：排队中（直接摘除，零成本）/
 *      运行中有协作点（发消息）/ 运行中无协作点（**只能终止环境**）。
 *      本仓的隔离档是**故障隔离**、被隔离代码不可信 ⇒ 只做第三态（终止式）。
 *
 * ★ 两阶段都可取消，且**语义不同**：
 *   · **排队中** ⇒ 从队列摘掉，**一格 CPU 都没花**（取消价值最大的情形）；
 *   · **运行中** ⇒ `worker.terminate()` / `child.kill()`，与 `timeoutMs` 同一套收尾。
 *   两者都报 `call_cancelled`（**与 `call_timeout` 分开** —— 「我自己喊的停」
 *   与「预算用完了」该触发完全不同的上游反应）。
 *
 * @param {string|URL} module 绝对路径或 file: URL（相对路径不收：相对谁会随调用方漂移）
 * @param {string} [exportName='default']
 * @param {readonly any[]} [args=[]] 须可结构化克隆
 * @param {IsolationOptions} [options]
 * @returns {{ promise: Promise<any>, cancel: (reason?: string) => boolean }}
 *   `cancel` 返回 true = 这次调用确实被取消了；false = 它已经结束（成功 / 失败 / 超时 / 取消过）
 * @throws {CordiumError} `isolation_busy`：排队已满或在途字节超限（见 configureIsolation）—— **未起任何环境**（零副作用）；重试口径见 `@cordium/kernel` 的 `retry-class.mjs`
 */
export function startIsolated(module, exportName = 'default', args = [], options) {
  const { mode = 'worker', timeoutMs = 3000, pluginId = 'unknown', allowFsRead = [], allowFsWrite = [], transfer = [], maxMemoryMb = 1024 } = readOptions(options, 'callIsolated', ['mode', 'timeoutMs', 'pluginId', 'allowFsRead', 'allowFsWrite', 'transfer', 'maxMemoryMb']);
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
  // ★★ 每个 transfer 项必须【在 args 里可达】—— 否则 Node 会把它当「不在 value 里的可移交对象」
  //   **静默 detach**（官方逐字：transferList 项「after transferring … not usable on the sending side
  //   … even if they are not contained in value」），调用方手里的那块内存被清空、worker 又从未收到
  //   ⇒ **零报错的数据丢失**（实测：不相关的 buffer 传进 transfer，宿主侧 byteLength 静默变 0）。
  //   本仓口径：越界 / 拼错的输入必须响亮。可达 = 出现在 args 里（含数组 / 对象 / Map / Set 内，
  //   或作为 TypedArray / DataView 的 .buffer）。只在真的传了 transfer 时才遍历（零 transfer 零开销）。
  if (transfer.length > 0) {
    const reachable = reachableBuffers(args);
    if (transfer.some(b => !reachable.has(b))) {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT,
        'callIsolated: every transfer entry must appear in args — an ArrayBuffer not reachable from args '
        + 'would be detached without ever reaching the worker (silent data loss)', { pluginId });
    }
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
  // ★ 回包关联 nonce：隔离内代码与 runner 同处一个 worker / 进程，可自行 postMessage / process.send；
  //   没有关联标识时，父侧会把「第一条消息」当成结果（实测：隔离内代码发一条 {ok:true,…} 就顶掉真实返回值）。
  //   父侧只认带对 nonce 的回包（见 awaitReply）。
  //   ⚠️ 残留：同线程代码能读 workerData / 请求里的 nonce ⇒ nonce 挡的是【意外串扰】，不是蓄意伪造
  //      （隔离档是故障隔离、非安全沙箱，见文件头）。
  const nonce = randomUUID();
  const request = { href, exportName, args, nonce };
  // ★ 不在本进程预先 structuredClone(args) 验可克隆：那等于把大参数多复制一整遍（200MB 实测多花 ~65ms、峰值多一份内存）。
  //   Worker 构造 / child.send 遇到不可克隆的值会【同步】抛（实测）⇒ 在那里转成 invalid_argument，效果一样。
  // ★ 只在【确实是克隆失败】时才报「args must be structured-cloneable」—— 此前把 Worker 构造 / child.send 的
  //   **任何**同步抛都归成这一条（如 transfer 写错、resourceLimits 非法），把调用方引向错误的排查方向。
  //   判据：worker 档抛 `DataCloneError`（name），process 档（advanced 序列化）抛的是一条普通 `Error`
  //   且报文含「could not be cloned」（实测两档形状不同）⇒ 名字 **或** 报文命中即判克隆失败；
  //   其余同步失败按通用隔离失败报，真错原样挂 cause。
  const spawnFailed = err => ((err?.name === 'DataCloneError' || /could not be cloned/i.test(describeError(err)))
    ? new CordiumError(ErrorCode.INVALID_ARGUMENT,
        `callIsolated: args must be structured-cloneable (${describeError(err)})`, { pluginId, cause: err })
    : new CordiumError(ErrorCode.ISOLATED_CALL_FAILED,
        `callIsolated: failed to start the ${mode} isolation environment (${describeError(err)})`, { pluginId, cause: err }));

  const spawn = mode === 'worker'
    ? () => {
        let w;
        try { w = new Worker(RUNNER, { workerData: request, transferList: transfer, stdout: false, stderr: false, resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb } }); } catch (err) { throw spawnFailed(err); }
        return { channel: w, kill: () => w.terminate() };
      }
    : () => {
        const reads = [path.dirname(RUNNER), ...(moduleDir ? [moduleDir] : []), ...allowFsRead];
        const execArgv = [PERMISSION_FLAG, `--max-old-space-size=${maxMemoryMb}`, ...reads.map(p => `--allow-fs-read=${p}`), ...allowFsWrite.map(p => `--allow-fs-write=${p}`)];
        // ★ serialization: 'advanced' —— fork 默认走 JSON：Map / TypedArray 变普通对象、Date 变字符串、
        //   undefined 变 null、BigInt 直接抛（实测）。advanced 即结构化克隆，与 worker 档同一语义。
        const c = fork(RUNNER, [], { execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {}, serialization: 'advanced' });
        // ⚠️ `c.kill()` 返回 boolean，`await` 是**空操作** —— 本档**不等子进程真退出**就归还并发槽
        //   （worker 档的 `w.terminate()` 返回 Promise，会等）。Windows 上无差别（`TerminateProcess`
        //   无条件）；POSIX 上目标若接管了 `SIGTERM` 则收不掉。详见文件头「三道闸」②。
        const kill = () => { c.kill(); };
        // send 遇到不可克隆的值同步抛 ⇒ 必须先收掉子进程，否则它挂着 IPC 永不退出
        try { c.send(request); } catch (err) {
          kill();
          throw spawnFailed(err);
        }
        return { channel: c, kill };
      };

  const bytes = payloadBytes(args);
  reserve(bytes, pluginId);
  /** @type {{channel: any, kill: any} | null} 已起的环境（取消时要真的收掉它） */
  let running = null;
  /** @type {null | (() => void)} 唤醒「运行中被取消」的等待者 */
  let abortRunning = null;
  const op = {
    /** @type {Promise<any>} */
    promise: /** @type {any} */ (null),
    /**
     * ★ 取消：**终止式**（不是协作式）。拿得到这个闭包才取消得了 —— 它是 capability，
     *   **不接受 pluginId 这类可伪造的身份参数**。语义与 `timeoutMs` 一致：收掉隔离环境。
     *
     * 两个阶段都能取消：
     *   · **排队中** ⇒ 直接从队列摘掉，**一格 CPU 都没花**（这是取消价值最大的情形）；
     *   · **运行中** ⇒ 收掉 worker / 子进程。
     *
     * @param {string} [reason] 只进报文，不参与判定
     * @returns {boolean} true = 这次调用确实被取消了；false = 它已经结束了（成功 / 失败 / 超时 / 取消过）
     */
    cancel: (reason = 'cancelled by caller') => {
      if (slot.cancel(new CordiumError(ErrorCode.CALL_CANCELLED,
        `Plugin '${pluginId}' isolated call cancelled while queued (${reason})`, { pluginId }))) return true;
      if (abortRunning) { abortRunning(); return true; }
      return false;
    }
  };
  const slot = acquire();
  op.promise = (async () => {
    try {
      await slot.promise;
      try {
        // ★ 运行阶段的取消：`awaitReply` 里挂一个「被取消」的出口，
        //   它与超时走**同一套收尾**（终止环境 + 释放槽），只是错误码不同。
        running = spawn();
        return await awaitReply(running, { mode, timeoutMs, pluginId, nonce }, (fire) => {
          // ★ 一次性：触发后立刻摘掉，否则**重复取消**会一直返回 true
          //   （对被取消过的调用谎称「我又取消了一次」）。实测会红。
          abortRunning = () => { abortRunning = null; fire(); };
        });
      } finally {
        // ★★ 必须清空 —— 否则调用结束后 `cancel()` 仍会命中上一轮的 abort 出口，
        //   对一个**已经结束**的调用返回 true（谎报「我把它取消了」）。实测会红。
        abortRunning = null;
        release();
      }
    } finally {
      pendingBytes -= bytes;
    }
  })();
  return Object.freeze({ promise: op.promise, cancel: op.cancel });
}

/**
 * `startIsolated` 的**等待版** —— 就是本包此前的 `callIsolated`，语义逐字不变。
 *
 * ★ 为什么要有两个入口：`async function` 的返回值必然被包成一个新 Promise，
 *   挂在它上面的 `cancel` 属性**取不到**（实测：`await` 前访问 `.cancel` 是 `undefined`）。
 *   硬把句柄塞进 async 函数的返回值会得到一个「有时能取消、有时不能」的 API ——
 *   比没有取消更糟。⇒ 取消是**独立入口**，旧入口保持纯 Promise。
 *
 * @param {string|URL} module
 * @param {string} [exportName='default']
 * @param {readonly any[]} [args=[]]
 * @param {IsolationOptions} [options] 与 `startIsolated` **同一个 typedef**（不在这里重列字段）
 * @returns {Promise<any>}
 */
export function callIsolated(module, exportName = 'default', args = [], options) {
  // ★ 入口校验是**同步抛**的（`invalid_argument` / `isolation_busy` 都在起环境之前）。
  //   本入口此前是 `async` ⇒ 同步抛会被自动包成**拒绝的 Promise**；
  //   改成普通函数后必须显式还原这一语义，否则调用方从 `await` 拿到的是**同步异常**
  //   （`try { await callIsolated(...) }` 仍接得住，但 `.catch()` 接不住了 —— 是行为变更）。
  let started;
  try { started = startIsolated(module, exportName, args, options); } catch (err) { return Promise.reject(err); }
  return started.promise;
}

/**
 * 等隔离环境回一条消息（或超时 / 崩溃 / 退出 / 被取消），然后一律收掉它。
 *
 * ★ `onAbort` 由调用方注入（把「取消」接到本函数内部的某个出口上）。
 *   它与超时**共用同一套收尾**：清 timer、摘监听、kill 环境。
 *   区别只在错误码 —— `call_timeout` 是「预算用完了」，`call_cancelled` 是「调用方喊停」。
 *   把两者混成一个码，消费方就分不清「我这个调用是不是自己取消的」。
 */
async function awaitReply({ channel, kill }, { mode, timeoutMs, pluginId, nonce }, onAbort) {
  let timer = null;
  let onMessage = null;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new CordiumError(ErrorCode.CALL_TIMEOUT,
          `Plugin '${pluginId}' isolated call timed out after ${timeoutMs}ms (${mode} terminated)`, { pluginId }));
      }, timeoutMs);
      // ★ 取消出口：与超时**共用** finally 的清理（清 timer / 摘监听 / kill）。
      //   `settled` 防重复拒绝 —— 取消与真回包可能同时到达（竞态），
      //   先到的那方赢，后到的必须被丢弃而不是当成协议错误。
      if (onAbort) onAbort(() => {
        reject(new CordiumError(ErrorCode.CALL_CANCELLED,
          `Plugin '${pluginId}' isolated call cancelled (${mode} terminated)`, { pluginId }));
      });
      // ★ 用 on + 手动摘除，不用 once：隔离内代码自己发的（无 / 错 nonce）消息可能先到，
      //   一旦被 once 消费掉，真回包来了就没人接、只能等超时。nonce 不匹配的一律忽略。
      onMessage = (msg) => {
        if (msg?.nonce !== nonce) return;
        channel.off('message', onMessage);
        if (msg?.ok) return resolve(msg.value);
        // ★ 隔离端回来的栈指向插件文件：报文里带上源头位置，cause.stack 保留全栈（跨进程也能定位到行）
        // ★★ 【本条路径】（隔离端回了一条失败报文）的 `cause` 是【wire DTO】不是活体 Error：
        //   `{ ok, name, code, message, stack }`，每个字段都是隔离端 `field()` 强制过的**原始字符串**
        //   （非字符串回退默认值）。**这不是不一致，是有意的形态** ——
        //   · 跨边界时，**Error 的原型本就带不过来**，能带过来的只有值。而 `structuredClone` 对 Error
        //     只保证 `name` / `message` / `stack` —— **自定义属性 `code` 会丢**（Node 实测）。
        //     所以隔离端**主动把 `code` 抽成普通对象**：**DTO 才是能无损携带 `code` 的形态**。
        //   ⇒ 消费方读 `cause.code` / `cause.message` / `cause.stack`，**不要用 `instanceof Error` 判**。
        //   ⇒ `errorDetails()`（本仓唯一的通用 cause 消费者）走的是鸭子类型 `readField`，两种形状**逐字段等价**。
        // ⚠️ **`cause` 的形状是【分路径】的，别把本条推广到全部失败**（下面三条分支里，**只有崩溃那条挂 cause**）：
        //   · 隔离环境崩溃（`channel.once('error')`）⇒ cause 是**活体 Error**，其 `code` 是 Node / OS 码（`ERR_*` / `E*`）；
        //   · 无结果退出（`channel.once('exit')`）与超时 ⇒ **不挂 cause**。
        //   进程内那两条路径（action / service）的 cause 同样是活体 Error（对象没跨过边界）。
        // ⚠️ 安全：只搬运已清洗的原始字符串，**绝不把 wire 上的对象引用挂成 cause**
        //   （vm2 CVE-2026-47686：未清洗的 `Error.cause` 可遍历到宿主对象 ⇒ 沙箱逃逸 RCE）。
        const at = firstFrame(msg?.stack);
        reject(new CordiumError(ErrorCode.ISOLATED_CALL_FAILED,
          `Plugin '${pluginId}' isolated call failed: ${msg?.name ?? 'Error'}${msg?.code ? ` [${msg.code}]` : ''}: ${msg?.message ?? ''}${at ? ` (at ${at})` : ''}`,
          { pluginId, cause: msg }));
      };
      channel.on('message', onMessage);
      channel.once('error', err => reject(new CordiumError(ErrorCode.ISOLATED_CALL_FAILED,
        `Plugin '${pluginId}' isolated ${mode} crashed: ${describeError(err)}`, { pluginId, cause: err })));
      channel.once('exit', code => reject(new CordiumError(ErrorCode.ISOLATED_CALL_FAILED,
        `Plugin '${pluginId}' isolated ${mode} exited (code ${code}) without a result`, { pluginId })));
    });
  } finally {
    clearTimeout(timer);
    if (onMessage) channel.off('message', onMessage);
    await kill();
  }
}
