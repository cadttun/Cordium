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
export { normalizeStringList, normalizeDependencyMap, diffWhitelistFields, diffServiceContractFields, diffManifestFields, MANIFEST_FIELD_TABLE, PLUGIN_ID_PATTERN, isValidPluginKind, isValidServiceAccess, isValidActivationPolicy, isValidLogLevel } from './types.mjs';
export { PluginKind, PLUGIN_KIND_VALUES, ActivationPolicy, ACTIVATION_POLICY_VALUES } from './types.mjs';
export { LogLevel, LOG_LEVEL_VALUES } from './types.mjs';
export { KERNEL_API_VERSION, isApiVersionCompatible } from './types.mjs';
export { parseRange, isValidSemVer, compareSemVer, satisfiesSemVer } from './semver-api.mjs';
export { CordiumError, ErrorCode } from './errors.mjs';
export { MAX_TIMER_MS, describeValue, describeError, errorDetails, firstFrame, summarizeCause, readOptions, runWithTimeout, measureValue } from './host-util.mjs';
export { deepFreeze } from './host-util.mjs';
