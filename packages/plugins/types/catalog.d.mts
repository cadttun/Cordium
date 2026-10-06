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
    add: (input: any) => any;
    list: () => any[];
    resolve(id: any): any;
    exportIndex(): string;
    importIndex(raw: any): any[];
};
