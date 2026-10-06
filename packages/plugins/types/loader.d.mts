/**
 * 按清单加载并注册插件。
 *
 * @param {import('@cordium/kernel').CordiumHost} host
 * @param {Array<{ module: string|URL, config?: object, disabled?: boolean, group?: string }>} entries
 * @param {object} [options]
 * @param {(href: string) => Promise<any>} [options.importModule] 模块加载器（默认动态 `import`）；测试 / 打包场景可注入
 * @returns {Promise<Array<{ id: string, group: string|null, disabled: boolean }>>} 按清单顺序
 */
export declare function loadPlugins(host: import('@cordium/kernel').CordiumHost, entries: Array<{
    module: string | URL;
    config?: object;
    disabled?: boolean;
    group?: string;
}>, options?: {
    importModule?: (href: string) => Promise<any>;
}): Promise<Array<{
    id: string;
    group: string | null;
    disabled: boolean;
}>>;
