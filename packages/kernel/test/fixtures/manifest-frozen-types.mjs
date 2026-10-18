// ★★ 类型层的判别性夹具 —— **只用于 `tsc --noEmit`**，运行期不会被 import。
//
// 为什么需要它：`manifest-frozen-type.test.mjs` 里那条「声明里写的是 FrozenPluginManifest」
// 只证明**名字对了**，证明不了**那个名字真的会拦住写操作**。
// 这两件事完全不同：一个起错名的空类型同样能让那条断言变绿。
//
// ⇒ 这里用 `@ts-expect-error` 把「写 ctx.manifest 必须报错」这件事**编译期**钉住：
//   · 若 `ctx.manifest` 变回可写的 `PluginManifest` ⇒ 下面几条 `@ts-expect-error`
//     会因为「根本没有错误」而**报 TS2578**（未使用的 @ts-expect-error）⇒ 门禁变红；
//   · 若类型**过于**收紧（连读都报错）⇒ 上面那几条正向读取会红。
//   两个方向都判了，才不是空断言。
//
// ⚠️ 本文件必须在 `tsconfig.json` 的 include 范围内才会被检查 ——
//   现在 `include` 是 `packages/*/src/**`，**不含 test/**。
//   ⇒ 由 `manifest-frozen-type.test.mjs` 显式跑一次 `tsc` 把它纳入检查（见那边）。

/**
 * @param {import('../../src/host.mjs').PluginContext} ctx
 */
export function probeFrozenManifest(ctx) {
  // ── 正向：读操作必须全部可用（否则类型收得过头了）──
  /** @type {string} */ const id = ctx.manifest.id;
  /** @type {string} */ const version = ctx.manifest.version;
  /** @type {readonly string[]} */ const provides = ctx.manifest.provides;
  /** @type {number} */ const n = ctx.manifest.provides.length;
  const dep = ctx.manifest.dependencies['plug.a'];

  // ── 反向：任何写操作都必须报错 ──
  // @ts-expect-error 顶层字段不可写
  ctx.manifest.id = 'plug.changed';

  // @ts-expect-error 嵌套数组不可 push
  ctx.manifest.provides.push('svc.x');

  // @ts-expect-error 嵌套对象不可赋值
  ctx.manifest.dependencies['plug.b'] = '^2.0.0';

  return { id, version, provides, n, dep };
}

export const __probe = probeFrozenManifest;
