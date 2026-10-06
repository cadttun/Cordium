/**
 * @file packages/kernel/src/action-registry.mjs
 * @description 受控动作表：注册 / 注销 / 鉴权派发。
 *
 * ★ 从 host.mjs 原样搬出（Extract Class：`#actionHandlers` 字段与读写它的方法一起搬）。
 *   **内部实现，不经 index / internal 导出**；宿主以私有字段持有实例，公开方法只做委托。
 * ★ 本类不认识插件表：宿主注入四个【窄查询】——
 *   这里只问「调用方能不能调」「持不持有这个权限」「权限名登没登记」，不拿插件记录本身。
 *   鉴权事实（权限快照、生命周期状态）仍只在宿主那边，本类读不到也改不了。
 */
export type ActionRegistryQueries = {
    /**
     * 调用方是否处于可调用状态（ACTIVE / ACTIVATING）
     */
    isCallerLive: (callerPluginId: string) => boolean;
    /**
     * 读【宿主持有的权限快照】
     */
    hasPermission: (callerPluginId: string, permission: string) => boolean;
    /**
     * 未登记即抛 undeclared_permission
     */
    assertPermissionDeclared: (name: string, where: string) => void;
    /**
     * 单条未设 timeoutMs 时的回退值（0 / 负数 = 不限）
     */
    defaultTimeoutMs: () => number;
    /**
     * 同时在途的派发数上限
     */
    maxInFlight: () => number;
    /**
     * 宿主释放令牌（登记宿主自有的释放回调用）
     */
    releaseKey: symbol;
    /**
     * 写宿主审计日志
     */
    log: (level: string, message: string, details?: any) => void;
};
/**
 * @typedef {object} ActionRegistryQueries
 * @property {(callerPluginId: string) => boolean} isCallerLive 调用方是否处于可调用状态（ACTIVE / ACTIVATING）
 * @property {(callerPluginId: string, permission: string) => boolean} hasPermission 读【宿主持有的权限快照】
 * @property {(name: string, where: string) => void} assertPermissionDeclared 未登记即抛 undeclared_permission
 * @property {() => number} defaultTimeoutMs 单条未设 timeoutMs 时的回退值（0 / 负数 = 不限）
 * @property {() => number} maxInFlight 同时在途的派发数上限
 * @property {symbol} releaseKey 宿主释放令牌（登记宿主自有的释放回调用）
 * @property {(level: string, message: string, details?: any) => void} log 写宿主审计日志
 */
export declare class ActionRegistry {
    #private;
    /** @param {ActionRegistryQueries} queries */
    constructor(queries: ActionRegistryQueries);
    /** 已登记的动作数（诊断用） */
    get size(): number;
    /**
     * 注册受控动作 (Action)
     */
    register(action: any, ownerId: any, options: any, scope: any): void;
    /**
     * 执行安全受控动作调度 (严格基于调用方权限声明鉴权)
     * @param {string} callerPluginId
     * @param {string} action
     * @param {any} payload
     */
    dispatch(callerPluginId: string, action: string, payload: any): Promise<any>;
}
