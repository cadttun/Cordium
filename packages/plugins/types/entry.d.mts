/**
 * 校验并规范化一个清单条目。
 * @param {any} entry
 * @param {string} where 报错前缀，如 `loadPlugins: entries[0]`
 */
export declare function normalizeEntry(entry: any, where: string): {
    href: string;
    config: any;
    disabled: boolean;
    group: any;
    lifecycleTimeoutMs: any;
};
export declare const defaultImport: (href: any) => Promise<any>;
/**
 * 加载一个模块并读出插件形状；任何失败都归一为带码错误。
 * @param {string} href 交给 importModule 的地址（重载时带防缓存查询串）
 * @param {(href: string) => Promise<any>} importModule
 * @param {string} fn 报错前缀
 */
export declare function loadOne(href: string, importModule: (href: string) => Promise<any>, fn: string): Promise<any>;
/** 清单条目 → 内核 entry：config 由加载器注入 activate 第二参 */
export declare function hostEntry(plugin: any, config: any): {
    activate: (ctx: any) => any;
    deactivate: () => any;
};
export declare function assertHost(host: any, fn: any): void;
