/**
 * @file packages/plugins/src/isolation-runner.mjs
 * @description `callIsolated` 的隔离端入口（worker 与子进程共用）。包内工具，不在 `exports`。
 *
 * ★ 只用 node: 内置（权限模型不限制内置模块加载）；`process` 档默认只放行本目录与目标模块目录的读权限。
 * 协议：收 `{ href, exportName, args }` → 回 `{ ok: true, value }` 或 `{ ok: false, name, code, message, stack }`，只回一次。
 *   stack：原始错误的栈（截 4KB；非字符串 ⇒ null）—— 主进程据此报出错的插件行号，否则隔离里的错只剩一句话。
 *
 * ★ 不预先 structuredClone(value) 验可克隆（那会把大结果多复制一整遍）：postMessage / send 遇到
 *   不可克隆的值同步抛，在发送处转成 result_not_cloneable 即可。
 * ★ worker 档：结果里的 ArrayBuffer（顶层与一层内的二进制）**移交**回主线程，不复制 ——
 *   本环境发完结果就被终止，这些内存留着也没人用。
 */
import { transferables } from './transferables.mjs';
import { IsolationCode } from './isolation-codes.mjs';

// 被抛出的可以是任何值（undefined / symbol / 无原型对象 / message 是抛错的 getter）：取文本本身不得再抛。
// ★ 不从 @cordium/kernel/internal 取 describeError：process 档的权限模型只放行本目录与目标模块目录的读权限。
const text = (v) => { try { return String(v); } catch { return Object.prototype.toString.call(v); } };
const errorText = (err) => { try { if (err !== null && typeof err === 'object' && 'message' in err) return text(err.message); } catch { /* 见上 */ } return text(err); };
const field = (err, key, fallback) => { try { const v = err?.[key]; return typeof v === 'string' ? v : fallback; } catch { return fallback; } };
const stackText = (err) => { const s = field(err, 'stack', null); return s === null ? null : s.slice(0, 4096); };
const notCloneable = err => ({ ok: false, name: 'DataCloneError', code: IsolationCode.RESULT_NOT_CLONEABLE, message: errorText(err), stack: null });

/**
 * 隔离端收到的请求（协议：`{ href, exportName, args }`）。
 *
 * ⚠️ 它来自 IPC（workerData / process message），**形状未校验**；这里只声明协议约定的字段，
 *   真正的失败（字段缺失 / 导出不是函数）由 `run` 的返回值以码上报。
 *
 * @typedef {object} IsolationRequest
 * @property {string} href
 * @property {string} exportName
 * @property {unknown[]} args 插件函数参数（任意值）
 */

/** @param {IsolationRequest} request */
async function run({ href, exportName, args }) {
  try {
    const mod = await import(href);
    const fn = mod[exportName];
    if (typeof fn !== 'function') {
      return { ok: false, name: 'TypeError', code: IsolationCode.NOT_A_FUNCTION, message: `export '${exportName}' is not a function`, stack: null };
    }
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    return { ok: false, name: field(err, 'name', 'Error'), code: field(err, 'code', null), message: errorText(err), stack: stackText(err) };
  }
}

const { isMainThread, parentPort, workerData } = await import('node:worker_threads');
if (!isMainThread) {
  const reply = await run(workerData);
  try {
    parentPort.postMessage(reply, reply.ok ? transferables(reply.value) : []);
  } catch (err) {
    // 移交失败（如 Node 内部标记为不可移交的 Buffer 池）⇒ 退回复制；复制也不行 ⇒ 不可克隆
    try { parentPort.postMessage(reply); } catch { parentPort.postMessage(notCloneable(err)); }
  }
} else {
  process.once('message', async (request) => {
    // 进程消息类型是宽泛联合，这里是协议约定的请求形状（未校验，见 IsolationRequest）
    const reply = await run(/** @type {IsolationRequest} */ (request));
    const done = () => process.disconnect();
    try { process.send(reply, done); } catch (err) { process.send(notCloneable(err), done); }
  });
}
