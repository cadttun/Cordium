/**
 * @file packages/kernel/src/host-util.mjs
 * @description 宿主用的纯函数（不读宿主状态）：动作超时、manifest 冻结、日志快照。
 *
 * ★ 从 host.mjs 原样搬出。**内部实现，不经 index 导出**；其中与 plugins 包共用的几个
 *   （MAX_TIMER_MS / describeValue / describeError / errorDetails / firstFrame / summarizeCause / readOptions / runWithTimeout / measureValue）经 internal 转出。
 */
/**
 * Node `setTimeout` 的上限（2³¹-1 ms）。超过它 Node 会【静默改成 1ms】并只打一条进程警告 ⇒ 立即超时。
 * 内核动作超时与 plugins 包的 callWithTimeout / callIsolated 共用这一个常量（经 internal 转出）。
 */
export declare const MAX_TIMER_MS: number;
/**
 * 把【任意调用方输入】渲染进报错文本。
 * ★ 不能直接 `${x}` / `String(x)`：symbol 在模板里抛 TypeError，`Object.create(null)` 在两者里都抛 ——
 *   于是本该是带码的 CordiumError，调用方拿到的却是引擎级 TypeError（实测）。
 * @param {unknown} value
 * @returns {string}
 */
export declare function describeValue(value: unknown): string;
/**
 * 把【任意被抛出的值】渲染成一句话（有 message 取 message，否则同 describeValue）。
 * ★ 第三方代码可以 `throw undefined` / `throw null` / `throw Symbol()`：此前各处写 `err.message` /
 *   `${err?.message ?? err}`，碰上这些值在【错误处理路径里】再抛 TypeError —— 实测：
 *   隔离环境里 `throw undefined` 打崩宿主进程；清理回调 `throw Symbol()` 让停用卡在 stopping、
 *   后续 disposer 全部不跑（监听器泄漏）。⇒ 错误路径上一律经本函数取文本。
 * @param {unknown} err
 * @returns {string}
 */
export declare function describeError(err: unknown): string;
/**
 * 栈里第一条「不是内核 / 不是 Node 内部」的帧 —— 即出错的**插件代码位置**（`file:line:col`）。
 * 找不到（抛的是字符串 / 栈全在内核里）⇒ null。
 * ★ 按【文件路径】排除内核帧，不按函数名：插件里也可以有叫 dispatch 的函数。
 * @param {unknown} stack
 * @returns {string | null}
 */
export declare function firstFrame(stack: unknown): string | null;
/**
 * 把一个被抛出的值整理成**可定位**的日志 details：码、插件、位置、栈，沿 `cause` 链逐层展开。
 *
 * ★ 为什么需要：后台失败（emit 监听器、清理回调、生命周期钩子）没有调用方可以 catch，
 *   只进宿主日志 —— 此前日志里只有一句 message，看不出是哪个插件、哪一行。
 * ★ 任何怪值（throw undefined / Symbol / 抛错的 getter / Proxy）都不得让这里再抛：错误路径上的工具。
 * ★ 有界：cause 链只展开头 4 层 + 尾 4 层（中间记个数）、每段栈截 4KB —— 递归派发的信封链可以上万层。
 *
 * @param {unknown} err
 * @returns {{ error: string, code?: string, pluginId?: string, at?: string, stack?: string, causes?: object[] }}
 */
export declare function errorDetails(err: unknown): {
    error: string;
    code?: string;
    pluginId?: string;
    at?: string;
    stack?: string;
    causes?: object[];
};
/**
 * 把「下层抛出的东西」压成报文里的一小段（信封报文用）。
 * ★ 只取下层的【码】或截断的一句话，不拼它的完整报文：嵌套派发时每层都包一次，
 *   若逐层拼接完整报文，报文长度随嵌套层数平方增长（1 万层递归 ⇒ GB 级字符串）。
 *   完整信息在 `cause` 链上，一条不丢。
 * @param {unknown} err
 * @returns {string}
 */
