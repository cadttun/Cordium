/**
 * @file packages/kernel/src/host-util.mjs
 * @description 宿主用的纯函数（不读宿主状态）：动作超时、manifest 冻结、日志快照。
 *
 * ★ 从 host.mjs 原样搬出。**内部实现，不经 index 导出**；其中与 plugins 包共用的几个
 *   （MAX_TIMER_MS / describeValue / describeError / errorDetails / firstFrame / summarizeCause / readOptions / runWithTimeout / measureValue）经 internal 转出。
 */

import { CordiumError, ErrorCode } from './errors.mjs';

/**
 * Node `setTimeout` 的上限（2³¹-1 ms）。超过它 Node 会【静默改成 1ms】并只打一条进程警告 ⇒ 立即超时。
 * 内核动作超时与 plugins 包的 callWithTimeout / callIsolated 共用这一个常量（经 internal 转出）。
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * 把【任意调用方输入】渲染进报错文本。
 * ★ 不能直接 `${x}` / `String(x)`：symbol 在模板里抛 TypeError，`Object.create(null)` 在两者里都抛 ——
 *   于是本该是带码的 CordiumError，调用方拿到的却是引擎级 TypeError（实测）。
 * @param {unknown} value
 * @returns {string}
 */
export function describeValue(value) {
  try { return String(value); } catch { /* 退一步 */ }
  // ★ 兜底也会抛：get 陷阱一律抛错的 Proxy，连 toString.call 读 Symbol.toStringTag 都抛（实测）
  try { return Object.prototype.toString.call(value); } catch { return '[unprintable value]'; }
}

/**
 * 把【任意被抛出的值】渲染成一句话（有 message 取 message，否则同 describeValue）。
 * ★ 第三方代码可以 `throw undefined` / `throw null` / `throw Symbol()`：此前各处写 `err.message` /
 *   `${err?.message ?? err}`，碰上这些值在【错误处理路径里】再抛 TypeError —— 实测：
 *   隔离环境里 `throw undefined` 打崩宿主进程；清理回调 `throw Symbol()` 让停用卡在 stopping、
 *   后续 disposer 全部不跑（监听器泄漏）。⇒ 错误路径上一律经本函数取文本。
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
  try {
    if (err !== null && typeof err === 'object' && 'message' in err) return describeValue(err.message);
  } catch { /* message 是抛错的 getter / Proxy：退回整体描述 */ }
  return describeValue(err);
}

/**
 * 栈里第一条「不是内核 / 不是 Node 内部」的帧 —— 即出错的**插件代码位置**（`file:line:col`）。
 * 找不到（抛的是字符串 / 栈全在内核里）⇒ null。
 * ★ 按【文件路径】排除内核帧，不按函数名：插件里也可以有叫 dispatch 的函数。
 * @param {unknown} stack
 * @returns {string | null}
 */
