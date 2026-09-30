/**
 * @file packages/kernel/test/fixtures/inspect.mjs
 * @description 测试侧的只读观察工具 —— **只走宿主公开 API**（getDiagnostics / getUIContributions）。
 *
 * ★ 为什么不在宿主上开 `__test_*` 访问器：
 *   那是「为测试而存在的接口」—— 与 channel.mjs 删除 `bindScopeParent` 同一口径。
 *   测试能观察到的，必须是下游使用者也能观察到的；观察不到的内部细节，不该被测试钉死。
 */

/** 插件的诊断视图（公开） */
export function pluginInfo(host, pluginId) {
  return host.getDiagnostics().plugins.find((p) => p.id === pluginId);
}

/** 插件当前生命周期状态 */
export function pluginState(host, pluginId) {
  return pluginInfo(host, pluginId)?.state;
}

/** 服务契约的诊断视图：{ name, access, requiredPermission, ... } */
export function contractInfo(host, serviceName) {
  return host.getDiagnostics().services.find((s) => s.name === serviceName);
}

/** 按 id 取一条 UI 贡献项 */
export function uiItem(host, id) {
  return host.getUIContributions().find((c) => c.id === id);
}

/** 某事件当前的监听器数（经诊断摘要；host.channel 已私有） */
export function listenerCount(host, name) {
  return host.getDiagnostics().channel.listeners.find((l) => l.name === name)?.count ?? 0;
}

/**
 * 某作用域键的父级（经诊断摘要）。
 * @returns {string | null | undefined} `null` = 顶层；`undefined` = 未声明（与 MessageChannel.scopeParentOf 同口径）
 */
export function scopeParentOf(host, key) {
  const entry = host.getDiagnostics().channel.scopes.find((s) => s.key === String(key));
  return entry ? entry.parent : undefined;
}

/** 最近 20 条审计日志里第一条满足 `predicate` 的（经诊断副本；host.auditLogs 已私有） */
export function findLog(host, predicate) {
  return host.getDiagnostics().recentLogs.find(predicate);
}