export declare function summarizeCause(err: unknown): string;
/**
 * 读取调用方传入的选项对象：`undefined` / `null` ⇒ `{}`；其它非普通对象（字符串 / 数字 / 数组 / 函数）⇒ 抛 `code`。
 *
 * ★ 此前各入口写 `options ?? {}` 后直接解构：传 `'abc'` / `[1]` / `5` **静默通过**，所有选项落回默认值，
 *   调用方以为设了超时 / 回调，其实一个都没生效（实测：两包 7 个入口全部如此）。
 * ★ 读一次落成快照：抛错的 getter 在这里转成带码错误；之后只看快照（同一个值不会读出两种结果）。
 * ★★ 未知键一律拒（与 `loadPlugins` 清单条目同一口径，见 `entry.mjs`）。此前是**静默忽略**：
 *   把 `apiVersion` 拼成 `apiVersio`、`maxMemoryMb` 拼成 `maxMemoryMB`，调用照常成功、
 *   却悄悄用了默认值 —— 声明没生效、零报错，正是反复踩过的那个坑。
 *   依据（规范层）：RFC 9413《Maintaining Robust Protocols》已推翻「宽进」的鲁棒性原则，
 *   并点名**对早期实现尤其有害** —— 现在容忍下来的写法，会被后来的调用方照着抄。
 *   ★ `allow` 缺省为空数组 ⇒ **fail-closed**：新增调用点若忘了声明允许键，
 *     任何带选项的调用都会响亮失败，而不是悄悄退回宽容模式。
 *
 *   ★★ `null` 与 `[]` **不是一回事**，别混：`[]` = 一个键都不收（缺省，fail-closed）；
 *     `null` = **此处不筛**，明确表示「未知键由下游自己负责」——目前只有声明式字段表用（见 host 的契约表）。
 *
 * @param {unknown} options
 * @param {string} where 报错前缀
 * @param {string[] | null} [allow=[]] 本入口允许的选项名；不在其中的键一律拒；`null` ⇒ 不筛（须在下游另有归属）
 * @param {string} [code=ErrorCode.INVALID_ARGUMENT]
 * @returns {Record<string, any>}
 */
export declare function readOptions(options: unknown, where: string, allow?: string[] | null, code?: string): Record<string, any>;
/**
 * 给一个可能永不 resolve 的任务加执行上限。
 *
 * 为什么需要：插件处理器是第三方代码，死循环 await、外部依赖挂起都会让
 * dispatchAction 永久挂起并连带卡住调用方。超时后必须以明确错误返回，
 * 而不是静默吞掉——否则调用方无法区分"还在跑"与"已经废了"。
 *
 * 内核动作、生命周期钩子与 plugins 包的 `callWithTimeout` 共用这一份（经 internal 转出）。
 *
 * ★ 为什么不用 `AbortSignal.timeout`：它挂着 abort 监听器时，计时器在到期前一直钉住 signal，
 *   且无法提前取消（MDN 原文），3 万次 30s 超时的调用 gc 后仍多占约 30MB；
 *   这里在 finally 里 clearTimeout，任务一结束计时器就释放（实测）。
 *
 * @param {() => any} task
 * @param {number} timeoutMs 0 或负数表示不限制
 * @param {() => Error} onTimeout 超时时构造要抛出的错误（各调用方的码不同）
 */
export declare function runWithTimeout(task: () => any, timeoutMs: number, onTimeout: () => Error): Promise<any>;
/**
 * 递归冻结一个值**可达的一切**，返回原对象。
 *
 * ★ 与「手列字段名」的差别：这里**不查字段名**，凡本层容器一律冻到叶 ——
 *   契约表将来新增任何容器字段都自动覆盖，不存在「加了字段忘了同步冻结」这一失效模式。
 *   外部同形做法：规范文档给出的 deepFreeze 用 `Reflect.ownKeys` 递归；能力对象加固库
 *   的 `harden` 明确描述为「传递性反射自有属性遍历」，且**对访问器不调用 getter**。
 *
 * ★ 边界（如实标注）：
 *   · 函数不进入也不冻结 —— 它不是数据契约的一部分，冻一个共享函数对象是不必要的副作用；
 *   · isOpaqueContainer 列出的一律跳过（见其注释）；
 *   · `WeakSet` 防环（自引用对象会让朴素递归栈溢出）。
 *
 * @param {any} value
 * @param {WeakSet<object>} [seen]
 */
