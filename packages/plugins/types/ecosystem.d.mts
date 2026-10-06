/**
 * 规范化依赖映射（**只收 Object**：`{ 'plugin.id': '^1.0.0' }`）
 *
 * ★ 数组形式已取消 —— 数组项写不下版本范围，只能一律当 `'*'`，等于**静默放弃版本约束**。
 *   它与「非法范围字符串」「空串」同源 fail-open；一个字段只留一种形态，解析分支才不会重叠。
 * @param {object} dependencies
 * @returns {Record<string, string>}
 */
export declare function normalizeDependencies(dependencies: object): Record<string, string>;
/**
 * Resolves plugin loading order based on declared dependencies (Topological Sort).
 * Detects missing dependencies, SemVer version mismatch, and cyclic dependency deadlocks.
 *
 * @param {Array<object>} manifests 候选插件 Manifest 列表
 * @param {object} [options]
 * @param {Map<string, { manifest: any, entry?: any }>} [options.existingRegistry] 已注册的插件表
 * @param {(diagnostic: object) => void} [options.onDiagnostic] 丢字段回调 ★ 候选 manifest 时回调（形状同内核 diffManifestFields）
 * @returns {Array<object>} 拓扑排序后的 Manifest 列表
 */
export declare function resolvePluginDependencies(manifests?: Array<object>, options?: {
    existingRegistry?: Map<string, {
        manifest: any;
        entry?: any;
    }>;
    onDiagnostic?: (diagnostic: object) => void;
}): Array<object>;
/**
 * 以超时上限调用插件函数。
 *
 * ⚠️ **这里没有任何隔离**：
 *   · 超时只是【停止等待】—— 原函数仍在同一进程里继续执行，副作用照旧落地；
 *   · 同步死循环无法被打断（事件循环被占住，计时器根本没机会触发）。
 *   需要真正隔离请用 worker / 子进程（`node:vm` 不行 —— Node 官方文档明言它不是安全机制）。
 *
 * ★ 计时实现与内核动作超时合并为一份（`runWithTimeout`，经 internal 取）；签名与 `call_timeout` 码不变。
 *
 * ★ 原名 `runSandboxedPluginCall`，名字暗示隔离而实际没有 ⇒ 名实不符，
 *   内核未发布，不保留旧名别名。
 *
 * @param {(...args: unknown[]) => unknown} fn 被调用的插件函数
 * @param {unknown[]} [args=[]] 透传给 fn 的参数（任意值，由调用方自定）
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000] 必须是 (0, 2^31-1] 内的有限数；
 *   此前传 Infinity / NaN / 过大值会被 Node 静默改成 1ms ⇒ 立即超时（实测）。
 */
export declare function callWithTimeout(fn: (...args: unknown[]) => unknown, args?: unknown[], options?: {
    timeoutMs?: number;
}): Promise<any>;
