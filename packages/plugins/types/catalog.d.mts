export type CatalogEntry = {
    manifest: import('./runtime.mjs').PluginDescriptor;
    source: string;
    packageUrl: string | null;
};
/**
 * catalog 条目：条目字段（`source` / `packageUrl`）与归一化后的 manifest 并列。
 * @typedef {object} CatalogEntry
 * @property {import('./runtime.mjs').PluginDescriptor} manifest
 * @property {string} source
 * @property {string|null} packageUrl
 */
/**
 * @param {object} [options]
 * @param {string} [options.apiVersion]
 * @param {(diagnostic: object) => void} [options.onDiagnostic] 丢字段回调 ★ manifest 白名单重建时回调
 *   （形状同内核 diffManifestFields，可直接接 `host.recordManifestDiagnostic`）。
 *   此前 catalog 静默丢字段，且 exportIndex 把丢失写进索引 ⇒ 不可逆。
 */
export declare function createPluginCatalog(options?: {
    apiVersion?: string;
    onDiagnostic?: (diagnostic: object) => void;
}): {
    add: (input: Record<string, unknown>) => CatalogEntry;
    list: () => CatalogEntry[];
    /**
     * 按 id 取条目（副本）；不存在 ⇒ `null`。
     * @param {string} id
     * @returns {CatalogEntry|null}
     */
    resolve(id: string): CatalogEntry | null;
    /**
     * 导出目录索引（JSON 文本）。
     * @returns {string}
     */
    exportIndex(): string;
    /**
     * 从 JSON 文本整体导入（原子：先全验后替换）。
     * @param {string} raw
     * @returns {CatalogEntry[]}
     */
    importIndex(raw: string): CatalogEntry[];
};
