/**
 * @file packages/kernel/src/ui-registry.mjs
 * @description UI 贡献注册表 —— **内部实现，不经 index / internal 导出**。
 *
 * ★ Extract Class：`#items` 表连同它的三个操作一起从 host.mjs 搬出（字段与方法同搬，不泄出私有字段）。
 *   宿主以私有字段持有实例、公开方法委托；插件仍只经 ctx.registerUIContribution 进来。
 * ★ 不认识插件表 / 生命周期：scope 是否已释放由调用方传入的 scope 自己回答，属主由调用方注入。
 */
export type UIRegistryQueries = {
    /**
     * `type` 是否为装配方登记过的合法值
     */
    isKnownType?: (type: string) => boolean;
    /**
     * 已登记值集（仅用于报文）
     */
    knownTypes?: () => string[];
};
/**
 * @typedef {object} UIRegistryQueries
 * @property {(type: string) => boolean} [isKnownType] `type` 是否为装配方登记过的合法值
 * @property {() => string[]} [knownTypes] 已登记值集（仅用于报文）
 */
export declare class UIRegistry {
    #private;
    /** @param {UIRegistryQueries} [queries] 不传 ⇒ 不校验 `type`（保持旧行为） */
    constructor(queries?: UIRegistryQueries);
    /** 当前条目数（诊断用） */
    get size(): number;
    /**
     * 注册 UI 贡献项 (面板/快捷栏/命令)
     * @param {string | object} contribution
     * @param {string} ownerId
     * @param {import('./scope.mjs').EffectScope | null} scope
     */
    register(contribution: string | object, ownerId: string, scope: import('./scope.mjs').EffectScope | null): void;
    /** 按属主注销（非属主的注销请求不生效） */
    unregister(contributionId: any, ownerId: any): void;
    /** 列出贡献项的副本（按 type 过滤） */
    list(type: any): any[];
}
