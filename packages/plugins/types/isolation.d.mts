/**
 * 读 / 改本进程 callIsolated 的三道闸。不传参 ⇒ 只读。改动立即生效（上限调大会马上放行排队中的调用）。
 * @param {{ maxConcurrent?: number, maxQueued?: number, maxPendingBytes?: number }} [next] 只改给出的键
 * @returns {Readonly<{ maxConcurrent: number, maxQueued: number, maxPendingBytes: number }>} 生效后的上限
 */
export { IsolationCode } from './isolation-codes.mjs';
export declare function configureIsolation(next: any): Readonly<{
    maxConcurrent: number;
    maxQueued: 256;
    maxPendingBytes: number;
}>;
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
export declare function callIsolated(module: string | URL, exportName?: string, args?: any[], options?: {
    mode?: 'worker' | 'process';
    timeoutMs?: number;
    pluginId?: string;
    allowFsRead?: string[];
    allowFsWrite?: string[];
    maxMemoryMb?: number;
    transfer?: ArrayBuffer[];
}): Promise<any>;
