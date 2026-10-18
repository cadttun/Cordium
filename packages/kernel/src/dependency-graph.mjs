/**
 * @file packages/kernel/src/dependency-graph.mjs
 * @description 插件依赖图的**纯计算**：拓扑序、未满足依赖、环检测、反向依赖。
 *
 * ── 为什么单独一个文件 ───────────────────────────────────────────────
 *   这一组函数**只读** `plugins` 表（`Map<id, record>`）与一个 `booted` 布尔，
 *   **不改任何记录的状态、不碰生命周期**（见 `orderingEdges` 的注释：此前它会把插件标成
 *   FAILED —— 一个看起来只读的方法带副作用）。职责单一、零共享可变状态 ⇒ 可以安全地
 *   从 `host.mjs` 搬出来，且**可被单测直接调用**。
 *
 * ★ 判据来自重构方法论：**长度不是信号，共享可变状态才是**。
 *   这里全部是「读 → 算 → 返回」，没有一处写 ⇒ 搬家风险最低。
 *
 * ★★ 报文的**错误码与措辞必须与拆分前逐字相同** —— 既有调用方与测试按它们断言。
 */
import { CordiumError, ErrorCode } from './errors.mjs';
import { UnresolvedReason } from './types.mjs';
import { satisfiesSemVer } from './semver.mjs';
import { LifecycleState } from './types.mjs';

/**
 * @typedef {import('./types.mjs').PluginManifest} PluginManifest
 * @typedef {{ manifest: PluginManifest, state: string, disabledByUser?: boolean }} PluginRecord
 * @typedef {Map<string, PluginRecord>} PluginTable
 * @typedef {'missing' | 'version_mismatch' | 'cycle' | 'not_running'} UnresolvedReasonValue
 * @typedef {{ id: string, reason: UnresolvedReasonValue }} UnresolvedEntry
 */

/**
 * 这个状态下的依赖「**此刻跑不起来**」吗？
 * ★ 刻意让 `discovered` 只在 **boot 之后**算数：`boot()` 之前人人都是 `discovered`，
 *   把它一律算进来，会让 boot 前那份纯查询对**所有**有依赖的插件都报「未满足」。
 * @param {string} state
 * @param {boolean} booted
 * @returns {boolean}
 */
export function isUnrunnableState(state, booted) {
  if (state === LifecycleState.DISCOVERED) return booted;
  return state === LifecycleState.READY || state === LifecycleState.DISABLED
    || state === LifecycleState.FAILED || state === LifecycleState.STOPPING;
}

/**
 * 静态可判定的依赖问题：**缺失 / 版本不符**。
 * @param {PluginTable} plugins
 * @param {PluginManifest} manifest
 */
export function staticUnresolved(plugins, manifest) {
  const out = [];
  for (const [depId, expectedRange] of Object.entries(manifest.dependencies || {})) {
    const target = plugins.get(depId);
    if (!target) { out.push({ id: depId, reason: UnresolvedReason.MISSING }); continue; }
    if (!satisfiesSemVer(target.manifest.version, expectedRange)) {
      out.push({ id: depId, reason: UnresolvedReason.VERSION_MISMATCH });
    }
  }
  return out;
}

/**
 * 依赖图 —— 纯查询，不改任何状态。
 * 边集与 `orderingEdges` **一致**（必需依赖 + 已注册且版本满足的可选依赖），
 * 否则「诊断说没环、拓扑排序说有环」就成了另一种不同源。
 * @param {PluginTable} plugins
 * @returns {{ reach: (id: string) => Set<string> }}
 */
export function dependencyGraph(plugins) {
  const edges = new Map();
  for (const [id, record] of plugins.entries()) {
    const out = [];
    for (const [depId, range] of Object.entries(record.manifest.dependencies || {})) {
      const t = plugins.get(depId);
      if (t && satisfiesSemVer(t.manifest.version, range)) out.push(depId);
    }
    for (const [depId, range] of Object.entries(record.manifest.optionalDependencies || {})) {
      const t = plugins.get(depId);
      if (t && satisfiesSemVer(t.manifest.version, range)) out.push(depId);
    }
    edges.set(id, out);
  }
  const cache = new Map();
  const reach = start => {
    if (cache.has(start)) return cache.get(start);
    const seen = new Set();
    const stack = [...(edges.get(start) || [])];
    while (stack.length > 0) {
      const n = stack.pop();
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of edges.get(n) || []) stack.push(m);
    }
    cache.set(start, seen);
    return seen;
  };
  return { reach };
}

/**
 * 全部未满足依赖（静态两类 + 环 + 此刻跑不起来）。
 * @param {PluginTable} plugins
 * @param {string} id
 * @param {PluginManifest} manifest
 * @param {(id: string) => Set<string>} reach
 * @param {boolean} booted
 * @returns {UnresolvedEntry[]}
 */
export function unresolvedDependencies(plugins, id, manifest, reach, booted) {
  const out = staticUnresolved(plugins, manifest);
  const already = new Set(out.map(u => u.id));
  const selfInCycle = reach(id).has(id);
  for (const depId of Object.keys(manifest.dependencies || {})) {
    if (already.has(depId)) continue;                       // 静态问题优先，不重复报
    // ★ 环：本插件与这个依赖**互相可达** ⇒ 这条边在环上
    if (selfInCycle && reach(depId).has(id)) { out.push({ id: depId, reason: UnresolvedReason.CYCLE }); continue; }
    // ★ 依赖在**别的**环上 ⇒ 它永远上不了线，本插件被上游的环挡住
    if (reach(depId).has(depId)) { out.push({ id: depId, reason: UnresolvedReason.NOT_RUNNING }); continue; }
    if (isUnrunnableState(plugins.get(depId)?.state, booted)) out.push({ id: depId, reason: UnresolvedReason.NOT_RUNNING });
  }
  return out;
}