export function firstFrame(stack) {
  if (typeof stack !== 'string') return null;
  for (const line of stack.split('\n')) {
    const m = /^\s*at (?:.*? \()?(.+?:\d+:\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const loc = m[1];
    if (loc.startsWith('node:') || KERNEL_FRAME.test(loc)) continue;
    return loc;
  }
  return null;
}
// 内核自身源文件（packages/kernel/src 或安装后的 @cordium/kernel/src）
const KERNEL_FRAME = /[\\/](?:kernel|@cordium[\\/]kernel)[\\/]src[\\/][\w.-]+\.mjs:\d+:\d+$/;

/**
 * 把一个被抛出的值整理成**可定位**的日志 details：码、插件、位置、栈，沿 `cause` 链逐层展开。
 *
 * ★ 为什么需要：后台失败（emit 监听器、清理回调、生命周期钩子）没有调用方可以 catch，
 *   只进宿主日志 —— 此前日志里只有一句 message，看不出是哪个插件、哪一行。
 * ★ 任何怪值（throw undefined / Symbol / 抛错的 getter / Proxy）都不得让这里再抛：错误路径上的工具。
 * ★ 有界：cause 链只展开头 4 层 + 尾 4 层（中间记个数）、每段栈截 4KB —— 递归派发的信封链可以上万层。
 *
 * @param {unknown} err
 * @returns {{ error: string, code?: string, pluginId?: string, at?: string, stack?: string, causes?: object[] }}
 */
export function errorDetails(err) {
  // 先走完整条链（只取引用，便宜）；展开时只展开【头 4 层 + 尾 4 层】——
  // 原始错误（带插件行号的那个）在链的最【尾】，只展开头部会恰好丢掉它。
  const chain = [err];
  const seen = new Set([err]);
  for (let cur = err; chain.length < MAX_CAUSE_WALK;) {
    const next = readField(cur, 'cause');
    if (next === undefined || next === null || seen.has(next)) break;
    seen.add(next);
    chain.push(next);
    cur = next;
  }
  const keep = chain.length <= MAX_CAUSE_LAYERS ? chain
    : [...chain.slice(0, MAX_CAUSE_LAYERS / 2), ...chain.slice(-MAX_CAUSE_LAYERS / 2)];
  const layers = keep.map(describeLayer);
  const [head, ...causes] = layers;
  // at = 【最深一层】的插件位置 = 出错源头。信封自己的栈指向「谁调的派发」，不是「哪一行坏了」（各层自己的 at 仍在 causes 里）
  const at = [...layers].reverse().find(l => l.at)?.at;
  if (at) head.at = at;
  if (causes.length) head.causes = causes;
  if (chain.length > keep.length) head.omittedCauses = chain.length - keep.length;
  return head;
}
const MAX_CAUSE_LAYERS = 8;
const MAX_CAUSE_WALK = 100_000;
const MAX_STACK_CHARS = 4096;

function readField(obj, key) {
  try { return obj !== null && (typeof obj === 'object' || typeof obj === 'function') ? obj[key] : undefined; } catch { return undefined; }
}

function describeLayer(err) {
  const layer = { error: describeError(err) };
  const name = readField(err, 'name');
  if (typeof name === 'string' && name) layer.error = `${name}: ${layer.error}`;
  const code = readField(err, 'code');
  if (typeof code === 'string') layer.code = code;
  const pluginId = readField(err, 'pluginId');
  if (typeof pluginId === 'string') layer.pluginId = pluginId;
  const stack = readField(err, 'stack');
  if (typeof stack === 'string') {
    const at = firstFrame(stack);
    if (at) layer.at = at;
    layer.stack = stack.length > MAX_STACK_CHARS ? `${stack.slice(0, MAX_STACK_CHARS)}…` : stack;
  }
  return layer;
}

/**
 * 把「下层抛出的东西」压成报文里的一小段（信封报文用）。
 * ★ 只取下层的【码】或截断的一句话，不拼它的完整报文：嵌套派发时每层都包一次，
 *   若逐层拼接完整报文，报文长度随嵌套层数平方增长（1 万层递归 ⇒ GB 级字符串）。
 *   完整信息在 `cause` 链上，一条不丢。
 * @param {unknown} err
 * @returns {string}
 */
export function summarizeCause(err) {
  if (err instanceof CordiumError) return `[${err.code}]`;
  const text = describeError(err);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * 读取调用方传入的选项对象：`undefined` / `null` ⇒ `{}`；其它非普通对象（字符串 / 数字 / 数组 / 函数）⇒ 抛 `code`。
 *
 * ★ 此前各入口写 `options ?? {}` 后直接解构：传 `'abc'` / `[1]` / `5` **静默通过**，所有选项落回默认值，
 *   调用方以为设了超时 / 回调，其实一个都没生效（实测：两包 7 个入口全部如此）。
 * ★ 读一次落成快照：抛错的 getter 在这里转成带码错误；之后只看快照（同一个值不会读出两种结果）。
 *
 * @param {unknown} options
 * @param {string} where 报错前缀
 * @param {string} [code=ErrorCode.INVALID_ARGUMENT]
 * @returns {Record<string, any>}
 */
export function readOptions(options, where, code = ErrorCode.INVALID_ARGUMENT) {
  if (options === undefined || options === null) return {};
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new CordiumError(code, `${where}: options must be an object, got ${Array.isArray(options) ? 'array' : typeof options}`);
  }
  try {
    return { ...options };
  } catch (err) {
    throw new CordiumError(code, `${where}: options could not be read (${describeError(err)})`, { cause: err });
  }
}

/**
 * 给一个可能永不 resolve 的任务加执行上限。
 *
 * 为什么需要：插件处理器是第三方代码，死循环 await、外部依赖挂起都会让
 * dispatchAction 永久挂起并连带卡住调用方。超时后必须以明确错误返回，
 * 而不是静默吞掉——否则调用方无法区分"还在跑"与"已经废了"。
 *
 * 内核动作、生命周期钩子与 plugins 包的 `callWithTimeout` 共用这一份（经 internal 转出）。
 *
 * ★ 为什么不用 `AbortSignal.timeout`：它挂着 abort 监听器时，计时器在到期前一直钉住 signal，
 *   且无法提前取消（MDN 原文），3 万次 30s 超时的调用 gc 后仍多占约 30MB；
 *   这里在 finally 里 clearTimeout，任务一结束计时器就释放（实测）。
 *
 * @param {() => any} task
 * @param {number} timeoutMs 0 或负数表示不限制
 * @param {() => Error} onTimeout 超时时构造要抛出的错误（各调用方的码不同）
 */
export async function runWithTimeout(task, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await task();
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          // ★ 语义口径（写进注释，避免后人误读）：
          //   当前只是【停止等待】，不代表【取消执行】。
          //   原 Handler 仍会继续跑完，副作用照旧落地 ——
          //   所以有副作用的调用必须自带幂等或版本校验（如乐观锁 / 条件更新）。
          //
          //   内核【有意不引入取消框架】：处理器背后可能跨进程 / 跨语言（IPC、原生调用），
          //   取消信号未必传得到；真正怕的是「超时后重复写世界」，那由幂等 + 版本校验解决。
          reject(onTimeout());
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 本实现【不进入、也不冻结】的容器类型。
 *
 * ★ 按【类型】判断，不按字段名 —— 这是与「手列字段清单」的根本差别：
 *   清单会随 schema 增长而静默漏项；类型判定对新增字段自动成立。
 *
 * 两类原因，都不能靠 Object.freeze 解决：
 *   · **非空 TypedArray 直接抛 TypeError**（"Cannot freeze array buffer views with elements"）——
 *     不是「不可冻结」，是调用会炸，必须绕开；
 *   · Map / Set / ArrayBuffer：冻结【挡不住】它们的内容（`map.set()` 照样生效），
 *     冻了只会给出「已保护」的错觉。
 *
 * @param {any} value
 */
function isOpaqueContainer(value) {
  if (value instanceof Map || value instanceof Set) return true;
  if (value instanceof WeakMap || value instanceof WeakSet) return true;
  if (ArrayBuffer.isView(value)) return true;   // TypedArray / DataView
  if (value instanceof ArrayBuffer) return true;
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) return true;
  if (value instanceof Promise) return true;
  return false;
}

/** 只遍历【数据属性】：访问器一律跳过（读 getter 等于执行任意代码） */
function dataEntries(value) {
  const out = [];
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc && !('value' in desc)) continue;
    out.push([key, value[key]]);
  }
  return out;
}

