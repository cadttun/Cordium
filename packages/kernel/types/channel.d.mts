/**
 * @file packages/kernel/src/channel.mjs
 * @description 信息中转层 —— 内核里【只负责搬运消息】的那一层。
 *
 * ── 为什么要单独一层 ────────────────────────────────────────────────
 * 服务（service）与消息（message）是**两种根本不同的语义**：
 *
 *   |          | 服务            | 通道                |
 *   |----------|-----------------|---------------------|
 *   | 拓扑     | 点对点          | 一对多              |
 *   | 调用方   | 知道对方是谁    | ★ 不知道谁在听      |
 *   | 回执     | 必须有返回值    | 可有可无            |
 *   | 可拦截   | 不该被第三方插脚 | ★ 就是设计来被拦截的 |
 *
 * 混在一起的代价：每加一个「拦截」需求，都要去改服务解析逻辑。
 * ⇒ 因此把「信息怎么流动」独立出来，宿主只做编排，本层只做搬运。
 *
 * ── 三条设计铁律 ────────────────────────────────────────────────────
 *   ① **本层不知道消息内容是什么** —— 零业务。它只认「名字 + 参数」。
 *   ② **零 token** —— 全是函数调用，绝不碰模型。
 *   ③ **注册即效果** —— 调用方拿到的 disposer 由 EffectScope 托管，
 *      插件卸载时监听器自动摘除（见 host.mjs 的 ctx.on 接线）。
 *
 * ── 分发模式（对齐 Cordis `events.ts`）────────────────────────────────
 *   emit       广播，不等回执
 *   parallel   广播 + 等全部完成（失败 ⇒ CordiumError(listener_failed)，原始错误在 cause.errors）
 *   serial     串行，【第一个有回应的赢】
 *   waterfall  ★ 中间件：可停留 / 传输 / 变换
 *
 * ── 失败口径 ────────────────────────────────
 *   监听器抛出的任意值 ⇒ CordiumError(listener_failed)，原值在 cause（parallel 是多个，cause 为 AggregateError）。
 *   此前只有 parallel 这么做，serial / waterfall 原样透传 —— 同一文件两套口径，
 *   抛字符串时调用方拿不到码与栈（实测）。
 *   不包的：本层自己的用法错误（next() 调两次）；waterfall 兜底函数（调用方自己的）抛的错。
 */
/** 分发模式（导出供诊断与测试使用） */
export declare const DispatchMode: Readonly<{
    EMIT: "emit";
    PARALLEL: "parallel";
    SERIAL: "serial";
    WATERFALL: "waterfall";
}>;
/**
 * 判定「是否拦截」。
 *
 * 语义取 Cordis `events.ts:6-8`：只有非空且非 false 的返回值才算拦截。
 * ⇒ `undefined` / `null` / `false` 都表示「我不处理，往下传」。
 */
