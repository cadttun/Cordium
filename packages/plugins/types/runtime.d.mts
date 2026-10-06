export declare const PLUGIN_API_VERSION = "1.0.0";
export type PluginDescriptor = {
    id: string;
    name: string;
    version: string;
    apiVersion: string;
    provides: string[];
    permissions: string[];
    dependencies: Record<string, string>;
    /**
     * `'core'` | `'business'`
     */
    kind: string;
    /**
     * `'eager'` | `'lazy'`
     */
    activation: string;
};
/**
 * 校验并归一化**插件描述符层**的 manifest。
 *
 * 入参是调用方自报的原始输入（形状未校验），故不写成具体类型；本函数负责判成 `PluginDescriptor`。
 *
 * @param {unknown} input 原始 manifest（形状未校验）
 * @param {object} [options]
 * @param {string} [options.apiVersion]
 * @returns {PluginDescriptor} 白名单重建后的归一化 manifest
 * @throws {CordiumError} 非法时抛 `invalid_manifest`
 */
export declare function validatePluginManifest(input: unknown, options?: {
    apiVersion?: string;
}): PluginDescriptor;
/**
 * ★ 同 `validatePluginManifest`，另返回白名单重建丢掉的字段。
 *
 * 为什么是新入口而不是改返回形状：`validatePluginManifest` 的返回值已定稿，改它是破坏性变更；
 * 这里是纯增量。`diagnostic` 与内核 `diffManifestFields` 同一形状（`path: 'plugin'`），
 * 可直接交给 `host.recordManifestDiagnostic`。不丢字段时为 `null`。
 *
 * @param {unknown} input 原始 manifest（形状未校验，同 `validatePluginManifest`）
 * @param {object} [options]
 * @param {string} [options.apiVersion]
 * @returns {{ manifest: PluginDescriptor, diagnostic: object|null }}
 */
export declare function validatePluginManifestDetailed(input: unknown, options?: {
    apiVersion?: string;
}): {
    manifest: PluginDescriptor;
    diagnostic: object | null;
};
