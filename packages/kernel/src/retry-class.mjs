/**
 * @file packages/kernel/src/retry-class.mjs
 * @description 错误码的**重试分类**：把 48 个码逐一归到四档之一，回答「拿到这个码该不该重试」。
 *
 * ── 为什么单独一个文件、而且是一张【独立声明】的表 ────────────────────
 *   1. 分类单位是**码**，不是错误实例字段。错误实例是**值**（它记录「发生了什么」），
 *      重试策略是**策略**（它会随运维口径变）—— 策略变了不该让历史错误对象跟着变。
 *      ⇒ **绝不往 `CordiumError` 加 `retryable` 字段**。
 *   2. **不得按码名启发式推断**（`code.includes('timeout')` 这类）：
 *      本仓 48 个码的取名依据是「调用方要怎么分支」，不是「可不可重试」，
 *      两者**不一一对应** —— 例如 `invalid_timeout` 是参数错（不可重试），
 *      而 `call_timeout` 是执行超预算（换大预算可以重试），名字同含 timeout。
 *   3. **必须逐码穷举 + 门禁核对**：这是本仓踩过的「白名单重建」陷阱 ——
 *      漏列一个码即**静默落进默认档**，而默认档恰恰是最危险的那个答案。
 *
 * ── 三档（不是两档）─────────────────────────────────────────────────
 *   业界口径（UHP Errors §4 Retrying）里，`session_busy` 是
 *   「**等当前在途的任务结束之后**」再试 —— 它既不是纯 backoff（等固定时长），
 *   也不是「不可重试」（它确实会缓解）。少掉这一档，调用方只能把它当「立即重试」
 *   （打爆正在恢复的系统）或「放弃」（丢一次本可成功的调用）。
 *   本仓对应的是 `plugin_has_dependents` / `action_owner_gone` / `dependency_inactive`
 *   这类「**先改变状态，再重试**」的码。
 *
 *   ★ `retryable_when_state_changes` 的判据是「**调用方自己就能改变那个状态**」
 *     （停依赖、重装插件）。凡是需要**别人**动（等插件作者发新版、等管理员加权限）的，
 *     一律归 `not_retryable` —— 否则等于建议调用方空转。
 *
 *   ★★ **没有「立刻重试」这一档，是有意的**：本仓 48 个码里，**没有一个**
 *     符合「同一调用、同样参数、无需等待即可成功」。临时性失败只有两类 ——
 *     过载（要退避）与状态不对（要先改状态）。硬加一个空档位，
 *     只会让调用方去猜「这个码是不是属于那个空档」。
 *     ⇒ 将来真出现「零等待可重试」的码时再加（增枚举成员属 additive，见 CHANGELOG 约定）。
 *
 * ── 这张表**不是**运行期的重试实现 ──────────────────────────────────
 *   它只回答「这个码属于哪一档」。重试次数、退避曲线、抖动、幂等键、
 *   重试预算都不在这里（那些是调用方的运行策略，各场景不同）。
 *   ★ 本仓至今**零重试逻辑**；此表的作用是「将来第一处重试只有一个判据源」。
 */
import { ErrorCode } from './errors.mjs';

/**
 * 三档重试分类。
 *
 * ★ 取值是字符串而非布尔：布尔丢掉了「以什么方式重试」这一维，
 *   而「退避后再试」与「改变状态后再试」的调用方代码完全不同。
 */
export const RetryClass = Object.freeze({
  /** 需要**退避**（等一段不确定时长，让在途负载 / 过载缓解） */
  RETRYABLE_AFTER_BACKOFF: 'retryable_after_backoff',
  /** 需要**先改变状态**才能成功（调用方自己就能改：停依赖、重装、补齐声明） */
  RETRYABLE_WHEN_STATE_CHANGES: 'retryable_when_state_changes',
  /** 重试必然同样失败 —— 要么调用方先改参数，要么根本无解 */
  NOT_RETRYABLE: 'not_retryable'
});