export declare function isBailed(value: any): boolean;
export declare class MessageChannel {
    #private;
    /**
     * 单个事件的监听器数上限（**泄漏检测器，不是硬限制**）。
     *
     * 为什么需要：监听器泄漏是插件系统最隐蔽的故障 —— 插件卸载时没能摘除监听器，
     * 表现是「功能看着正常，但内存和重复回调慢慢涨」。
     * 依据 Node.js EventEmitter 的做法（默认 10，**是检测器不是限制**）——
     * 本层不复用 EventEmitter，所以自己带一个。
     *
     * ★ 触发时【不抛错、不拒绝注册】，只通过 `onListenerOverflow` 上报 ——
     *   因为"合法地挂很多监听器"是可能的，硬拦会误伤。
     *
     * @type {number}
     */
    maxListenersPerEvent: number;
    /**
     * 监听器数超限钩子。宿主接到审计日志。
     * @type {(name: string, count: number) => void}
     */
    onListenerOverflow: (name: string, count: number) => void;
    /**
     * 订阅一个事件。
     *
     * ★ 注册是【同步】的：本方法返回时监听器已经挂上。
     *   这不是随便定的 —— 若注册是异步的，「先订阅再发布」的直觉就会失效，
     *   发布方与订阅方的首次握手会形成竞态。
     *   （依据：Qwen Code `EventBus` 官方文档明确把同步注册列为设计点。）
     *
     * @param {string} name 事件名，约定 `domain/action`（如 `task/created`）
     * @param {Function} listener
     * @param {{ prepend?: boolean, scopeLabel?: string | null, global?: boolean, owner?: string | null }} [options]
     *   owner：订阅者身份（宿主注入插件 id）—— 只用于出错时报「是谁的监听器」，不参与派发
     * @returns {() => boolean} disposer（由调用方交给 EffectScope 托管）
     */
    subscribe(name: string, listener: Function, options?: {
        prepend?: boolean;
        scopeLabel?: string | null;
        global?: boolean;
        owner?: string | null;
    }): () => boolean;
    /** 见 ScopeTree#declareScope：决定位置（已有不同父级 ⇒ 抛 scope_conflict） */
    declareScope(childKey: any, parentKey?: any): string | symbol;
    /** 见 ScopeTree#ensureScope：取得句柄（已有 ⇒ 加入，绝不改写位置） */
    ensureScope(childKey: any, parentKey?: any): {
        key: string | symbol;
        parent: string | symbol | null;
        created: boolean;
    };
    /** 见 ScopeTree#releaseScope：引用计数 -1，归零才回收 */
    releaseScope(key: any): boolean;
    /** @returns {string | symbol | null | undefined} `null` = 顶层；`undefined` = 该键未声明 */
    scopeParentOf(scopeKey: any): string | symbol | null | undefined;
    /** 从 key 自身沿祖先链向上的键序列（只读快照，含 key 本身；未声明的键只产出它自己） */
    scopeAncestors(scopeKey: any): (string | symbol)[];
    /** 当前已声明的键数（诊断用；含顶层键） */
    scopeCount(): number;
    /** 当前已声明的作用域键列表（诊断用，顺序确定；与 eventNames 对称） */
    scopeKeys(): (string | symbol)[];
    /**
     * 冲突上报钩子 —— `ensureScope` 发现「请求的父级 ≠ 实际的父级」时调用。
     *
     * ★ 只上报、不改写：调用方拿到的是**实际**那个作用域，只是没拿到它以为的层级。
     *   硬拦会误伤"只想引用一下"的合法用法，静默又会让人排查半天 ——
     *   所以走"照常返回 + 留痕"（与 `onListenerOverflow` 同一口径）。
     *
     * @type {(key: string | symbol, actualParent: string | symbol | null, requestedParent: string | symbol | null) => void}
     */
    onScopeConflict: (key: string | symbol, actualParent: string | symbol | null, requestedParent: string | symbol | null) => void;
    /** 某事件当前有几个监听器（诊断用） */
    listenerCount(name: any): number;
    /** 当前已注册的事件名列表（诊断用，顺序确定） */
    eventNames(): string[];
    /**
     * ★ 宿主用的统一派发入口 —— 带上【调用方的作用域 key】。
     *
     * 为什么单独开一个入口而不改公开方法的签名：
     *   公开方法 `emit(name, ...args)` 的可变参数已经占满签名，
     *   再加一个 options 对象会与"事件的普通参数"混淆（无法区分）。
     *   所以作用域走独立入口，由宿主 ctx 闭包提供 —— 与身份注入同一模式。
     *
     * @param {'emit'|'parallel'|'serial'|'waterfall'} mode
     * @param {string} name
     * @param {string | undefined} scopeKey 调用方作用域；undefined = 全局
     * @param {any[]} args
     */
    dispatch(mode: 'emit' | 'parallel' | 'serial' | 'waterfall', name: string, scopeKey: string | undefined, args: any[]): any;
    emit(name: any, ...args: any[]): void;
    /**
     * 宿主级广播 —— ★【绕开作用域放行规则】，送给【所有】监听器。
     *
     * 为什么需要这个出口：`internal/*` 这类**宿主自身的通知**，语义是「告诉所有关心的人」，
     * 而不是「告诉住在某个作用域里的人」。若走普通派发会踩到官方放行表的一格 ——
     * `dispatchKey === undefined` 时**只放行无标签监听器**，于是
     * `ctx.scoped(...).on('internal/service', ...)` 的订阅者【永远收不到】服务变更，
     * 而代码注释却承诺了「消费者据此重新适配」。
     *
     * ⚠️ 只供宿主内部使用，**不挂到插件 ctx 上** ——
     *   插件拿到它就等于拿到一个「发给所有人」的喇叭，会推翻作用域隔离。
     *
     * @param {string} name
     * @param {...any} args
     */
    broadcast(name: string, ...args: any[]): void;
    /**
     * 广播 + 等全部完成。有监听器失败 ⇒ 抛 CordiumError(listener_failed)，各原始错误在 err.cause.errors。
     *
     * 与 `emit` 的区别：`emit` 是「发完就走」，本方法会等所有监听器的 Promise 结算。
     * 注意 `Promise.allSettled` 语义 —— **一个失败不影响其他继续跑完**，最后统一报错。
     */
    parallel(name: any, ...args: any[]): Promise<void>;
    /**
     * 串行 await，【第一个有回应的赢】。
     *
     * 「有回应」= `isBailed(返回值)` 为真。用于「谁能处理这件事」的链式询问。
     */
    serial(name: any, ...args: any[]): Promise<any>;
    /**
     * ★ 中间件模式 —— 信息可【停留 / 传输 / 变换】。
     *
     * 调用约定（对齐 Cordis `events.ts:117-132`）：
     *   `waterfall(name, ...args, inner)`
     *   最后一个参数是**兜底实现**：前面的监听器都不调 `next()` 时由它收尾。
     *
     *   · 停留 —— 监听器不调 `next()`，直接返回自己的结果
     *   · 传输 —— 监听器调 `next()`
     *   · 变换 —— 监听器改 `args` 后再调 `next()`
     *
     * ⚠️ 两条铁律 —— ★ **依据来源不同，别混为一谈**：
     *
     *   ① **`next()` 调用两次必须抛错** —— 依据是 **`koa-compose` 的源码**（不是"指南"）：
     *      ```js
     *      const nextProxy = async () => {
     *        if (nextCalled) throw Error('next() called multiple times')
     *        nextCalled = true
     *        ...
     *      ```
     *      静默产生诡异行为比直接报错难查得多。
     *
     *   ② **异步监听器必须 `await next()`** —— 依据才是 **Koa 文档的经典陷阱**：
     *      忘记 `await` 会导致「下游还没执行完，流程就结束了」。
     *
     * ★★ 而 `koa-compose` 还有**第三条**守卫，本层**不做** —— 这一条特意记下来免得后人以为是漏了：
     *      ```js
     *      if (nextCalled && !nextResolved) {
     *        throw Error('Middleware resolved before downstream. You are probably missing an await or return')
     *      }
     *      ```
     *   它存在的**前提是全异步**（`await fn(...)` 之后才检查）。
     *   **本层是同步递归**：`next()` 会【同步跑完】整个下游才返回 ⇒
     *   对**同步监听器**而言，"调了 next 却没等它跑完"这件事**根本不可能发生**，
     *   那条检查在这里是恒真的空操作，故不需要。
     *   ⚠️ **但这条豁免只对同步监听器成立**：监听器若是 `async`，
     *   `next()` 会落到微任务里 ⇒ 顺序不再保证 —— 此时**必须自己 `await`**。
     */
    waterfall(name: any, ...args: any[]): any;
    /**
     * 监听器异常上报钩子。宿主可覆盖为审计日志。owner = 订阅时登记的身份（宿主注入的插件 id；未登记为 null）。
     * @type {(name: string, error: any, owner: string | null) => void}
     */
    onListenerError: (name: string, error: any, owner: string | null) => void;
}
