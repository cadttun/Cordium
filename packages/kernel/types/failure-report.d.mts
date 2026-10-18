/**
 * 把一次后台失败整理成 `log()` 的入参（**不**直接写日志，由调用方决定走哪个出口）。
 *
 * @param {'warn' | 'error'} level
 * @param {string} what 发生了什么（不含原因，原因由本函数拼）
 * @param {unknown} err
 * @param {string | null} [pluginId] 归属插件（宿主已知的真实身份）
 * @returns {{ level: 'warn' | 'error', message: string, details: Record<string, any> }}
 */
export declare function formatFailure(level: 'warn' | 'error', what: string, err: unknown, pluginId?: string | null): {
    level: 'warn' | 'error';
    message: string;
    details: Record<string, any>;
};
