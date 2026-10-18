export type ServiceContract = {
    access: string;
    requiredPermission?: string;
    providers: Map<string, any>;
    providerEpochs: Map<string, number>;
    scopedProviders: Map<string | symbol, Map<string, any>>;
};
export type ResolvedProvider = {
    providerId: string;
    impl: any;
    epoch: number;
    slotKey: string | symbol | null;
};
export type CallerRecord = {
    manifest: {
        dependencies: Record<string, string>;
    };
    state: string;
};
/**
 * @typedef {{ access: string, requiredPermission?: string, providers: Map<string, any>, providerEpochs: Map<string, number>, scopedProviders: Map<string | symbol, Map<string, any>> }} ServiceContract
 * @typedef {{ providerId: string, impl: any, epoch: number, slotKey: string | symbol | null }} ResolvedProvider
 * @typedef {{ manifest: { dependencies: Record<string, string> }, state: string }} CallerRecord
 */
/**
 * 取【单个作用域】里的实现（不含祖先查找、不含全局回退）。
 *
 * @param {ServiceContract} contract
 * @param {string | symbol | null} scopeKey 要查的槽
 * @returns {ResolvedProvider | null}
 */
export declare function providerInScope(contract: ServiceContract, scopeKey: string | symbol | null): ResolvedProvider | null;
/**
 * 解析服务的活动实现。
 *
 * ★ 一个服务名只可能有一个提供者（注册撞名即拒），所以【同一个作用域内】至多一个。
 *
 * ★ 作用域解析规则（注册视图向下继承）：
 *   从调用方的作用域出发沿【祖先链】向上找，**最近的先赢**；
 *   链上都找不到才回退【全局】实现。⇒ 全局实现永远是兜底。
 *
 * @param {ServiceContract} contract
 * @param {string | symbol | null} scopeKey 调用方的作用域；null = 全局，symbol = 私有作用域
 * @param {(key: string | symbol | null) => Array<string | symbol>} scopeAncestors
 *        ★ 祖先遍历只有一份实现（`ScopeTree#ancestors`），由调用方经 channel 注入，**不在此重复**
 * @returns {ResolvedProvider | null}
 */
export declare function resolveProvider(contract: ServiceContract, scopeKey: string | symbol | null, scopeAncestors: (key: string | symbol | null) => Array<string | symbol>): ResolvedProvider | null;
/**
 * 按契约声明的 access 级别校验调用方是否有权取用该服务。
 *
 * 全部读【宿主持有的记录】（pluginDependencies / pluginPermissions），
 * 不读插件能改的对象 —— 这是鉴权依据隔离的落点。
 *
 * @param {{ serviceName: string, contract: ServiceContract, callerPluginId: string, providerId: string | null,
 *           caller: CallerRecord | undefined, declaredDeps: Set<string> | undefined, grantedPerms: Set<string> | undefined }} ctx
 */
export declare function assertServiceAccess({ serviceName, contract, callerPluginId, providerId, caller, declaredDeps, grantedPerms }: {
    serviceName: string;
    contract: ServiceContract;
    callerPluginId: string;
    providerId: string | null;
    caller: CallerRecord | undefined;
    declaredDeps: Set<string> | undefined;
    grantedPerms: Set<string> | undefined;
}): void;
