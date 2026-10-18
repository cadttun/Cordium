export { IsolationCode } from './isolation-codes.mjs';
/**
 * 读 / 改本进程 callIsolated 的三道闸。不传参 ⇒ 只读。改动立即生效（上限调大会马上放行排队中的调用）。
 * @param {{ maxConcurrent?: number, maxQueued?: number, maxPendingBytes?: number }} [next] 只改给出的键
 * @returns {Readonly<{ maxConcurrent: number, maxQueued: number, maxPendingBytes: number }>} 生效后的上限
 */
export declare function configureIsolation(next?: {
    maxConcurrent?: number;
    maxQueued?: number;
    maxPendingBytes?: number;
}): Readonly<{
    maxConcurrent: number;
    maxQueued: number;
    maxPendingBytes: number;
}>;
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
 * @param {object} [options]
 * @param {'worker'|'process'} [options.mode='worker']
 * @param {number} [options.timeoutMs=3000] 超时即**终止**隔离环境（不是停止等待）
 * @param {string} [options.pluginId='unknown'] 报错归属
 * @param {readonly string[]} [options.allowFsRead=[]] 仅 `process`：额外可读路径（模块自身所在目录自动放行）
 * @param {readonly string[]} [options.allowFsWrite=[]] 仅 `process`：可写路径
 * @param {number} [options.maxMemoryMb=1024] 隔离环境的 JS 堆上限（MB）；超了只终止这个环境 ⇒ isolated_call_failed。
 *   ⚠️ ArrayBuffer / Buffer 的数据不在 JS 堆里，不受此限（Node 的限制，实测）。
 * @param {readonly ArrayBuffer[]} [options.transfer=[]] 仅 `worker`：**移交**而非复制的 ArrayBuffer（**必须**出现在 args 里）。
 *   不在 args 里的 buffer 会被静默 detach 成数据丢失 ⇒ 带码拒绝。移交后调用方手里那块内存被清空（byteLength 变 0）—— 这是零拷贝的代价，调用后别再用它。
 * @returns {{ promise: Promise<any>, cancel: (reason?: string) => boolean }}
 *   `cancel` 返回 true = 这次调用确实被取消了；false = 它已经结束（成功 / 失败 / 超时 / 取消过）
 * @throws {CordiumError} `isolation_busy`：排队已满或在途字节超限（见 configureIsolation）—— **未起任何环境**（零副作用）；重试口径见 `@cordium/kernel` 的 `retry-class.mjs`
 */
export declare function startIsolated(module: string | URL, exportName?: string, args?: readonly any[], options?: {
    mode?: 'worker' | 'process';
    timeoutMs?: number;
    pluginId?: string;
    allowFsRead?: readonly string[];
    allowFsWrite?: readonly string[];
    maxMemoryMb?: number;
    transfer?: readonly ArrayBuffer[];
}): {
    promise: Promise<any>;
    cancel: (reason?: string) => boolean;
};
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
 * @param {object} [options] 同 `startIsolated`
 * @returns {Promise<any>}
 */
export declare function callIsolated(module: string | URL, exportName?: string, args?: readonly any[], options?: object): Promise<any>;