/**
 * 递归冻结一个值**可达的一切**，返回原对象。
 *
 * ★ 与「手列字段名」的差别：这里**不查字段名**，凡本层容器一律冻到叶 ——
 *   契约表将来新增任何容器字段都自动覆盖，不存在「加了字段忘了同步冻结」这一失效模式。
 *   外部同形做法：规范文档给出的 deepFreeze 用 `Reflect.ownKeys` 递归；能力对象加固库
 *   的 `harden` 明确描述为「传递性反射自有属性遍历」，且**对访问器不调用 getter**。
 *
 * ★ 边界（如实标注）：
 *   · 函数不进入也不冻结 —— 它不是数据契约的一部分，冻一个共享函数对象是不必要的副作用；
 *   · isOpaqueContainer 列出的一律跳过（见其注释）；
 *   · `WeakSet` 防环（自引用对象会让朴素递归栈溢出）。
 *
 * @param {any} value
 * @param {WeakSet<object>} [seen]
 */
export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (isOpaqueContainer(value)) return value;
  for (const [, v] of dataEntries(value)) deepFreeze(v, seen);
  return Object.freeze(value);
}

/**
 * 深拷贝普通容器并冻结副本（原对象不受影响）。
 *
 * ★ 为什么是「拷贝后冻结」而不是「就地冻结」：交付给插件的是**副本**，
 *   就地冻结会连带冻住宿主自己持有的那份（宿主内部状态不该因为「交付一次」而被改变）。
 */
