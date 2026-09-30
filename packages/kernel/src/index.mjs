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
export {
  LifecycleState,
  ServiceAccess,
  SERVICE_ACCESS_VALUES,
  PluginKind,
  PLUGIN_KIND_VALUES,
  KERNEL_API_VERSION,
  validateManifest
} from './types.mjs';
// 经 semver-api 转出 —— 非法输入抛带码的 CordiumError，不是裸 TypeError
export { isValidSemVer, compareSemVer, satisfiesSemVer } from './semver-api.mjs';
// 唯一错误类 + 码表（调用方按 err.code 分支，不按报文）
export { CordiumError, ErrorCode } from './errors.mjs';

// 可脱离宿主单独使用的两块积木
export { MessageChannel, DispatchMode, isBailed } from './channel.mjs';
export { EffectScope } from './scope.mjs';
