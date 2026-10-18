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
     * 输入可缺省（缺省归一为 `'business'`）
     */
    kind?: PluginKindValue;
    /**
     * 同上（缺省归一为 `'eager'`）
     *
     * ★★ `kind` / `activation` **必须可选**：`validatePluginManifest` 接受不带它们的输入
     * 并补默认值 ⇒ 标成必需会让消费方传 `{ id, name, version, … }` 时**跨包报 TS2739**（实测）。
     * 「归一化后一定有值」是**返回值**的性质，不是**入参**的性质 —— 同一个 typedef
     * 同时被用作两者时，只能取更宽的那一侧（否则等于替调用方强加它没有的义务）。
     * ⚠️ 字段表由 `typedef-drift` 门禁比对：`@property` 必须**独占一行且连续**，
     * 中间插续行说明会把表截断。
     */
    activation?: ActivationPolicyValue;
};
export type PluginKindValue = typeof import('@cordium/kernel').PluginKind[keyof typeof import('@cordium/kernel').PluginKind];
export type ActivationPolicyValue = typeof import('@cordium/kernel').ActivationPolicy[keyof typeof import('@cordium/kernel').ActivationPolicy];
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
