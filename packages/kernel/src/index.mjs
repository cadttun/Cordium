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
  ActivationPolicy,
  ACTIVATION_POLICY_VALUES,
  LogLevel,
  LOG_LEVEL_VALUES,
  KERNEL_API_VERSION,
  // ★ 宿主的调用方身份（`dispatchActionAsHost` 用的就是它）。导出是**承重的**：
  //   消费方要靠它从审计日志里认出「这条是宿主自己干的」，而不是某个插件。
  HOST_CALLER,
  // ★ 诊断快照 `unresolvedDependencies[].reason` 的取值集合。
  //   此前它是纯字面量、没导出 ⇒ 消费方想知道「我认全了没有」只能跨仓读实现或暴力探测。
  //   导出后实现已回改成本常量（`host.mjs` 的产出点与比较点），不是第二真相源。
  UnresolvedReason,
  UNRESOLVED_REASON_VALUES,
  validateManifest,
  // ★ 诊断快照的稳定性契约 —— 消费方**必须**能读到它，否则「哪些字段可信」只能靠人传。
  //   它不是内部实现细节，而正是对外承诺本身（allowlist 形态：点名即承诺）。
  DIAGNOSTICS_CONTRACT
} from './types.mjs';
// 经 semver-api 转出 —— 非法输入抛带码的 CordiumError，不是裸 TypeError
export { isValidSemVer, compareSemVer, satisfiesSemVer } from './semver-api.mjs';
// 唯一错误类 + 码表（调用方按 err.code 分支，不按报文）
export { CordiumError, ErrorCode } from './errors.mjs';

// 可脱离宿主单独使用的两块积木
export { MessageChannel, DispatchMode, isBailed } from './channel.mjs';
export { EffectScope } from './scope.mjs';
