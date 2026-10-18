/**
 * @file packages/kernel/src/service-resolution.mjs
 * @description 服务的**解析与鉴权**：从契约里找出「实际服务你的那个提供者」，并按 access 级别判定放行。
 *
 * ── 为什么单独一个文件 ───────────────────────────────────────────────
 *   这一组只做「**查表 → 判定 → 返回/抛错**」：
 *   · `resolveProvider` / `providerInScope` —— **纯查找**，不改任何状态；
 *   · `assertServiceAccess` —— **纯判定**，只读宿主持有的 `pluginDependencies` / `pluginPermissions`。
 *   没有一处写共享状态 ⇒ 可以安全搬出，且可被单测直接调用。
 *
 * ★★ 报文的**错误码与措辞必须与拆分前逐字相同** —— 既有调用方与测试按它们断言。
 */
import { CordiumError, ErrorCode } from './errors.mjs';
import { ServiceAccess } from './types.mjs';
import { hasRunActivate } from './service-handle.mjs';

/**
 * @typedef {{ access: string, requiredPermission?: string, providers: Map<string, any>, providerEpochs: Map<string, number>, scopedProviders: Map<string | symbol, Map<string, any>> }} ServiceContract
 * @typedef {{ providerId: string, impl: any, epoch: number, slotKey: string | symbol | null }} ResolvedProvider
 * @typedef {{ manifest: { dependencies: Record<string, string> }, state: string }} CallerRecord
 */

/**
 * 取【单个作用域】里的实现（不含祖先查找、不含全局回退）。
 *
 * @param {ServiceContract} contract
 * @param {string | symbol | null} scopeKey 要查的槽
 * @returns {ResolvedProvider | null}
 */
export function providerInScope(contract, scopeKey) {
  if (scopeKey === null) {
    // 同一作用域最多一个提供者；Map 的唯一项就是当前注册。
    const [pid, impl] = contract.providers.entries().next().value || [];
    if (!pid) return null;
    return {
      providerId: pid,
      impl,
      epoch: contract.providerEpochs.get(pid) || 0,
      slotKey: null
    };
  }
  const bucket = contract.scopedProviders.get(scopeKey);
  if (!bucket) return null;
  // 桶内最多一条（撞名即拒）⇒ 直接取首元素，与上方全局槽同一个取法。
  const first = bucket.entries().next().value;
  if (!first) return null;
  const [pid, entry] = first;
  return { providerId: pid, impl: entry.impl, epoch: entry.epoch, slotKey: scopeKey };
}

/**
 * 解析服务的活动实现。
 *
 * ★ 一个服务名只可能有一个提供者（注册撞名即拒），所以【同一个作用域内】至多一个。
 *
 * ★ 作用域解析规则（注册视图向下继承）：
 *   从调用方的作用域出发沿【祖先链】向上找，**最近的先赢**；
 *   链上都找不到才回退【全局】实现。⇒ 全局实现永远是兜底。
 *
 * @param {ServiceContract} contract
 * @param {string | symbol | null} scopeKey 调用方的作用域；null = 全局，symbol = 私有作用域
 * @param {(key: string | symbol | null) => Array<string | symbol>} scopeAncestors
 *        ★ 祖先遍历只有一份实现（`ScopeTree#ancestors`），由调用方经 channel 注入，**不在此重复**
 * @returns {ResolvedProvider | null}
 */
export function resolveProvider(contract, scopeKey, scopeAncestors) {
  for (const cursor of scopeAncestors(scopeKey)) {
    const hit = providerInScope(contract, cursor);
    if (hit) return hit;
  }
  return providerInScope(contract, null);
}

/**
 * 按契约声明的 access 级别校验调用方是否有权取用该服务。
 *
 * 全部读【宿主持有的记录】（pluginDependencies / pluginPermissions），
 * 不读插件能改的对象 —— 这是鉴权依据隔离的落点。
 *
 * @param {{ serviceName: string, contract: ServiceContract, callerPluginId: string, providerId: string | null,
 *           caller: CallerRecord | undefined, declaredDeps: Set<string> | undefined, grantedPerms: Set<string> | undefined }} ctx
 */
export function assertServiceAccess({ serviceName, contract, callerPluginId, providerId, caller, declaredDeps, grantedPerms }) {
  if (!caller) {
    throw new CordiumError(ErrorCode.ACCESS_DENIED, `Security Violation: caller plugin '${callerPluginId}' is not registered`);
  }
  // ★ ACTIVATING 期同样允许取依赖：插件在 activate() 里取服务是合法用法，
  //   限制成「仅 ACTIVE」会逼着人把代码从 activate() 里搬走。
  if (!hasRunActivate(caller.state)) {
    throw new CordiumError(ErrorCode.ACCESS_DENIED,
      `Security Violation: caller plugin '${callerPluginId}' is not active (state=${caller.state})`
    );
  }

  if (contract.access === ServiceAccess.INTERNAL) {
    throw new CordiumError(ErrorCode.ACCESS_DENIED,
      `Security Violation: service '${serviceName}' is internal and cannot be accessed by plugins`
    );
  }

  // declared 与 sensitive 都要求：调用方声明过【提供者插件】的依赖
  if (contract.access === ServiceAccess.DECLARED || contract.access === ServiceAccess.SENSITIVE) {
    // ★ 必须查【真正会服务你的那个提供者】，而不是只看全局槽。
    if (!providerId || !declaredDeps || !declaredDeps.has(providerId)) {
      throw new CordiumError(ErrorCode.ACCESS_DENIED,
        `Security Violation: plugin '${callerPluginId}' did not declare a dependency on provider `
        + `'${providerId || '(none)'}' for service '${serviceName}'`
      );
    }
  }

  if (contract.access === ServiceAccess.SENSITIVE) {
    if (!contract.requiredPermission || !grantedPerms || !grantedPerms.has(contract.requiredPermission)) {
      throw new CordiumError(ErrorCode.ACCESS_DENIED,
        `Security Violation: plugin '${callerPluginId}' lacks required permission `
        + `'${contract.requiredPermission}' for service '${serviceName}'`
      );
    }
  }
}
