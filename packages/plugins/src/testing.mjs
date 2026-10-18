/**
 * @file packages/plugins/src/testing.mjs
 * @description 测试夹具入口 —— `@cordium/plugins/testing`。
 *
 * ★★ 与 `@cordium/kernel/testing` **同一档**：公开可达、**不承诺 semver**、不进公开面快照。
 *   理由与形态见内核侧同名文件的文件头。
 *
 * ── 这一层提供什么 ──────────────────────────────────────────────────
 *   插件包侧的样板主要是**造一份能通过校验的清单**与**造一个可加载的模块文件**。
 *   两者的失败形态都是「校验 / 加载失败」，与真正被被测的行为无关 ——
 *   夹具的职责就是把这类噪音固定下来。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 造一份**插件描述符层**（`validatePluginManifest` 走的那套）合法的清单。
 *
 * ★ 与内核侧 `makeManifest` 的差别（两层字段集不同，别混用）：
 *   · 插件层必填 `name`（内核层不认这个字段，它用 `displayName`）；
 *   · 插件层不保留 `displayName` / `description`（那是内核层字段）。
 *   ⇒ 两层各有一个构造函数，**不是**同一份的两个包装 —— 合并会让「哪层要什么」更难看懂。
 *
 * @param {Partial<Record<string, any>> & { id: string }} overrides 至少给 `id`
 * @returns {Record<string, any>}
 */
export function makePluginManifest(overrides) {
  if (overrides === null || typeof overrides !== 'object' || typeof overrides.id !== 'string' || overrides.id === '') {
    throw new TypeError('makePluginManifest: first argument must be an object with a non-empty string `id`');
  }
  return {
    name: overrides.id,
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: [],
    permissions: [],
    dependencies: {},
    ...overrides
  };
}

/**
 * 往临时目录写一个**最小可加载**的插件模块文件，返回它的路径。
 *
 * ★ 为什么写真实文件而不是 `data:` URL / 桩模块：
 *   加载器走的是真实的 `import()` 路径（ESM 解析、缓存、导入错误映射），
 *   用桩会把**被测的那段代码**（加载器）绕过去 —— 那就不是夹具能解决的问题了。
 *
 * ★ 临时目录由 `fs.mkdtempSync` 分配 ⇒ 并发用例之间不撞名。
 *   **调用方负责清理**（`cleanup()` 在返回值里）：夹具不替调用方决定生命周期，
 *   有的用例要跨多个断言复用同一个文件。
 *
 * @param {Record<string, any>} manifest 模块里导出的清单
 * @param {{ body?: string, filename?: string }} [options]
 *   `body` 是模块正文（默认导出一个空 `activate`）；`filename` 默认 `plugin.mjs`
 * @returns {{ path: string, dir: string, cleanup: () => void }}
 *
 * @example
 * const mod = writePluginModule(makePluginManifest({ id: 'plug.a' }));
 * try { await loadPlugins({ entries: [{ path: mod.path }] }); } finally { mod.cleanup(); }
 */
export function writePluginModule(manifest, options = {}) {
  const { body = 'export function activate() {}\nexport function deactivate() {}\n', filename = 'plugin.mjs' } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cordium-fixture-'));
  const file = path.join(dir, filename);
  // ★ manifest 用 JSON 字面量内联：避免夹具自己再引入一层序列化路径
  //   （要测「清单写错」的用例应该自己写文件，而不是让夹具帮忙）。
  fs.writeFileSync(file, `export const manifest = ${JSON.stringify(manifest, null, 2)};\n${body}`, 'utf8');
  return {
    path: file,
    dir,
    cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

/**
 * 造一个**校验会放过但行为可控**的插件条目（manifest + entry 成对）。
 *
 * ★ 与 `makePluginManifest` 的分工：那个只造清单；这个造「清单 + 实现」，
 *   即 `registerPlugin(manifest, entry)` 的两个参数。
 *
 * @param {Partial<Record<string, any>> & { id: string }} overrides
 * @param {{ activate?: Function, deactivate?: Function }} [entry] 不传则两个钩子都是空实现
 * @returns {{ manifest: Record<string, any>, entry: Record<string, any> }}
 */
export function makePlugin(overrides, entry = {}) {
  const manifest = makePluginManifest(overrides);
  return {
    manifest,
    entry: {
      activate: entry.activate ?? (() => {}),
      deactivate: entry.deactivate ?? (() => {})
    }
  };
}
