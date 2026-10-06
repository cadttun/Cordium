/**
 * @file packages/kernel/src/scope.mjs
 * @description 资源所有权与清理作用域 (Effect Scope)
 */
export type ScopeReleaseCallbacks = {
    releaseService?: (serviceName: string, scope: EffectScope) => void;
    releaseUIContribution?: (contributionId: string, ownerId: string) => void;
    /**
     * 清理回调抛错的上报口（缺省退回 console）
     */
    onDisposeError?: (ownerId: string, err: unknown) => void;
};
/**
 * 宿主注入本作用域的三个释放回调（构造函数第二参；独立使用时可不传）。
 * 宿主经它交付「按 scope 身份释放」的能力，而不交出宿主实例本身。
 *
 * @typedef {object} ScopeReleaseCallbacks
 * @property {(serviceName: string, scope: EffectScope) => void} [releaseService]
 * @property {(contributionId: string, ownerId: string) => void} [releaseUIContribution]
 * @property {(ownerId: string, err: unknown) => void} [onDisposeError] 清理回调抛错的上报口（缺省退回 console）
 */
export declare class EffectScope {
    #private;
    /**
     * @param {string} ownerId 拥有者标识 (如插件 ID)
     * @param {ScopeReleaseCallbacks | null} [release]
     *   释放回调；缺省 ⇒ 独立使用时只清理定时器与 disposer
     * @param {symbol | null} [releaseKey] 释放令牌；给定后 dispose 必须出示同一个令牌
     */
    constructor(ownerId: string, release?: ScopeReleaseCallbacks | null, releaseKey?: symbol | null);
    /** 存活状态（只读） */
    get active(): boolean;
    /**
     * 以下四个 getter 只交付【快照副本】，不是内部集合本身。
     *
     * ★ 为什么给副本：插件拿到的若是活引用，`ctx.scope.disposers.clear()` 就能
     *   在停用前把清理链掏空（监听器永不摘除）；给副本则 clear() 只是改了个临时对象。
     * ★ 只读 getter 而非直接暴露字段，是为了让「读得到」与「改得动」分开：
     *   需要登记请走 addDisposer / trackTimer / trackService / trackUIContribution，
     *   它们带存活校验。
     */
    get disposers(): Set<Readonly<{}>>;
    get timers(): Set<any>;
    get services(): Set<any>;
    get uiContributions(): Set<any>;
    /**
     * 注册清理回调
     * @param {() => void | Promise<void>} fn
     */
    addDisposer(fn: () => void | Promise<void>): () => boolean;
    /**
     * 宿主专用：登记一个【同步】释放回调，dispose 时先于插件的 disposer 执行，不受其挂起影响。
     * 须出示释放令牌（插件拿不到），否则 scope_owned_by_host。
     * @param {() => void} fn
     * @param {symbol | null} releaseKey
     */
    addHostDisposer(fn: () => void, releaseKey: symbol | null): () => boolean;
    /**
     * 托管定时器 (卸载时自动清理，杜绝内存泄漏)
     * @param {any} timerId
     */
    trackTimer(timerId: any): any;
    /**
     * 取消托管一个定时器（一次性定时器触发后、或插件自行 clear 后调用）。
     *
     * ★ scope 无从得知一个裸 timer id 何时触发 ——
     *   只 track 不 untrack 的一次性定时器会一直留在集合里直到插件停用（实测 500 个残留）。
     *   常驻插件大量使用 setTimeout 时应在回调里调用本方法。
     * @param {any} timerId
     * @returns {boolean} 是否曾被托管
     */
    untrackTimer(timerId: any): boolean;
    /**
     * 托管服务注册
     * @param {string} serviceName
     */
    trackService(serviceName: string): void;
    /**
     * 托管 UI 贡献 (面板、按钮等)
     * @param {string} contributionId
     */
    trackUIContribution(contributionId: string): void;
    /**
     * 释放本 Scope 下的所有资源。
     *
     * ★ 幂等 + 可并发：第二次及以后的调用【等同一个 promise】，而不是立刻返回。
     *   旧实现是「第二次直接 return」，于是在并发 teardown 下，
     *   `await scope.dispose()` 可能在你以为"已经清干净"时其实第一次还没跑完。
     */
    dispose(releaseKey: any, { timeoutMs }?: {
        timeoutMs?: number;
    }): any;
}
