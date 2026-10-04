// Plugin Ecosystem: dependency normalization, topological resolution, and timeout-bounded calls.
// ⚠️ No isolation here — see `callWithTimeout`. Follows Cordium kernel neutrality.

import { validatePluginManifestDetailed } from './runtime.mjs';
import { diagnosticSink } from './diagnostic-sink.mjs';
// ★ 已修：原先这里 `from '../../kernel/src/host.mjs'` —— 插件层【反向依赖内核的具体实现文件】，
//   为拿一个 35 行纯函数得连带加载整个 host.mjs（1600+ 行）。
//   现改为依赖【零依赖的中立模块】，依赖方向回到稳定侧（SDP / DIP）。
//   现经 internal.mjs 取（它只依赖 types / semver，同样不牵 host.mjs）。
// ★★ 与两套 manifest schema 共用同一份【依赖归一化】实现（依赖方向 plugins → kernel，全仓已存在）。
import { satisfiesSemVer, normalizeDependencyMap, CordiumError, ErrorCode, MAX_TIMER_MS, readOptions, runWithTimeout } from '@cordium/kernel/internal';

// 能力词表属于上层应用，不在 cordium（已删除 `PERMITTED_CAPABILITIES` / `checkPluginPermission`，见 design/removed-apis.md §7 / §8）

/**
 * 规范化依赖映射：支持 Object ({ 'plugin.id': '^1.0.0' }) 或 Array (['plugin.id'])
 * @param {object|string[]} dependencies
 * @returns {Record<string, string>}
 */
export function normalizeDependencies(dependencies) {
  // ★★ 归一与类型判定都收敛到内核层共享实现（两套 schema + 本模块**同一套语义**）。
  //    共享实现自己就 fail-loud（`invalid_manifest`）；本函数的前置门只为保留
  //    本模块既有的码 `invalid_dependencies` —— 它是独立入口，调用方传的不一定是 manifest。
  if (dependencies !== undefined && dependencies !== null
      && typeof dependencies !== 'object') {
    throw new CordiumError(ErrorCode.INVALID_DEPENDENCIES, 'dependencies must be an object or an array');
  }
  return normalizeDependencyMap(dependencies);
}

/**
 * Resolves plugin loading order based on declared dependencies (Topological Sort).
 * Detects missing dependencies, SemVer version mismatch, and cyclic dependency deadlocks.
 *
 * @param {Array<object>} manifests 候选插件 Manifest 列表
 * @param {object} [options]
 * @param {Map<string, { manifest: any, entry?: any }>} [options.existingRegistry] 已注册的插件表
 * @param {(diagnostic: object) => void} [options.onDiagnostic] ★ 候选 manifest 丢字段时回调（形状同内核 diffManifestFields）
 * @returns {Array<object>} 拓扑排序后的 Manifest 列表
 */
export function resolvePluginDependencies(manifests = [], options) {
  const { existingRegistry = null, onDiagnostic } = readOptions(options, 'resolvePluginDependencies');
  if (!Array.isArray(manifests)) {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'resolvePluginDependencies: manifests must be an array');
  }
  const allMap = existingItems(existingRegistry);
  const candidateIds = addCandidates(manifests, allMap, diagnosticSink(onDiagnostic));
  return topologicalOrder(candidateIds, allMap);
}

/**
 * 已注册插件录入依赖表：只作为依赖提供者，不作为候选排序返回。
 * ★ 已注册插件视为【已解析完成】—— 不再遍历它们自己的依赖、也不对其做严格校验。
 *   此前会递归进已注册插件：它自身的缺失依赖 / 非法 dependencies 格式
 *   会拖垮一个与之毫不相干的候选。传入非 Map 形状的 registry 则被静默忽略 ⇒ 现在响亮报错。
 */
function existingItems(existingRegistry) {
  const allMap = new Map();
  if (existingRegistry === null || existingRegistry === undefined) return allMap;
  if (typeof existingRegistry.entries !== 'function') {
    throw new CordiumError(ErrorCode.INVALID_REGISTRY, 'existingRegistry must be a Map-like object with entries()');
  }
  for (const [id, item] of existingRegistry.entries()) {
    if (item && item.manifest) allMap.set(id, { manifest: item.manifest, deps: {}, isCandidate: false });
  }
  return allMap;
}

/** 候选与已注册的同 id 插件必须是同一份：版本、apiVersion、权限集合都一致 */
function assertSameAsExisting(existing, validated) {
  if (existing.manifest.version !== validated.version) {
    throw new CordiumError(ErrorCode.VERSION_CONFLICT,
      `Plugin '${validated.id}' version conflict: existing version '${existing.manifest.version}' differs from candidate version '${validated.version}'`,
      { pluginId: validated.id }
    );
  }
  // ★ 权限是集合语义：比较前排序（此前 ['y','x'] 与 ['x','y'] 被判为实现冲突）
  const perms = m => JSON.stringify([...(m.permissions || [])].sort());
  // ★ 此处曾比较 implementationId —— validatePluginManifest 的白名单不保留该字段，
  //   validated.implementationId 恒为 undefined ⇒ 那一支永远不成立（死代码），已删。
  //   需要按实现来源区分时，先把字段加进插件层 schema（MANIFEST_FIELD_TABLE.plugin）再恢复比较。
  if (existing.manifest.apiVersion !== validated.apiVersion || perms(existing.manifest) !== perms(validated)) {
    throw new CordiumError(ErrorCode.IMPLEMENTATION_CONFLICT,
      `Plugin '${validated.id}' implementation conflict: candidate descriptor differs in apiVersion or permissions`,
      { pluginId: validated.id }
    );
  }
}

