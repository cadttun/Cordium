/**
 * @file packages/kernel/test/type-surface.test.mjs
 * @description 类型面快照门禁：仓内的 `type-surface.json` 必须逐行等于【此刻 `types/*.d.mts` 归一化后】的结果。
 *
 * ── 它守的是什么 ────────────────────────────────────────────────────
 *   `public-surface.json` 只看**运行时**（名字 + 种类）。类型面的破坏在运行时一个字节都不变 ——
 *   实测代价：一次迁移演练的 5 个编译错误**全部**落在这一层，而名字面报「零变化」。
 *   ⇒ 本文件把「类型签名」也纳入版本库比对，让那类改动**必须显式提交**（而不是悄悄溜过去）。
 *
 * ── 它**不**做什么 ──────────────────────────────────────────────────
 *   ★ 不参与 `classifyBump`。类型收紧对「按旧类型写的消费方」是破坏、对「按新类型写的」不是 ——
 *     方向性判断没法只从 diff 得出。这里只**如实呈现**，把判断留给发版的人。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTypeSurfaces, diffTypeSurfaces } from '../../../scripts/type-surface.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FILES = { kernel: 'packages/kernel/type-surface.json', plugins: 'packages/plugins/type-surface.json' };
const PKGS = ['kernel', 'plugins'];

test('★★ 类型面快照必须与此刻的 types/*.d.mts 一致（跨版本 diff 的 baseline）', () => {
  const fresh = buildTypeSurfaces();
  const judged = [];
  const drifted = [];

  for (const pkg of PKGS) {
    const abs = path.join(ROOT, FILES[pkg]);
    if (!fs.existsSync(abs)) { drifted.push(`${FILES[pkg]} 不存在 —— 跑 \`node scripts/type-surface.mjs --write\``); continue; }
    const cur = JSON.parse(fs.readFileSync(abs, 'utf8').split('\r\n').join('\n'));
    // ★ 判据失效 ≠ 检查通过
    if (!fresh[pkg] || Object.keys(fresh[pkg].files).length === 0) { judged.push(`${pkg}: types/ 里没有 .d.mts（先跑 types:emit）`); continue; }
    if (!cur.files || Object.keys(cur.files).length === 0) { judged.push(`${pkg}: 仓内快照是空的 —— 判据失效`); continue; }

    const d = diffTypeSurfaces({ [pkg]: cur }, { [pkg]: fresh[pkg] });
    const n = d.added.length + d.removed.length;
    if (n) {
      drifted.push(`${FILES[pkg]} 与此刻的 types/ 不一致（${n} 行）`);
      for (const a of d.added.slice(0, 5)) drifted.push(`  + ${a.file}: ${a.line.slice(0, 160)}`);
      for (const r of d.removed.slice(0, 5)) drifted.push(`  - ${r.file}: ${r.line.slice(0, 160)}`);
    }
  }
  assert.deepEqual(judged, [], '\n' + judged.join('\n'));
  assert.deepEqual(drifted, [], '\n' + drifted.join('\n')
    + '\n\n★ 修法：确认改动后跑 `node scripts/type-surface.mjs --write` 并把快照一并提交。');
});

test('★ 快照必须真的抓到了类型（非空扫描，否则门禁是空转）', () => {
  const { kernel, plugins } = buildTypeSurfaces();
  assert.ok(kernel.files['host.d.mts'], 'kernel 快照必须含 host.d.mts');
  assert.ok(kernel.files['host.d.mts'].some(l => l.includes('PluginContext')), 'host.d.mts 里必须能看到 PluginContext');
  assert.ok(plugins.files['isolation.d.mts'], 'plugins 快照必须含 isolation.d.mts');
  assert.ok(plugins.files['isolation.d.mts'].some(l => l.includes('callIsolated')), 'isolation.d.mts 里必须能看到 callIsolated');
  // 归一化必须**剥掉注释**：JSDoc 里的 `@param` 不得出现在快照里
  const jsdocLeak = [];
  for (const pkg of PKGS) for (const [name, lines] of Object.entries(kernel.files)) {
    for (const l of lines) if (l.startsWith('*') || l.startsWith('/*')) jsdocLeak.push(`${pkg}/${name}: ${l.slice(0, 80)}`);
  }
  assert.deepEqual(jsdocLeak, [], '\n归一化没剥净注释：\n' + jsdocLeak.join('\n'));
});

test('★★ 判别力自检：三种真实破坏都必须被判出来（否则门禁是恒绿）', () => {
  const mk = (lines) => ({ kernel: { files: { 'x.d.mts': lines } }, plugins: { files: {} } });

  // ① 参数收紧：`details?: unknown` → `details: unknown`（可选项变必需）
  const loose = mk(['export declare function f(a: string, details?: unknown): void;']);
  const strict = mk(['export declare function f(a: string, details: unknown): void;']);
  assert.equal(diffTypeSurfaces(loose, strict).added.length + diffTypeSurfaces(loose, strict).removed.length, 2,
    '可选→必需必须被判出来');

  // ② 类型退化：`options?: IsolationOptions` → `options?: object`
  //    这正是本仓实际踩到的那一个（JSDoc 写「同 startIsolated」导致 tsc 推成裸 object）
  const good = mk(['export declare function f(o?: IsolationOptions): void;']);
  const degraded = mk(['export declare function f(o?: object): void;']);
  const d2 = diffTypeSurfaces(good, degraded);
  assert.ok(d2.added.length === 1 && d2.removed.length === 1, '类型退化必须被判出来');

  // ③ 删整个声明文件
  const full = { kernel: { files: { 'a.d.mts': ['x'], 'b.d.mts': ['y'] } }, plugins: { files: {} } };
  const missing = { kernel: { files: { 'a.d.mts': ['x'] } }, plugins: { files: {} } };
  assert.equal(diffTypeSurfaces(full, missing).removed.length, 1, '删文件必须被判出来');

  // ④ 纯注释变化**不得**被判出来（否则门禁会被噪音淹没，最后没人看）
  //    归一化后两者逐行相同 ⇒ 无差异
  const withDoc = mk(['export declare function f(): void;']);
  const withoutDoc = mk(['export declare function f(): void;']);
  assert.equal(diffTypeSurfaces(withDoc, withoutDoc).added.length, 0, '同签名不得报差异');
});