export declare function deepFreeze(value: any, seen?: WeakSet<object>): any;
/**
 * 为插件交付一份【逐层冻结】的 manifest 副本。
 *
 * 为什么不能只做浅冻结：Object.freeze 是浅的，挡不住 manifest.permissions.push(...) ——
 * 数组本身仍是可变的。冻结后插件再写它会在严格模式（ESM 默认）下直接抛 TypeError，
 * 而不是静默失败。
 *
 * ⚠️ 此前这里是**手列的四个字段名**（provides / dependencies / optionalDependencies / permissions）。
 *   实测：往 manifest 契约表新增一个容器字段后，该字段**不在冻结之列** ——
 *   插件可以直接 push 进内核交付的 manifest，而「逐层冻结」的宣称不成立；
 *   且归一化产物**本身不冻结**这些容器，所以这份清单是唯一防线，漏一项就是真漏。
 *   ⇒ 改为泛化递归，按类型判定，不再依赖任何人记得同步。
 *
 * @param {any} manifest
 */
export declare function freezeManifestForPlugin(manifest: any): any;
/**
 * 审计日志 details 的写入快照。
 *
 * ★ 为什么克隆而不是深冻结：冻结挡不住 Map / Set 的 set()，
 *   且 Object.freeze 对非空 TypedArray 直接抛 TypeError。
 *   克隆切断引用即可 —— 读出时再克隆一次（copyLogEntry），两头都不共享。
 *
 * ★ 不可克隆（函数、Proxy 等）时【不抛错】：log() 常在错误路径上被调用，
 *   记日志失败会把原始错误盖掉。退化为一个可见的标记，而不是静默丢掉。
 *
 * ★ 体积上限：日志条数有上限，**单条大小此前没有** ——
 *   插件 `ctx.log('info', …, { rows: 一百万条 })` 实测每条克隆 ~350ms（卡住事件循环），
 *   500 槽写满后常驻 >1GB。超出 LOG_DETAILS_BUDGET 的 details 不克隆，换成可见标记。
 *   先做有界遍历再克隆：判定本身最多看预算那么多个节点，不会被大对象拖慢。
 *
 * @param {any} details
 */
export declare function snapshotDetails(details: any): any;
/** 单条日志 details 的体积上限：节点数（对象 / 数组元素 / Map·Set 项）与字节数（字符串按长度、二进制按底层整块 buffer 且同一块只计一次 —— structuredClone 复制的是整块） */
export declare const LOG_DETAILS_BUDGET: Readonly<{
    nodes: 10000;
    bytes: 1048576;
}>;
/**
 * 有界测量一个值的大致体积（不求精确，用于限额判定）：
 *   · 最多访问 `maxNodes` 个节点（含已压栈未处理的）—— 大数组 / Map 不会先被整个展开；
 *   · 累计字节超过 `stopAtBytes` 立即停；
 *   · 环与重复引用只走一次；容器本身不计字节。
 * 取值抛错的怪对象（抛错的 getter / Proxy 陷阱）跳过该节点，不抛 —— 真正克隆时自会报错。
 *
 * @param {any} value
 * @param {{ maxNodes: number, stopAtBytes?: number, stopAtTruncate?: boolean }} limits
 *   stopAtTruncate：一触上限就返回（只关心「超没超」时用；此时 bytes 无意义）
 * @returns {{ bytes: number, truncated: boolean }} truncated：因任一上限提前停下（此时 bytes 偏小）
 */
export declare function measureValue(value: any, { maxNodes, stopAtBytes, stopAtTruncate }: {
    maxNodes: number;
    stopAtBytes?: number;
    stopAtTruncate?: boolean;
}): {
    bytes: number;
    truncated: boolean;
};
/**
 * 对外交出一条日志的副本（诊断只读快照，不是审计记录的写入口）。
 * details 写入时已是快照，必然可克隆。
 */
export declare function copyLogEntry(entry: any): any;