function copyDeepFrozen(value, seen = new WeakMap()) {
  if (value === null || typeof value !== 'object') return value;
  if (isOpaqueContainer(value)) return value;
  if (seen.has(value)) return seen.get(value);
  const out = Array.isArray(value) ? [] : {};
  seen.set(value, out);
  for (const [key, v] of dataEntries(value)) out[key] = copyDeepFrozen(v, seen);
  return Object.freeze(out);
}

/**
 * 为插件交付一份【逐层冻结】的 manifest 副本。
 *
 * 为什么不能只做浅冻结：Object.freeze 是浅的，挡不住 manifest.permissions.push(...) ——
 * 数组本身仍是可变的。冻结后插件再写它会在严格模式（ESM 默认）下直接抛 TypeError，
 * 而不是静默失败。
 *
 * ⚠️ 此前这里是**手列的四个字段名**（provides / dependencies / optionalDependencies / permissions）。
 *   实测：往 manifest 契约表新增一个容器字段后，该字段**不在冻结之列** ——
 *   插件可以直接 push 进内核交付的 manifest，而「逐层冻结」的宣称不成立；
 *   且归一化产物**本身不冻结**这些容器，所以这份清单是唯一防线，漏一项就是真漏。
 *   ⇒ 改为泛化递归，按类型判定，不再依赖任何人记得同步。
 *
 * @param {any} manifest
 */
export function freezeManifestForPlugin(manifest) {
  return copyDeepFrozen({ ...manifest });
}

/**
 * 审计日志 details 的写入快照。
 *
 * ★ 为什么克隆而不是深冻结：冻结挡不住 Map / Set 的 set()，
 *   且 Object.freeze 对非空 TypedArray 直接抛 TypeError。
 *   克隆切断引用即可 —— 读出时再克隆一次（copyLogEntry），两头都不共享。
 *
 * ★ 不可克隆（函数、Proxy 等）时【不抛错】：log() 常在错误路径上被调用，
 *   记日志失败会把原始错误盖掉。退化为一个可见的标记，而不是静默丢掉。
 *
 * ★ 体积上限：日志条数有上限，**单条大小此前没有** ——
 *   插件 `ctx.log('info', …, { rows: 一百万条 })` 实测每条克隆 ~350ms（卡住事件循环），
 *   500 槽写满后常驻 >1GB。超出 LOG_DETAILS_BUDGET 的 details 不克隆，换成可见标记。
 *   先做有界遍历再克隆：判定本身最多看预算那么多个节点，不会被大对象拖慢。
 *
 * @param {any} details
 */
export function snapshotDetails(details) {
  if (details === undefined) return undefined;
  if (exceedsBudget(details, LOG_DETAILS_BUDGET)) {
    return { truncated: true, reason: `details exceed the log budget (${LOG_DETAILS_BUDGET.nodes} nodes / ${LOG_DETAILS_BUDGET.bytes} bytes); log a summary instead` };
  }
  try {
    return structuredClone(details);
  } catch (err) {
    return { unclonable: true, reason: describeError(err) };
  }
}

/** 单条日志 details 的体积上限：节点数（对象 / 数组元素 / Map·Set 项）与字节数（字符串按长度、二进制按底层整块 buffer 且同一块只计一次 —— structuredClone 复制的是整块） */
export const LOG_DETAILS_BUDGET = Object.freeze({ nodes: 10_000, bytes: 1_048_576 });

/** 单条日志 details 是否超出预算：有界测量，最多看 `budget.nodes` 个节点，与对象实际大小无关 */
function exceedsBudget(value, budget) {
  const m = measureValue(value, { maxNodes: budget.nodes, stopAtBytes: budget.bytes, stopAtTruncate: true });
  return m.truncated || m.bytes > budget.bytes;
}

// ════════════════ 有界测量（日志预算与 plugins 的在途字节限额共用）════════════════

/** 二进制所在的底层 buffer（结构化克隆复制的是整块 buffer，不只是视图那一段）；不是二进制时为 null */
function backingBuffer(v) {
  if (v instanceof ArrayBuffer || v instanceof SharedArrayBuffer) return v;
  return ArrayBuffer.isView(v) ? v.buffer : null;
}

