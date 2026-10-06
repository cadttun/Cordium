/**
 * @file packages/kernel/src/internal.mjs
 * @description 内核与 plugins 包之间的【内部共享】工具 —— **不是公开 API**。
 *
 * ★ 为什么单独一个入口：这些工具是「两层 manifest 共用同一份定义」的落点
 *   （归一化、字段表、丢字段比对、id 模式），plugins 包必须拿到它们；
 *   但它们的签名随实现走，不承诺稳定，不该出现在主入口 `index.mjs`。
 *   在 package.json `exports` 中映射为 `./internal` 子路径。
 *
 * ★ 也转出 plugins 要用的几个【公开】成员（semver / PluginKind）：本文件只依赖 types / semver，
 *   **不牵 host.mjs**。plugins 若改走 `index.mjs` 就会连带加载整个宿主 —— 那正是此前修掉的反向依赖。
 */

export {
  normalizeStringList,
  normalizeDependencyMap,
  diffWhitelistFields,
  diffServiceContractFields,
  diffManifestFields,
  MANIFEST_FIELD_TABLE,
  PLUGIN_ID_PATTERN,
  isValidPluginKind,
  isValidServiceAccess,
  isValidActivationPolicy,
  isValidLogLevel
} from './types.mjs';
export { PluginKind, PLUGIN_KIND_VALUES, ActivationPolicy, ACTIVATION_POLICY_VALUES } from './types.mjs';
export { LogLevel, LOG_LEVEL_VALUES } from './types.mjs';
// ★ 插件层的 API 版本由此派生（不再各写一份字面量，两层不可能漂移）
export { KERNEL_API_VERSION } from './types.mjs';
export { parseRange, isValidSemVer, compareSemVer, satisfiesSemVer } from './semver-api.mjs';
export { CordiumError, ErrorCode } from './errors.mjs';
// Node setTimeout 上限：内核动作超时与 plugins 的 callWithTimeout / callIsolated 同一口径
export { MAX_TIMER_MS, describeValue, describeError, errorDetails, firstFrame, summarizeCause, readOptions, runWithTimeout, measureValue } from './host-util.mjs';
// ★ 深冻结：内核交付 manifest 与 plugins 冻结清单 config 是同一件事，共用一份实现
//   —— 两份手写实现会漂移（plugins 那份此前用 Object.values，漏掉 symbol 键与不可枚举属性）
export { deepFreeze } from './host-util.mjs';