/** 校验候选并录入依赖表；候选批次内不得重复。返回候选 id（按输入顺序） */
function addCandidates(manifests, allMap, report) {
  const candidateIds = new Set();
  for (const m of manifests) {
    const { manifest: validated, diagnostic } = validatePluginManifestDetailed(m);
    report(diagnostic);
    if (candidateIds.has(validated.id)) {
      throw new CordiumError(ErrorCode.DUPLICATE_PLUGIN, `Duplicate plugin ID in candidates: '${validated.id}'`, {
        pluginId: validated.id
      });
    }
    if (allMap.has(validated.id)) assertSameAsExisting(allMap.get(validated.id), validated);
    candidateIds.add(validated.id);
    allMap.set(validated.id, { manifest: validated, deps: normalizeDependencies(validated.dependencies), isCandidate: true });
  }
  return candidateIds;
}

/**
 * 校验一条依赖边：被依赖方必须存在且版本满足范围。
 *
 * ★ 无返回值：唯一调用点是拓扑 DFS，它只要「边合法」这个结论，之后自己按 id 取条目。
 *   此前返回 `depItem` 却无人接 —— 一个「算出来就丢掉」的死值。
 *   删掉而不是留着，因为留着会让人以为调用方依赖它。
 */
function checkEdge(allMap, id, depId, expectedRange) {
  const depItem = allMap.get(depId);
  if (!depItem) {
    throw new CordiumError(ErrorCode.MISSING_DEPENDENCY, `Missing required plugin dependency: ${depId}`, { pluginId: depId });
  }
  // ★ 不再对 '*' / 'latest' 直接放行 —— 统一交给 satisfiesSemVer，
  //   与内核 boot()/activatePlugin 判定一致（此前生态层放行的依赖图，宿主启动时会拒绝；
  //   且 '*' 跳过了「预发布版本不满足 *」这条 SemVer 规则）。
  if (!satisfiesSemVer(depItem.manifest.version, expectedRange)) {
    throw new CordiumError(ErrorCode.DEPENDENCY_VERSION_MISMATCH,
      `Version mismatch for dependency '${depId}' required by '${id}': expected '${expectedRange}', but found '${depItem.manifest.version}'`,
      { pluginId: id }
    );
  }
}

/**
 * 候选的拓扑序（依赖在前）。
 * ★ 迭代 DFS（此前递归，依赖链约 5000 层即 RangeError 栈溢出，且不是带码的错误）。
 */
function topologicalOrder(candidateIds, allMap) {
  const resolvedOrder = [];
  const visited = new Set();
  const visiting = new Set();
  const enter = (id, stack) => {
    visiting.add(id);
    stack.push({ id, edges: Object.entries(allMap.get(id).deps), next: 0 });
  };
  const leave = (frame) => {
    visiting.delete(frame.id);
    visited.add(frame.id);
    const item = allMap.get(frame.id);
    if (item.isCandidate) resolvedOrder.push(item.manifest);
  };

  for (const rootId of candidateIds) {
    if (visited.has(rootId)) continue;
    const stack = [];
    enter(rootId, stack);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.next >= frame.edges.length) { leave(stack.pop()); continue; }
      const [depId, expectedRange] = frame.edges[frame.next++];
      checkEdge(allMap, frame.id, depId, expectedRange);
      if (visited.has(depId)) continue;
      if (visiting.has(depId)) {
        throw new CordiumError(ErrorCode.CYCLIC_DEPENDENCY, `Cyclic plugin dependency detected: ${depId}`, { pluginId: depId });
      }
      enter(depId, stack);
    }
  }
  return resolvedOrder;
}

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
 * @param {number} [options.timeoutMs=3000] 必须是 (0, 2^31-1] 内的有限数；
 *   此前传 Infinity / NaN / 过大值会被 Node 静默改成 1ms ⇒ 立即超时（实测）。
 */
export async function callWithTimeout(fn, args = [], options) {
  const { timeoutMs = 3000, pluginId = 'unknown' } = readOptions(options, 'callWithTimeout');
  if (typeof fn !== 'function') {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'callWithTimeout: fn must be a function', { pluginId });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new CordiumError(ErrorCode.INVALID_TIMEOUT,
      `callWithTimeout: timeoutMs must be a finite number in (0, ${MAX_TIMER_MS}], got ${String(timeoutMs)}`,
      { pluginId }
    );
  }
  // 与内核动作超时共用一份实现（race + finally clearTimeout；为什么不用 AbortSignal.timeout 见 runWithTimeout 注释）
  return runWithTimeout(() => fn(...args), timeoutMs, () => new CordiumError(ErrorCode.CALL_TIMEOUT,
    `Plugin '${pluginId}' execution timed out after ${timeoutMs}ms`, { pluginId }));
}
