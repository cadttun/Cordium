// 中立插件夹具 —— cordium 自持，**不含任何业务插件内容**。
//
// ── 为什么需要它 ────────────────────────────────
// `service-contract.test.mjs` 的跨层字段反例用例要验证「**两层共用同一份 manifest** 的插件走描述符层不得报 warn」。
// 它守的是**内核的跨层字段识别机制**，与插件做什么无关 ⇒ 用本中立夹具即可。
//
// ⚠️ 本夹具**只用于测试**，不参与任何生产装配路径。

/**
 * 中立插件 manifest —— 刻意携带内核层保留、插件层不保留的字段：
 *   · `displayName` / `description` —— 内核 `validateManifest` 保留，插件层不保留
 *   ⇒ 这正是该用例要断言的「跨层保留字段」场景。
 *
 * 字段齐全（provides / permissions / dependencies 均为合法形态），
 * 确保 `validateManifest` 放行后再走 `diffManifestFields` 比对。
 */
export const NEUTRAL_PLUGIN_MANIFEST = Object.freeze({
  id: 'plugin.fixture.neutral',
  // ★ `name` 是插件层 `validateManifest` 的**必填**字段（非空字符串）；
  //   `displayName` 只有内核层保留 ⇒ 两个都要有，才构成「跨层共用 manifest」的场景。
  name: '中立夹具插件',
  version: '1.0.0',
  apiVersion: '1.0.0',
  displayName: '中立夹具插件',
  description: '两套 schema 共用 manifest 的测试夹具（不含任何业务语义）',
  provides: [],
  permissions: [],
  dependencies: {},
  kind: 'core'
});

/** 最小的可注册 entry（供需要「真注册」的用例使用） */
export const NEUTRAL_PLUGIN_ENTRY = Object.freeze({
  async activate() {},
  async deactivate() {}
});
