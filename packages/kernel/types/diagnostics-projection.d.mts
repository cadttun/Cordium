/**
 * manifest 的**白名单投影** —— 字段集由 `MANIFEST_FIELD_TABLE.kernel` 派生（唯一真相源）。
 *
 * ★ 为什么不能手抄清单：每次加字段都会「manifest 与契约表都改了、投影忘了跟」，
 *   而手工清单的门禁也救不了它（门禁只检查它自己列的那几个 ⇒ 新字段被两边同时忽略、照常全绿）。
 * ★ 拷数组 / 拷对象：诊断是只读快照，不能把内部引用交出去。
 *
 * @param {import('./types.mjs').PluginManifest} manifest
 * @returns {import('./types.mjs').PluginManifest}
 */
export declare function manifestSnapshot(manifest: import('./types.mjs').PluginManifest): import('./types.mjs').PluginManifest;
/**
 * 插件记录的诊断投影（manifest 白名单 + 运行态 + 未满足依赖）。
 *
 * @param {string} id 记录的 id（它是 Map 的键，**不在记录里**）
 * @param {{ manifest: any, state: string, error?: unknown, activationMs: number }} record
 * @param {(id: string, manifest: any) => { id: string, reason: string }[]} unresolvedOf
 * @returns {import('./types.mjs').PluginManifest & { state: string, error: string | null, activationMs: number, unresolvedDependencies: { id: string, reason: string }[] }}
 */
export declare function pluginSnapshot(id: string, record: {
    manifest: any;
    state: string;
    error?: unknown;
    activationMs: number;
}, unresolvedOf: (id: string, manifest: any) => {
    id: string;
    reason: string;
}[]): import('./types.mjs').PluginManifest & {
    state: string;
    error: string | null;
    activationMs: number;
    unresolvedDependencies: {
        id: string;
        reason: string;
    }[];
};
/**
 * 单个服务契约的诊断投影。
 *
 * ★ 计数与明细**分立**：`providerCount` 是聚合口径，`scopedProviders` 是排障口径，互不替代。
 * ★ `scopeKey` / `providerId` 一律 `String()` 渲染 —— 可能是 Symbol（私有作用域），只供观察、不可回用。
 *
 * @param {string} name
 * @param {{ access: string, requiredPermission?: string | null, methods?: readonly string[] | null,
 *           providers: Map<string, any>, scopedProviders: Map<string | symbol, Map<string, any>> }} contract
 * @returns {object}
 */
export declare function serviceSnapshot(name: string, contract: {
    access: string;
    requiredPermission?: string | null;
    methods?: readonly string[] | null;
    providers: Map<string, any>;
    scopedProviders: Map<string | symbol, Map<string, any>>;
}): object;
