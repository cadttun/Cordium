/**
 * @file packages/kernel/src/diagnostics-projection.mjs
 * @description 诊断快照的**纯投影**：把宿主的只读表 / 契约表摊成对外快照的形状。
 *
 * ── 为什么单独一个文件 ───────────────────────────────────────────────
 *   这些函数**只读入参、返回新对象**，不碰生命周期、不写任何状态。
 *   它们回答的是「**这个快照长什么样**」，与「什么时候生成快照」（宿主）是两件事。
 *
 * ★★ 快照形状是**稳定面**（`DIAGNOSTICS_CONTRACT.stable`）⇒ 投影字段的增删即契约变更。
 */
import { MANIFEST_FIELD_TABLE, LifecycleState } from './types.mjs';
import { describeError } from './host-util.mjs';

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
export function manifestSnapshot(manifest) {
  const out = /** @type {import('./types.mjs').PluginManifest} */ ({});
  for (const field of MANIFEST_FIELD_TABLE.kernel) {
    const value = manifest[field];
    out[field] = Array.isArray(value) ? [...value]
      : (value !== null && typeof value === 'object') ? { ...value }
      : value;
  }
  return out;
}

/**
 * 插件记录的诊断投影（manifest 白名单 + 运行态 + 未满足依赖）。
 *
 * @param {string} id 记录的 id（它是 Map 的键，**不在记录里**）
 * @param {{ manifest: any, state: string, error?: unknown, activationMs: number }} record
 * @param {(id: string, manifest: any) => { id: string, reason: string }[]} unresolvedOf
 * @returns {import('./types.mjs').PluginManifest & { state: string, error: string | null, activationMs: number, unresolvedDependencies: { id: string, reason: string }[] }}
 */
export function pluginSnapshot(id, record, unresolvedOf) {
  return {
    ...manifestSnapshot(record.manifest),
    state: record.state,
    error: record.state === LifecycleState.FAILED ? describeError(record.error) : null,
    activationMs: record.activationMs,
    // ★ 依赖没齐 ⇒「它为什么没起来」只能靠这一项回答
    unresolvedDependencies: unresolvedOf(id, record.manifest)
  };
}

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
export function serviceSnapshot(name, contract) {
  return {
    name,
    access: contract.access,
    requiredPermission: contract.requiredPermission,
    // 接口形状（未声明 = null）；拷贝一份，诊断是只读快照
    methods: contract.methods ? [...contract.methods] : null,
    // 单提供者语义下，诊断值是当前全局槽的派生快照，不是可写的「活动主」状态。
    // ★ 断言 `string | null`：`keys().next().value` 在本仓 TS 版本被推成 `any`
    activeProvider: /** @type {string | null} */ (contract.providers.keys().next().value || null),
    providerCount: contract.providers.size,
    // ★ 上面两项只看【全局槽】—— 只注册了作用域实现的服务此前显示「0 个提供者」，
    //   与「确实没人提供」不可区分。作用域实现单独计数，不混进全局口径。
    scopedProviderCount: Array.from(contract.scopedProviders.values()).reduce((n, bucket) => n + bucket.size, 0),
    scopedProviders: Array.from(contract.scopedProviders, ([scopeKey, bucket]) => ({
      scopeKey: String(scopeKey),
      providerId: /** @type {string | null} */ (bucket.keys().next().value ?? null)
    }))
  };
}
