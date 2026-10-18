/**
 * @file packages/kernel/src/testing.mjs
 * @description 测试夹具入口 —— `@cordium/kernel/testing`。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 这一层**不进公开面快照，也不在 semver 承诺内**。
 *
 *   它是「**公开可达、但明确不承诺**」的第三档 —— 与 `index.mjs`（稳定面）、
 *   `internal.mjs`（跨包内部共享）都不同。判据来自业界既有形态：
 *   - 微软的测试入口约定：*"anything under the test entry is **unstable and not
 *     part of the supported runtime API**"*；
 *   - 成熟的 JS 库把每个子入口逐个标 `FROZEN` / `preview`，而不是「全都有」或「全都没有」。
 *
 *   ⇒ **显式具名导出**（不用 `export *`）：`export *` 会让将来在该模块里新加的
 *     任何符号自动泄漏成公开面，而这一层的承诺恰恰是「不承诺」——
 *     泄漏与本层的存在目的直接冲突。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────
 *   消费方写测试时反复需要同一套样板：起一个宿主、装配一批桩插件、
 *   断言某个状态。本仓自己的测试里这套逻辑已经抄了几十遍；
 *   消费方侧同样在抄（实测其测试目录里有大量 `new CordiumHost()`）。
 *   把它收成一处，收益是**样板少一份**，代价是**多一个必须维护的入口**。
 *
 *   ★ 但**不因此把它塞进主入口** —— 测试夹具的形状会随测试需要变，
 *     而主入口的每个符号都要背 semver 承诺。
 */
/**
 * 起一个**最小可用**的测试宿主。
 *
 * ★ 刻意不做的事（每一条都是「替调用方做了它该自己决定的事」）：
 *   - **不预装任何插件** —— 测什么装什么；预装会让每个用例都背上一份无关的装配。
 *   - **不预置服务契约** —— 契约是装配层的职责，内核不知道有哪些领域服务。
 *   - **不自动 boot** —— 有的用例要测 `boot()` 之前的行为（那时人人都是 `discovered`）。
 *   - **不吞日志** —— 失败信息是测试的全部价值；要静音请自己传 `maxLogSize: 1`。
 *
 * @param {object} [options] 透传给 `CordiumHost`（`maxLogSize` / `lifecycleTimeoutMs` …）
 * @returns {import('./host.mjs').CordiumHost}
 *
 * @example
 * const host = createTestHost();
 * host.registerPlugin(makeManifest({ id: 'plug.a' }), { activate() {} });
 * await host.boot();
 */
export declare function createTestHost(options?: object): import('./host.mjs').CordiumHost;
/**
 * 造一份**字段齐全且合法**的插件 manifest。
 *
 * ★ 为什么需要：手写 manifest 时最容易漏 `name`（插件层必填）或写错 `apiVersion`，
 *   而报错形态是「校验失败」—— 与被测行为无关的噪音会盖住真正的失败。
 *   本函数把这部分固定下来，用例只写它真正关心的字段。
 *
 * ★ 默认值刻意选**最保守**的：无 `provides`、无 `permissions`、无依赖、
 *   `kind` 走缺省。要什么自己覆盖。
 *
 * @param {Partial<Record<string, any>> & { id: string }} overrides 至少给 `id`
 * @returns {Record<string, any>} 一份可直接交给 `registerPlugin` 的 manifest
 *
 * @example
 * const manifest = makeManifest({ id: 'plug.a', permissions: ['read_secret'] });
 */
export declare function makeManifest(overrides: Partial<Record<string, any>> & {
    id: string;
}): Record<string, any>;
/**
 * 起宿主 → 装配给定插件 → `boot()`，一步到位。
 *
 * ★ 返回**宿主**而不是 `{ host, ... }`：绝大多数用例只要宿主，
 *   多一层解构只是噪音。
 * ★ 仍会把 boot 后的诊断快照挂在 `host` 上吗？**不会** —— 那是测试代码该自己取的
 *   （`host.getDiagnostics()`），塞成属性会让被测对象多出一个不存在的成员。
 *
 * @param {Array<{ manifest: Record<string, any>, entry: Record<string, any> }>} plugins
 * @param {object} [options] 透传给 `createTestHost`
 * @returns {Promise<import('./host.mjs').CordiumHost>}
 *
 * @example
 * const host = await bootTestHost([
 *   { manifest: makeManifest({ id: 'plug.a' }), entry: { activate() {} } }
 * ]);
 */
export declare function bootTestHost(plugins?: Array<{
    manifest: Record<string, any>;
    entry: Record<string, any>;
}>, options?: object): Promise<import('./host.mjs').CordiumHost>;
/**
 * 断言一个错误带指定的 `code`。
 *
 * ★ 消费方测试里最常见的断言形态是「抛了带这个码的错」，
 *   而手写 `assert.equal(err.code, 'x')` 会在 **没抛** 时给出一个
 *   「`undefined` !== `'x'`」的报错 —— 看不出真正原因（该抛没抛）。
 *   本函数先判「有错误对象」，再判码。
 *
 * @param {unknown} err 捕获到的错误（可为 `undefined`）
 * @param {string} code 期望的错误码
 * @param {string} [what] 出错时附在报文里的定位信息
 * @throws {Error} 断言失败时抛（由调用方的测试框架接管）
 */
export declare function assertErrorCode(err: unknown, code: string, what?: string): void;
