/**
 * 重新加载一个插件模块并原地换上（同 id）。
 *
 * @param {import('@cordium/kernel').CordiumHost} host
 * @param {{ module: string|URL, config?: object, lifecycleTimeoutMs?: number }} entry
 *        与 `loadPlugins` 同形的清单条目。`disabled` / `group` 不起作用：替换保留插件原来的启停状态。
 * @param {object} [options]
 * @param {boolean} [options.force=false] 不检查 `hotReload` 声明
 * @param {(href: string) => Promise<any>} [options.importModule] 模块加载器（默认动态 `import`）；收到的地址带防缓存查询串
 * @returns {Promise<{ id: string, version: string, previousVersion: string }>}
 */
export declare function reloadPlugin(host: import('@cordium/kernel').CordiumHost, entry: {
    module: string | URL;
    config?: object;
    lifecycleTimeoutMs?: number;
}, options?: {
    force?: boolean;
    importModule?: (href: string) => Promise<any>;
}): Promise<{
    id: string;
    version: string;
    previousVersion: string;
}>;
/**
 * 监视清单里各插件的模块文件，保存即 `reloadPlugin`。
 *
 * ★ 监视文件所在目录而不是文件本身：不少编辑器保存时先写临时文件再改名替换，
 *   直接监视文件的话，第一次保存后监视就断了。
 * ★ 同一文件的连续变更合并成一次（`debounceMs`）；重载进行中又改了 ⇒ 这次完了再重载一次，不并发。
 * ★ 重载失败（语法错、激活失败、未声明 hotReload）只交给 `onError`，监视继续 —— 改好再存一次即可。
 *   激活失败时宿主已换回旧代码（见 `host.replacePlugin`）。
 *
 * @param {import('@cordium/kernel').CordiumHost} host
 * @param {Array<{ module: string|URL, config?: object, lifecycleTimeoutMs?: number }>} entries
 * @param {object} [options]
 * @param {(result: { id: string, version: string, previousVersion: string }) => void} [options.onReload]
 * @param {(err: unknown, entry: object) => void} [options.onError] 缺省 ⇒ `console.error`
 * @param {number} [options.debounceMs=100]
 * @param {boolean} [options.force=false] 同 `reloadPlugin`
 * @param {(href: string) => Promise<any>} [options.importModule] 同 `reloadPlugin`
 * @returns {{ close(): void }}
 */
export declare function watchPlugins(host: import('@cordium/kernel').CordiumHost, entries: Array<{
    module: string | URL;
    config?: object;
    lifecycleTimeoutMs?: number;
}>, options?: {
    onReload?: (result: {
        id: string;
        version: string;
        previousVersion: string;
    }) => void;
    onError?: (err: unknown, entry: object) => void;
    debounceMs?: number;
    force?: boolean;
    importModule?: (href: string) => Promise<any>;
}): {
    close(): void;
};
