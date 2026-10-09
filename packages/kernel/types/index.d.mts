/**
 * @file packages/kernel/src/index.mjs
 * @description @cordium/kernel 公开导出
 *
 * ★ 显式具名导出，不再 `export *`。
 *   `export *` 会让每个模块里新加的 export 自动变成公开 API —— 公开面随手可涨、没人拍板。
 *   现在新增公开成员必须改这里，并同步改 test/public-surface.test.mjs 的清单。
 *   内部共享的工具（两层 manifest 共用的归一化 / 字段比对等）见 `./internal.mjs`。
 */
export { CordiumHost } from './host.mjs';
export { LifecycleState, ServiceAccess, SERVICE_ACCESS_VALUES, PluginKind, PLUGIN_KIND_VALUES, ActivationPolicy, ACTIVATION_POLICY_VALUES, LogLevel, LOG_LEVEL_VALUES, KERNEL_API_VERSION, HOST_CALLER, UnresolvedReason, UNRESOLVED_REASON_VALUES, validateManifest, DIAGNOSTICS_CONTRACT } from './types.mjs';
export { isValidSemVer, compareSemVer, satisfiesSemVer } from './semver-api.mjs';
export { CordiumError, ErrorCode } from './errors.mjs';
export { MessageChannel, DispatchMode, isBailed } from './channel.mjs';
export { EffectScope } from './scope.mjs';
export type PluginContext = import('./host.mjs').PluginContext;
export type HostEvents = import('./host.mjs').HostEvents;
/** @typedef {import('./host.mjs').PluginContext} PluginContext */
/** @typedef {import('./host.mjs').HostEvents} HostEvents */
