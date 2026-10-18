export type PluginManifest = import('./types.mjs').PluginManifest;
export type PluginRecord = {
    manifest: PluginManifest;
    state: string;
    disabledByUser?: boolean;
};
export type PluginTable = Map<string, PluginRecord>;
export type UnresolvedReasonValue = 'missing' | 'version_mismatch' | 'cycle' | 'not_running';
export type UnresolvedEntry = {
    id: string;
    reason: UnresolvedReasonValue;
};
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
export declare function isUnrunnableState(state: string, booted: boolean): boolean;
/**
 * 静态可判定的依赖问题：**缺失 / 版本不符**。
 * @param {PluginTable} plugins
 * @param {PluginManifest} manifest
 */
export declare function staticUnresolved(plugins: PluginTable, manifest: PluginManifest): any[];
/**
 * 依赖图 —— 纯查询，不改任何状态。
 * 边集与 `orderingEdges` **一致**（必需依赖 + 已注册且版本满足的可选依赖），
 * 否则「诊断说没环、拓扑排序说有环」就成了另一种不同源。
 * @param {PluginTable} plugins
 * @returns {{ reach: (id: string) => Set<string> }}
 */
export declare function dependencyGraph(plugins: PluginTable): {
    reach: (id: string) => Set<string>;
};
/**
 * 全部未满足依赖（静态两类 + 环 + 此刻跑不起来）。
 * @param {PluginTable} plugins
 * @param {string} id
 * @param {PluginManifest} manifest
 * @param {(id: string) => Set<string>} reach
 * @param {boolean} booted
 * @returns {UnresolvedEntry[]}
 */
export declare function unresolvedDependencies(plugins: PluginTable, id: string, manifest: PluginManifest, reach: (id: string) => Set<string>, booted: boolean): UnresolvedEntry[];
/**
 * 一个插件参与排序的依赖边（被依赖方 id 列表）。必选依赖缺失 / 版本不符 ⇒ 抛错。
 * ★ 纯查询：只抛错，不改任何记录的 state。
 * @param {PluginTable} plugins
 * @param {string} id
 * @param {PluginManifest} manifest
 */
export declare function orderingEdges(plugins: PluginTable, id: string, manifest: PluginManifest): string[];
/**
 * 拓扑排序解析插件加载顺序，并检查循环/缺失依赖。
 * @param {PluginTable} plugins
 * @returns {string[]} 拓扑排序后的插件 ID 列表
 */
export declare function resolveTopologicalOrder(plugins: PluginTable): string[];
/**
 * 断言插件的**必需依赖**此刻都是 ACTIVE（缺 / 版本不符 / 未激活各报各的码）。
 * @param {PluginTable} plugins
 * @param {string} pluginId
 * @param {PluginRecord} record
 */
export declare function assertDependenciesActive(plugins: PluginTable, pluginId: string, record: PluginRecord): void;
/**
 * 直接依赖 `pluginId`（必需依赖）的插件 ID 列表。
 * @param {PluginTable} plugins
 * @param {string} pluginId
 */
export declare function dependentsOf(plugins: PluginTable, pluginId: string): any[];
/**
 * ★ 同步预检：`pluginId` 是否有**直接**依赖仍停在 `ready`（= 是否需要走异步收拢）。
 * @param {PluginTable} plugins
 * @param {string} pluginId
 */
export declare function hasReadyDependency(plugins: PluginTable, pluginId: string): boolean;