/** ★ 合法取值集合（由 `RetryClass` 派生，不另抄） */
export const RETRY_CLASS_VALUES = Object.freeze(Object.values(RetryClass));

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
export const RETRY_CLASS_BY_CODE = Object.freeze({
  // ── 参数 / 用法：改输入才能成功 ──
  // 调用方传错了；同样的输入重试必然同样失败。
  [ErrorCode.INVALID_ARGUMENT]: RetryClass.NOT_RETRYABLE,
  [ErrorCode.INVALID_OPTION]: RetryClass.NOT_RETRYABLE,
  [ErrorCode.INVALID_USAGE]: RetryClass.NOT_RETRYABLE,
  // 监听器抛错：重试会**再执行一遍**副作用（可能是部分已生效的写操作）。
  // ★ 与「临时故障」不同，这里的失败是确定性的（同一个监听器、同一份输入）。
  [ErrorCode.LISTENER_FAILED]: RetryClass.NOT_RETRYABLE,

  // ── manifest：清单是静态的，改完重新加载才行 ──
  [ErrorCode.INVALID_MANIFEST]: RetryClass.NOT_RETRYABLE,
  // 插件与宿主 API 版本不兼容：等**插件作者**发新版或**宿主**升级 —— 都不是调用方能改的
  [ErrorCode.INCOMPATIBLE_API_VERSION]: RetryClass.NOT_RETRYABLE,

  // ── 插件表：调用方可以自己改变状态 ──
  // 同一个 id 已注册：先 unregister 或换 id —— 调用方自己就能改
  [ErrorCode.DUPLICATE_PLUGIN]: RetryClass.RETRYABLE_WHEN_STATE_CHANGES,
  // id 拼错 / 没注册：先注册再试（或改对 id）
  [ErrorCode.PLUGIN_NOT_FOUND]: RetryClass.RETRYABLE_WHEN_STATE_CHANGES,
  // ★ 还有别的插件依赖它 ⇒ **先停掉那些依赖方**再试。调用方自己就能做（若它拥有那些插件）
  [ErrorCode.PLUGIN_HAS_DEPENDENTS]: RetryClass.RETRYABLE_WHEN_STATE_CHANGES,

  // ── 依赖：清单写错了，改清单 + 重新加载 ──
  [ErrorCode.MISSING_DEPENDENCY]: RetryClass.RETRYABLE_WHEN_STATE_CHANGES,
  [ErrorCode.DEPENDENCY_VERSION_MISMATCH]: RetryClass.RETRYABLE_WHEN_STATE_CHANGES,
  // 环：必须改清单打破循环 —— 调用方改得了，但要用**别的输入**
  [ErrorCode.CYCLIC_DEPENDENCY]: RetryClass.NOT_RETRYABLE,
  // ★ 依赖装了但没激活 ⇒ **先 activate 它**再试。这正是「改变状态后重试」的典型
  [ErrorCode.DEPENDENCY_INACTIVE]: RetryClass.RETRYABLE_WHEN_STATE_CHANGES,

  // ── 契约 / 权限：声明面是静态的 ──
  [ErrorCode.UNDECLARED_SERVICE]: RetryClass.NOT_RETRYABLE,
  [ErrorCode.INVALID_CONTRACT]: RetryClass.NOT_RETRYABLE,
  [ErrorCode.INVALID_IMPLEMENTATION]: RetryClass.NOT_RETRYABLE,
  [ErrorCode.INVALID_PERMISSION]: RetryClass.NOT_RETRYABLE,
  [ErrorCode.UNDECLARED_PERMISSION]: RetryClass.NOT_RETRYABLE,

  // ── 服务：可用性会随别的东西变化 ──
  // 撞名：停掉现有提供者再试 —— 调用方可能做得到
  [ErrorCode.PROVIDER_CONFLICT]: RetryClass.RETRYABLE_WHEN_STATE_CHANGES,
  // 提供者没声明这个 service ⇒ 改代码
  [ErrorCode.PROVIDE_NOT_DECLARED]: RetryClass.NOT_RETRYABLE,
  // ★ 没人提供：**等别人注册**，不是重试。但若调用方自己就是那个「别人」⇒ 先注册再试。
  //   归「状态改变」档，理由与 DEPENDENCY_INACTIVE 同。
  [ErrorCode.NO_PROVIDER]: RetryClass.RETRYABLE_WHEN_STATE_CHANGES,
  // ★ 服务不可用：提供者被停用 / 正在替换 ⇒ 等它回来。**退避**是正确形态（不知道多久）
  [ErrorCode.SERVICE_UNAVAILABLE]: RetryClass.RETRYABLE_AFTER_BACKOFF,
  // 实现方法抛了：可能是临时故障（下游超时），也可能是确定性 bug —— 本层分不出来。
  // ★ **保守归不可重试**：调用方若有领域知识，可自行升级。反过来（默认可重试）会重复副作用。
  [ErrorCode.SERVICE_FAILED]: RetryClass.NOT_RETRYABLE,
  // 可选服务不可用：调用方**本就该走降级路径**，重试无意义
  [ErrorCode.OPTIONAL_UNAVAILABLE]: RetryClass.NOT_RETRYABLE,

  // ── 访问 ──
  [ErrorCode.ACCESS_DENIED]: RetryClass.NOT_RETRYABLE,
  [ErrorCode.IDENTITY_REQUIRED]: RetryClass.NOT_RETRYABLE,

  // ── 生命周期 / 作用域 ──
  // 作用域已释放：拿新句柄才行 —— 旧的永远不能用了
  [ErrorCode.SCOPE_DISPOSED]: RetryClass.NOT_RETRYABLE,
  [ErrorCode.SCOPE_OWNED_BY_HOST]: RetryClass.NOT_RETRYABLE,
  [ErrorCode.SCOPE_CONFLICT]: RetryClass.NOT_RETRYABLE,
  [ErrorCode.SCOPE_CYCLE]: RetryClass.NOT_RETRYABLE,
  // ★ 生命周期钩子超时：**换大预算或让钩子更快**才可以，同参数重试必然再超时
  [ErrorCode.LIFECYCLE_TIMEOUT]: RetryClass.NOT_RETRYABLE,

  // ── 动作 ──
  [ErrorCode.DUPLICATE_ACTION]: RetryClass.NOT_RETRYABLE,
  // 动作没注册：先注册再派发（调用方可能自己就是注册方）
  [ErrorCode.ACTION_NOT_FOUND]: RetryClass.RETRYABLE_WHEN_STATE_CHANGES,
  // 拥有者已消失：等拥有者回来 = 状态改变
  [ErrorCode.ACTION_OWNER_GONE]: RetryClass.RETRYABLE_WHEN_STATE_CHANGES,
  // ★ 动作超时：处理器确实有机会在下一轮更快（下游恢复后）—— 但**副作用可能已发生**。
  //   与 `service_failed` 同口径：保守归不可重试，除非调用方有幂等保证。
  [ErrorCode.ACTION_TIMEOUT]: RetryClass.NOT_RETRYABLE,
  // 处理器抛错：同 service_failed 的理由
  [ErrorCode.ACTION_FAILED]: RetryClass.NOT_RETRYABLE,
  // ★★ 在途派发数触顶：**未调用处理器**（零副作用）+ 过载会缓解 ⇒ 教科书式的「退避后再试」
  [ErrorCode.ACTION_OVERLOADED]: RetryClass.RETRYABLE_AFTER_BACKOFF,

  // ── UI ──
  [ErrorCode.DUPLICATE_UI_CONTRIBUTION]: RetryClass.NOT_RETRYABLE,

  // ── plugins 包专属 ──
  [ErrorCode.INVALID_DEPENDENCIES]: RetryClass.NOT_RETRYABLE,
  [ErrorCode.INVALID_REGISTRY]: RetryClass.NOT_RETRYABLE,
  // 版本更旧 / 冲突：换更新的版本再来 —— 需要**新输入**
  [ErrorCode.VERSION_CONFLICT]: RetryClass.NOT_RETRYABLE,
  [ErrorCode.IMPLEMENTATION_CONFLICT]: RetryClass.NOT_RETRYABLE,
  // ★ `invalid_timeout` 是**参数**错（与 `call_timeout` 是两回事）
  [ErrorCode.INVALID_TIMEOUT]: RetryClass.NOT_RETRYABLE,
  // ★ 调用超时：同 action_timeout —— 副作用可能已发生，且隔离环境已被终止
  [ErrorCode.CALL_TIMEOUT]: RetryClass.NOT_RETRYABLE,
  // ★ 调用方自己喊的停：**重试等于无视它的意图**。若它真想再来一次，会显式发起新调用
  [ErrorCode.CALL_CANCELLED]: RetryClass.NOT_RETRYABLE,
  // 隔离调用失败（崩溃 / 退出 / 插件抛错）：同 service_failed
  [ErrorCode.ISOLATED_CALL_FAILED]: RetryClass.NOT_RETRYABLE,
  // ★★ 三道闸拒收：**未起任何环境**（明确零副作用）+ 排队会缓解 ⇒ 退避后再试
  [ErrorCode.ISOLATION_BUSY]: RetryClass.RETRYABLE_AFTER_BACKOFF,
  // 插件加载失败：装载错误（语法 / 模块解析 / 回滚失败）。改代码或换文件才行
  [ErrorCode.PLUGIN_LOAD_FAILED]: RetryClass.NOT_RETRYABLE,
  // catalog 数据本身不合规：改数据
  [ErrorCode.INVALID_CATALOG]: RetryClass.NOT_RETRYABLE
});

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
export function retryClassOf(code) {
  return RETRY_CLASS_BY_CODE[/** @type {keyof typeof RETRY_CLASS_BY_CODE} */ (code)] ?? RetryClass.NOT_RETRYABLE;
}

/**
 * 一个码在当前情境下「值不值得再试一次」。
 *
 * ★ 它是 `retryClassOf` 的**极薄**派生，不是第二张表 —— 只是把四档压成调用方最常问的那一问。
 * ★ `retryable_when_state_changes` 算作 `true`：**调用方自己就能改变状态**的情形下，
 *   它确实应该再试（改变之后）。若调用方改不了，那是它自己该判断的（本函数不替它猜）。
 *
 * @param {string} code
 * @returns {boolean}
 */
export function isRetryable(code) {
  return retryClassOf(code) !== RetryClass.NOT_RETRYABLE;
}
