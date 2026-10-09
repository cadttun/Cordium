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

// ★★ 类型投影（**仅类型，无运行时绑定**）—— 供消费方在 JSDoc / TS 里引用。
//
// 为什么需要：`PluginContext` 是插件作者**唯一必须写对**的那个类型（`activate(ctx)` 的参数），
//   `HostEvents` 是 `host.events` 的形状。但它们在 `host.mjs` 里只是 `@typedef`
//   （**不是运行时值**）⇒ 包入口不转出 ⇒ 消费方**从包入口取不到**这两个类型名
//   （实测消费方只能去引用一个**已删除分叉**的类型名，是条死引用）。
//
// ★ 机制（实测 TS 7.0.2）：`@typedef {import('./host.mjs').X} X` 会被 tsc **自动导出** ——
//   产出 `export type X = import('./host.mjs').X;`，且**不产生运行时绑定**
//   ⇒ 对按 `Object.keys()` 取形状的公开面门禁**零影响**（类型不是值）。
// ★ 正负对照已实测：`ctx.pluginId` 通过 / `ctx.noSuchThing` 报 `TS2339`（证明不是 `any`）。
/** @typedef {import('./host.mjs').PluginContext} PluginContext */
/** @typedef {import('./host.mjs').HostEvents} HostEvents */
