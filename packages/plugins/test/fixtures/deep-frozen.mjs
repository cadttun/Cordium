/**
 * @file packages/kernel/test/fixtures/deep-frozen.mjs
 * @description 「公开面 / 契约必须【逐层】冻结」的共用判据。
 *
 * ★★ 本文件在**两个包各存一份**（`packages/kernel/test/fixtures/` 与 `packages/plugins/test/fixtures/`），
 *   **内容逐字节相同** —— 由 `packages/kernel/test/boundary.test.mjs` 的漂移门禁钉住。
 *   · 为什么不共用一份：本仓有硬门禁「**跨包引用只走包名**」，测试目录里出现 `../../kernel/…`
 *     一律判红（`boundary.test.mjs`）；而 `@cordium/kernel/internal` 同样只许 `plugins/src` 引。
 *   · 为什么不放进 `src/` 经 `internal.mjs` 导出：那会造出一个**生产调用点为零**的接口 ——
 *     正是本仓删除 `bindScopeParent` / `__test_*` 时点名的「为测试而存在的接口」。
 *   ⇒ 剩下的选择就是各存一份 + **用门禁防漂**（本仓对「手抄会漂」的一贯解法）。
 *
 * ★ 为什么不放进 `src/` 经 `internal.mjs` 导出：那会造出一个**生产调用点为零**的接口 ——
 *   正是本仓删除 `bindScopeParent` / `__test_*` 时点名的「为测试而存在的接口」。
 *
 * ★ 遍历口径与 `src/host-util.mjs` 的 `deepFreeze` **刻意保持一致**：
 *   `Reflect.ownKeys`（含 symbol 与不可枚举）、**跳过访问器**（读 getter = 执行任意代码）、
 *   `WeakSet` 防环、**不进入函数**（冻共享函数对象是更大的副作用）。
 *   口径若漂了，「源码已逐层冻结」与「门禁认为已逐层冻结」就会各说各话。
 */

/**
 * 不可接受的容器：`Object.freeze` 对它们**要么无效、要么直接抛**。
 * ★ 关键：`Object.isFrozen(new Map())` 是 `true`，但 `map.set()` 照样生效 ——
 *   只看 `isFrozen` 会把一个冻结的 Map 当成「不可变常量」放行，正是本仓点名过的假安全。
 * @returns {boolean}
 */
export function isOpaqueContainer(value) {
  if (value instanceof Map || value instanceof Set) return true;
  if (value instanceof WeakMap || value instanceof WeakSet) return true;
  if (ArrayBuffer.isView(value)) return true;              // TypedArray / DataView：有元素时 freeze 直接抛
  if (value instanceof ArrayBuffer) return true;
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) return true;
  if (value instanceof Promise) return true;
  return false;
}

/**
 * 递归收集「本层及以下」所有不合规的容器路径。
 * @param {unknown} value 待检值
 * @param {string} path 供报错定位的路径
 * @returns {string[]} 不合规路径（空数组 = 全合规）
 */
export function unfrozenPaths(value, path) {
  return walk(value, path, new Set(), []);
}

function walk(value, path, seen, bad) {
  if (value === null || typeof value !== 'object') return bad;   // 标量 / 函数：叶子
  if (seen.has(value)) return bad;                              // 防环 + 共享引用去重
  seen.add(value);
  if (isOpaqueContainer(value)) {
    bad.push(`${path} —— 不透明容器 ${value.constructor?.name ?? '?'}：freeze 对它无效或直接抛，不得出现在公开面`);
    return bad;
  }
  if (!Object.isFrozen(value)) bad.push(`${path} —— 未冻结`);
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc && !('value' in desc)) continue;                   // ★ 访问器：不读，避免执行 getter
    walk(value[key], `${path}.${String(key)}`, seen, bad);
  }
  return bad;
}

/** 判据：函数 / 字符串 / 数字 / 布尔 是叶子；其余必须逐层冻结且不含不透明容器 */
export function isAcceptableExport(value) {
  const kind = typeof value;
  if (kind === 'function' || kind === 'string' || kind === 'number' || kind === 'boolean') return true;
  return unfrozenPaths(value, 'x').length === 0;
}
