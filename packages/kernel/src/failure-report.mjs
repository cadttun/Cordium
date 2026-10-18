/**
 * @file packages/kernel/src/failure-report.mjs
 * @description 后台失败的**归因拼装**：把任意 ``unknown`` 错误整理成「码 + 位置 + 原因」的一条可读消息。
 *
 * ── 为什么单独一个文件 ───────────────────────────────────────────────
 *   `#logFailure` **一个 `this.#` 都不引用**（census 得分 0）：它只是
 *   「`errorDetails` 取细节 → 拼 `[码] at 文件:行:列` → 交给 `log`」。
 *   纯函数 ⇒ 无共享状态、无生命周期耦合，可独立单测。
 *
 * ★ 为什么必须存在：后台失败（emit 监听器 / 清理回调 / 生命周期钩子 / 启动回滚）
 *   **没有调用方能 catch**，只能进日志 —— 所以日志必须自己能回答「哪个插件、什么码、哪一行」。
 */
import { errorDetails, describeError } from './host-util.mjs';

/**
 * 把一次后台失败整理成 `log()` 的入参（**不**直接写日志，由调用方决定走哪个出口）。
 *
 * @param {'warn' | 'error'} level
 * @param {string} what 发生了什么（不含原因，原因由本函数拼）
 * @param {unknown} err
 * @param {string | null} [pluginId] 归属插件（宿主已知的真实身份）
 * @returns {{ level: 'warn' | 'error', message: string, details: Record<string, any> }}
 */
export function formatFailure(level, what, err, pluginId = null) {
  const details = errorDetails(err);
  if (pluginId && details.pluginId === undefined) details.pluginId = pluginId;
  const tag = details.code ? ` [${details.code}]` : '';
  const at = details.at ? ` at ${details.at}` : '';
  return { level, message: `${what}: ${describeError(err)}${tag}${at}`, details };
}