/**
 * 一个插件参与排序的依赖边（被依赖方 id 列表）。必选依赖缺失 / 版本不符 ⇒ 抛错。
 * ★ 纯查询：只抛错，不改任何记录的 state。
 * @param {PluginTable} plugins
 * @param {string} id
 * @param {PluginManifest} manifest
 */
export function orderingEdges(plugins, id, manifest) {
  const unresolved = staticUnresolved(plugins, manifest);
  if (unresolved.length > 0) {
    // ★ 报文与错误码必须与拆分前【逐字相同】—— 既有调用方按它们断言。
    const { id: depId, reason } = unresolved[0];
    if (reason === UnresolvedReason.MISSING) {
      throw new CordiumError(ErrorCode.MISSING_DEPENDENCY, `Missing dependency '${depId}' required by '${id}'`);
    }
    throw new CordiumError(ErrorCode.DEPENDENCY_VERSION_MISMATCH,
      `Version mismatch for dependency '${depId}': expected ${manifest.dependencies[depId]}, got ${plugins.get(depId).manifest.version}`);
  }
  const edges = Object.keys(manifest.dependencies || {});
  // ★ 可选依赖：缺失 ⇒ 跳过，不报错；版本不符 ⇒ 跳过拓扑依赖（运行期视为不可用，
  //   取服务时返回 optional_unavailable）；存在且版本匹配 ⇒ 参与拓扑排序，
  //   保证「提供者先激活」的顺序仍然成立。
  for (const [depId, expectedRange] of Object.entries(manifest.optionalDependencies || {})) {
    const target = plugins.get(depId);
    if (target && satisfiesSemVer(target.manifest.version, expectedRange)) edges.push(depId);
  }
  return edges;
}

/**
 * 拓扑排序解析插件加载顺序，并检查循环/缺失依赖。
 * @param {PluginTable} plugins
 * @returns {string[]} 拓扑排序后的插件 ID 列表
 */
export function resolveTopologicalOrder(plugins) {
  const allIds = Array.from(plugins.keys());
  const inDegree = new Map(allIds.map(id => [id, 0]));
  const adj = new Map(allIds.map(id => [id, []]));
  for (const [id, record] of plugins.entries()) {
    // ★★ 被**显式停用**的插件不参与装配：它的依赖不满足与宿主无关。
    //   此前这里不豁免 `disabledByUser` ⇒ 用户停用一个坏插件后再 boot 仍会因它抛错 ——
    //   而 boot 的激活循环（下面的 `unavailable` 集合）**是认 `disabledByUser` 的**。
    //   同一件事两处判定不一致，后果是外壳最顺手的那个隔离原语（`deactivatePlugin`）失效，
    //   只剩破坏性的 `unregisterPlugin` 一条路。
    if (record.disabledByUser) continue;
    for (const depId of orderingEdges(plugins, id, record.manifest)) {
      adj.get(depId).push(id);
      inDegree.set(id, inDegree.get(id) + 1);
    }
  }

  // Kahn
  const queue = allIds.filter(id => inDegree.get(id) === 0);
  const result = [];
  while (queue.length > 0) {
    const u = queue.shift();
    result.push(u);
    for (const v of adj.get(u)) {
      inDegree.set(v, inDegree.get(v) - 1);
      if (inDegree.get(v) === 0) queue.push(v);
    }
  }

  if (result.length !== allIds.length) {
    const remaining = allIds.filter(id => !result.includes(id));
    throw new CordiumError(ErrorCode.CYCLIC_DEPENDENCY, `Cyclic dependency detected among plugins: ${remaining.join(', ')}`);
  }
  return result;
}

/**
 * 断言插件的**必需依赖**此刻都是 ACTIVE（缺 / 版本不符 / 未激活各报各的码）。
 * @param {PluginTable} plugins
 * @param {string} pluginId
 * @param {PluginRecord} record
 */
export function assertDependenciesActive(plugins, pluginId, record) {
  for (const [depId, range] of Object.entries(record.manifest.dependencies)) {
    const dep = plugins.get(depId);
    if (!dep) {
      throw new CordiumError(ErrorCode.MISSING_DEPENDENCY, `Missing dependency '${depId}' required by '${pluginId}'`);
    }
    if (!satisfiesSemVer(dep.manifest.version, range)) {
      throw new CordiumError(ErrorCode.DEPENDENCY_VERSION_MISMATCH, `Version mismatch for dependency '${depId}': expected ${range}, got ${dep.manifest.version}`);
    }
    if (dep.state !== LifecycleState.ACTIVE) {
      throw new CordiumError(ErrorCode.DEPENDENCY_INACTIVE,
        `Dependency '${depId}' required by '${pluginId}' is not active (state=${dep.state}); activate it first`
      );
    }
  }
}

/**
 * 直接依赖 `pluginId`（必需依赖）的插件 ID 列表。
 * @param {PluginTable} plugins
 * @param {string} pluginId
 */
export function dependentsOf(plugins, pluginId) {
  const out = [];
  for (const [id, rec] of plugins) {
    if (Object.prototype.hasOwnProperty.call(rec.manifest.dependencies, pluginId)) out.push(id);
  }
  return out;
}

/**
 * ★ 同步预检：`pluginId` 是否有**直接**依赖仍停在 `ready`（= 是否需要走异步收拢）。
 * @param {PluginTable} plugins
 * @param {string} pluginId
 */
export function hasReadyDependency(plugins, pluginId) {
  const record = plugins.get(pluginId);
  if (!record) return false;
  return Object.keys(record.manifest.dependencies)
    .some(depId => plugins.get(depId)?.state === LifecycleState.READY);
}
