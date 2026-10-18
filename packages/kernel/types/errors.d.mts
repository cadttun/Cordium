/**
 * @file packages/kernel/src/errors.mjs
 * @description 内核与 plugins 包共用的错误类与错误码表。
 *
 * ★ 为什么要码：调用方此前只能拿报文正则分支（`/already disposed/`）——报文一改措辞，下游分支静默失效。
 *   `code` 是稳定契约，报文只给人看。
 * ★ 码按「调用方要怎么分支」定粒度，不与抛错点一一对应：同一类失败（如所有 `Security Violation`）共用一个码，
 *   细节留在报文里。
 * ★ 零依赖：plugins 经 internal.mjs 取用，不牵 host.mjs（同 semver.mjs 的口径）。
 * ★ 码值是公开 API：增删改 = 破坏性变更（test/error-model.test.mjs 钉死清单）。
 *
 * ── ★★ 重试语义的**唯一权威落点** ────────────────────────────────────
 *   本文件**只**定义「有哪些码」，**不**定义「哪个码该不该重试」。
 *   重试分类在 `retry-class.mjs`（`RetryClass` / `RETRY_CLASS_BY_CODE` / `retryClassOf`）。
 *
 *   ⇒ **其余文件里不得再写「可重试」「退避重试」「retry later」这类判断性措辞**，
 *     需要说明时**指向 `retry-class.mjs`**，不要各写一份。
 *     理由是这同一个语义此前散在 5 处（本文件、`isolation.mjs` 三处、`host.mjs` 一处），
 *     措辞各不相同（「可退避重试」/「据此退避重试」/「可重试」/「稍后重试」/「重试一下」）
 *     而**没有一处是判据** —— 读者只能从上下文猜「到底哪些码属于这一类」。
 *
 *   ★ 另外两条口径（将来实现重试时必须遵守）：
 *     ① **不要给 `CordiumError` 加 `retryable` 字段** —— 实例是「发生了什么」的记录，
 *        重试是「该怎么办」的策略；策略会变，历史错误对象不该跟着变。
 *     ② **不要按码名启发式推断**（`code.includes('timeout')`）—— 见 `retry-class.mjs` 文件头。
 */
export declare const ErrorCode: Readonly<{
    INVALID_ARGUMENT: "invalid_argument";
    INVALID_OPTION: "invalid_option";
    INVALID_USAGE: "invalid_usage";
    LISTENER_FAILED: "listener_failed";
    INVALID_MANIFEST: "invalid_manifest";
    INCOMPATIBLE_API_VERSION: "incompatible_api_version";
    DUPLICATE_PLUGIN: "duplicate_plugin";
    PLUGIN_NOT_FOUND: "plugin_not_found";
    PLUGIN_HAS_DEPENDENTS: "plugin_has_dependents";
    MISSING_DEPENDENCY: "missing_dependency";
    DEPENDENCY_VERSION_MISMATCH: "dependency_version_mismatch";
    CYCLIC_DEPENDENCY: "cyclic_dependency";
    DEPENDENCY_INACTIVE: "dependency_inactive";
    UNDECLARED_SERVICE: "undeclared_service";
    INVALID_CONTRACT: "invalid_contract";
    INVALID_IMPLEMENTATION: "invalid_implementation";
    INVALID_PERMISSION: "invalid_permission";
    UNDECLARED_PERMISSION: "undeclared_permission";
    PROVIDER_CONFLICT: "provider_conflict";
    PROVIDE_NOT_DECLARED: "provide_not_declared";
    NO_PROVIDER: "no_provider";
    SERVICE_UNAVAILABLE: "service_unavailable";
    SERVICE_FAILED: "service_failed";
    OPTIONAL_UNAVAILABLE: "optional_unavailable";
    ACCESS_DENIED: "access_denied";
    IDENTITY_REQUIRED: "identity_required";
    SCOPE_DISPOSED: "scope_disposed";
    SCOPE_OWNED_BY_HOST: "scope_owned_by_host";
    SCOPE_CONFLICT: "scope_conflict";
    SCOPE_CYCLE: "scope_cycle";
    LIFECYCLE_TIMEOUT: "lifecycle_timeout";
    DUPLICATE_ACTION: "duplicate_action";
    ACTION_NOT_FOUND: "action_not_found";
    ACTION_OWNER_GONE: "action_owner_gone";
    ACTION_TIMEOUT: "action_timeout";
    ACTION_FAILED: "action_failed";
    ACTION_OVERLOADED: "action_overloaded";
    DUPLICATE_UI_CONTRIBUTION: "duplicate_ui_contribution";
    INVALID_DEPENDENCIES: "invalid_dependencies";
    INVALID_REGISTRY: "invalid_registry";
    VERSION_CONFLICT: "version_conflict";
    IMPLEMENTATION_CONFLICT: "implementation_conflict";
    INVALID_TIMEOUT: "invalid_timeout";
    CALL_TIMEOUT: "call_timeout";
    CALL_CANCELLED: "call_cancelled";
    ISOLATED_CALL_FAILED: "isolated_call_failed";
    ISOLATION_BUSY: "isolation_busy";
    PLUGIN_LOAD_FAILED: "plugin_load_failed";
    INVALID_CATALOG: "invalid_catalog";
}>;
/**
 * 两层唯一的错误类。
 *
 * ★ 不在构造里校验 `code`：构造错误对象时再抛错会把原始失败盖掉。
 *   码的合法性由门禁保证 —— src 里一律写 `ErrorCode.X`，门禁核对每个 X 都在表里。
 */
export declare class CordiumError extends Error {
    code: string;
    pluginId: string;
    /**
     * @param {string} code ErrorCode 中的一个值
     * @param {string} message 给人看的细节（不是契约）
     * @param {{ cause?: unknown, pluginId?: string | null }} [options]
     */
    constructor(code: string, message: string, { cause, pluginId }?: {
        cause?: unknown;
        pluginId?: string | null;
    });
}
