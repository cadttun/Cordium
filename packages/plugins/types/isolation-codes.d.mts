/**
 * @file packages/plugins/src/isolation-codes.mjs
 * @description 隔离端【自产】失败码 —— `err.cause.code` 的第二码域。宿主与隔离端共用同一份。
 *
 * ★ 零依赖 + 与本目录同级：isolation-runner.mjs 跑在隔离环境里（`process` 档的权限模型只放行
 *   本目录与目标模块目录的读权限），不能 import `@cordium/kernel/*`。本文件只有字面量
 *   ⇒ 宿主与 runner 各 import 同一份，不存在「两处各写一遍码」的第二真相源。
 *
 * ★★ 本表【不完备】，这是设计而非疏漏：只列隔离端**自己产出**的码。插件抛出的 `code` 由
 *   isolation-runner.mjs 原样透传（任意 string，或 null），属**插件自己的域**，结构上不可枚举。
 *   ⇒ 消费方比对 `err.cause.code` 时：命中本表即隔离端自产；未命中一律当插件自报码，
 *     **不得**假定本表穷尽（别写 `Object.values(IsolationCode).includes(cause.code)` 来判「认全了没有」）。
 *
 * ★ 没有 `isValidIsolationCode`：本仓的 `isValidXxx` 三件套（ServiceAccess / PluginKind / LogLevel /
 *   ActivationPolicy）是给**入口输入**做成员校验的，因为那里拼错会静默落成最宽松行为。
 *   本表是**输出词表**（同 LifecycleState / DispatchMode，只给冻结对象），没有可校验的入口 ——
 *   而且真给 `cause.code` 加值域校验反而有害：会把插件的合法自报码当非法值吞掉，
 *   违反「底层错误码必须在 cause 里原样保留」这条已钉住的原则。
 *
 * ★ 值发布即契约：**可增不可改**（改字面量 = 破坏性变更），同 ErrorCode 口径。
 */
export declare const IsolationCode: Readonly<{
    NOT_A_FUNCTION: "not_a_function";
    RESULT_NOT_CLONEABLE: "result_not_cloneable";
}>;