/**
 * 叶子节点的字节数；容器（要展开子项的对象）返回 null。
 * 字符串按长度，其它标量 8 字节；二进制按整块底层 buffer，同一块只计一次（记在 seen 里）。
 */
function leafBytes(v, seen) {
  if (typeof v === 'string') return v.length;
  if (v === null || typeof v !== 'object') return 8;
  const buffer = backingBuffer(v);
  if (buffer === null) return null;
  if (seen.has(buffer)) return 0;
  seen.add(buffer);
  return buffer.byteLength;
}

/**
 * 把容器的子项交给 push；push 返回 false（到上限）时立即停。返回是否完整展开。
 * ★ 故意写成三段直接循环，不抽成生成器 `childrenOf`：每次 ctx.log 都走这里，
 *   实测生成器版慢 2～5 倍（Node 20 / 24，小对象到 1 万节点），换来的只是复杂度分数好看。
 */
function pushChildren(v, push) {
  if (v instanceof Map) {
    for (const [k, x] of v) if (!push(k) || !push(x)) return false;
  } else if (v instanceof Set || Array.isArray(v)) {
    for (const x of v) if (!push(x)) return false;
  } else {
    for (const k in v) if (Object.hasOwn(v, k) && !push(v[k])) return false;
  }
  return true;
}

/**
 * 有界测量一个值的大致体积（不求精确，用于限额判定）：
 *   · 最多访问 `maxNodes` 个节点（含已压栈未处理的）—— 大数组 / Map 不会先被整个展开；
 *   · 累计字节超过 `stopAtBytes` 立即停；
 *   · 环与重复引用只走一次；容器本身不计字节。
 * 取值抛错的怪对象（抛错的 getter / Proxy 陷阱）跳过该节点，不抛 —— 真正克隆时自会报错。
 *
 * @param {any} value
 * @param {{ maxNodes: number, stopAtBytes?: number, stopAtTruncate?: boolean }} limits
 *   stopAtTruncate：一触上限就返回（只关心「超没超」时用；此时 bytes 无意义）
 * @returns {{ bytes: number, truncated: boolean }} truncated：因任一上限提前停下（此时 bytes 偏小）
 */
export function measureValue(value, { maxNodes, stopAtBytes = Infinity, stopAtTruncate = false }) {
  let bytes = 0;
  let nodes = 0;
  let truncated = false;
  const seen = new Set();
  const stack = [value];
  const push = x => {
    if (stack.length + nodes >= maxNodes) return false;
    stack.push(x);
    return true;
  };
  while (stack.length) {
    const v = stack.pop();
    nodes += 1;
    try {
      const leaf = leafBytes(v, seen);
      if (leaf !== null) bytes += leaf;
      else if (!seen.has(v)) {
        seen.add(v);
        // ★ 只要「超没超」的调用方：大数组 / Map / Set 按容量一步判超，不逐项压栈
        //   （2 万元素数组：逐项压到上限约 100µs，按容量判 <0.1µs —— 合并前 exceedsBudget 就是这么做的）
        if (stopAtTruncate && stack.length + nodes + containerSize(v) > maxNodes) return { bytes, truncated: true };
        if (!pushChildren(v, push)) {
          if (stopAtTruncate) return { bytes, truncated: true };
          truncated = true;
        }
      }
    } catch { /* 见 JSDoc：怪对象跳过 */ }
    if (bytes > stopAtBytes) return { bytes, truncated: true };
  }
  return { bytes, truncated };
}

/** 能直接读出的子项数（Map 的键和值各算一个）；普通对象读不出来，记 0（逐键压栈时照样受上限约束） */
function containerSize(v) {
  if (Array.isArray(v)) return v.length;
  if (v instanceof Set) return v.size;
  return v instanceof Map ? v.size * 2 : 0;
}

/**
 * 对外交出一条日志的副本（诊断只读快照，不是审计记录的写入口）。
 * details 写入时已是快照，必然可克隆。
 */
export function copyLogEntry(entry) {
  const copy = { ...entry };
  if (entry.details !== undefined) copy.details = structuredClone(entry.details);
  return copy;
}
