/**
 * 三档重试分类。
 *
 * ★ 取值是字符串而非布尔：布尔丢掉了「以什么方式重试」这一维，
 *   而「退避后再试」与「改变状态后再试」的调用方代码完全不同。
 */
export declare const RetryClass: Readonly<{
    /** 需要**退避**（等一段不确定时长，让在途负载 / 过载缓解） */
    RETRYABLE_AFTER_BACKOFF: "retryable_after_backoff";
    /** 需要**先改变状态**才能成功（调用方自己就能改：停依赖、重装、补齐声明） */
    RETRYABLE_WHEN_STATE_CHANGES: "retryable_when_state_changes";
    /** 重试必然同样失败 —— 要么调用方先改参数，要么根本无解 */
    NOT_RETRYABLE: "not_retryable";
}>;
/** ★ 合法取值集合（由 `RetryClass` 派生，不另抄） */
export declare const RETRY_CLASS_VALUES: readonly ("not_retryable" | "retryable_after_backoff" | "retryable_when_state_changes")[];
/**
 * ★★ 唯一权威的码 → 档位映射。
 *
 * ★ **表必须与 `ErrorCode` 集合相等**（由 `retry-class.test.mjs` 双向核对）：
 *   漏一个码即落进默认档；多一个键即引用了不存在的码。两者都变红。
 *
 * ★ **每一条都写理由** —— 不是为了注释好看，而是因为「为什么这个码不可重试」
 *   是下次有人想放宽它时唯一的判据来源。
 *
 * @type {Readonly<Record<string, string>>}
 */
export declare const RETRY_CLASS_BY_CODE: Readonly<Record<string, string>>;
/**
 * 查一个错误码的重试分类。
 *
 * ★ 未知码 ⇒ **`NOT_RETRYABLE`**（fail-safe）。
 *   理由：本仓的码表是冻结的，未知码只可能来自
 *   ① 调用方拿到了别的东西当代码；② 未来新增了码但这个文件没跟上。
 *   两种情况下「重试」都是更危险的那个默认 —— 它会**重复一个可能已发生副作用的操作**。
 *   ★ 反过来（默认可重试）看起来更「宽容」，实际是把不确定性带来的代价
 *     推给下游：一个确定性的失败会被反复执行 N 遍。
 *
 * @param {string} code 例如 `ErrorCode.ISOLATION_BUSY` 的值
 * @returns {string} `RetryClass` 的取值之一
 */
export declare function retryClassOf(code: string): string;
/**
 * 一个码在当前情境下「值不值得再试一次」。
 *
 * ★ 它是 `retryClassOf` 的**极薄**派生，不是第二张表 —— 只是把三档压成调用方最常问的那一问。
 * ★ `retryable_when_state_changes` 算作 `true`：**调用方自己就能改变状态**的情形下，
 *   它确实应该再试（改变之后）。若调用方改不了，那是它自己该判断的（本函数不替它猜）。
 *
 * @param {string} code
 * @returns {boolean}
 */
export declare function isRetryable(code: string): boolean;
