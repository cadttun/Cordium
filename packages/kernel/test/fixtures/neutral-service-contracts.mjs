// 中立服务契约夹具 —— cordium 自持，**不含任何业务服务名**。
//
// ── 为什么需要它 ────────────────────────────────
// `scope-isolation.test.mjs` / `service-contract.test.mjs` 需要一张契约表当【夹具】驱动内核机制。
//   ★ **cordium 不得携带任何业务名** —— 真实的契约表是上层应用的产物，不是内核的。
//
// 本夹具只提供**足够驱动内核机制**的中立服务名，语义与业务无关：
//   · 覆盖三种 `ServiceAccess` 级别（public / declared / internal）
//   · 覆盖 `requiredPermission`（权限门路径）
//   · 服务名一律用 `fixture.*` 前缀，一眼可辨「这不是生产契约」
//
// ⚠️ 本夹具**只用于测试**，不参与任何生产装配路径。
import { ServiceAccess } from '../../src/types.mjs';

/**
 * 中立契约表 —— 形状与 `BASE_SERVICE_CONTRACTS` 完全一致，内容纯中立。
 *
 * @type {Readonly<Record<string, {access: string, requiredPermission?: string}>>}
 */
export const NEUTRAL_SERVICE_CONTRACTS = Object.freeze({
  'fixture.public': Object.freeze({ access: ServiceAccess.PUBLIC }),
  'fixture.declared': Object.freeze({ access: ServiceAccess.DECLARED }),
  'fixture.internal': Object.freeze({ access: ServiceAccess.INTERNAL }),
  // ★ sensitive + requiredPermission：覆盖「权限门」路径（与业务契约表同形）
  'fixture.sensitive': Object.freeze({
    access: ServiceAccess.SENSITIVE,
    requiredPermission: 'perm.fixture.sensitive'
  })
});

/**
 * 把中立契约表装载进宿主 —— 语义等价于 `applyBaseServiceContracts(host)`。
 * @param {import('../../src/index.mjs').CordiumHost} host
 */
export function applyNeutralServiceContracts(host) {
  host.declareServiceContracts(NEUTRAL_SERVICE_CONTRACTS);
  return host;
}
