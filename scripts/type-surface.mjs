/**
 * @file scripts/type-surface.mjs
 * @description 生成两包的【类型面快照】—— 把 `types/*.d.mts` 归一化成可比对的形式，
 *   让「名字面没变、类型面变了」这类改动能被看见。
 *
 * ── 为什么需要这个 ──────────────────────────────────────────────────
 *   `public-surface.json` 取的是**运行时**公开面（`Object.keys` / 值种类）。
 *   它答不了「参数从可选变必需」「`readonly` 收紧」「JSDoc 写成散文导致退化成 `object`」这类问题 ——
 *   因为那些在运行时**一个字节都没变**。实测代价：一次迁移演练里 5 个编译错误全部落在这一层，
 *   而名字面报「零变化」。
 *
 * ── 判据为什么是【文本归一化】而不是 AST ────────────────────────────
 *   TypeScript 7（本仓 devDependency）**不再把 Compiler API 作为稳定导出**：
 *   `require('typescript')` 只剩 `version`，解析器被挪到 `typescript/unstable/*`
 *   且**未导出 `parseSourceFile`**。
 *   ⇒ 判据不能建在实验性 API 的内部行为上：不自建 AST 提取。
 *   ⇒ 改为**剥掉注释与空白后逐行比对**。这不是妥协 —— 它正好只保留「签名本身」：
 *     注释是文档（改它不该判 breaking），空白是格式（`tsc` 自己决定）。
 *
 * ── 与 `public-surface.json` 的关系 ─────────────────────────────────
 *   两者**并列**、互不替代：
 *   · `public-surface.json`（运行时名字 + 种类）⇒ `classifyBump` 算 semver 位
 *   · `type-surface.json`（归一化签名）⇒ 只能**发现**变化并列出 diff，不参与 bump 判定
 *   ★ 类型面**不参与** `classifyBump`：类型收紧对「按旧类型写的消费方」是破坏、
 *     对「按新类型写的」不是 —— 方向性判断没法只从 diff 得出（见 CHANGELOG 的迁移段）。
 *     所以这里只**如实呈现**，把判断留给发版的人。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node scripts/type-surface.mjs           # 校验（不等则 exit 1，并打印 diff）
 *   node scripts/type-surface.mjs --write   # 重写仓内快照（改了类型后跑一次并提交）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = ['kernel', 'plugins'];
const TYPES_DIR = pkg => path.join(ROOT, 'packages', pkg, 'types');
const SNAPSHOT = pkg => path.join(ROOT, 'packages', pkg, 'type-surface.json');

/**
 * 归一化：剥注释、去空白、统一行尾，再逐行 trim 后丢掉空行。
 *
 * ★ 顺序承重：**先剥块注释再剥行注释** —— 反过来会把 `/** … */` 里的 `*` 当行注释处理，
 *   留下半截 `/*` 残渣（实测）。
 * ★ 不剥字符串里的 `//`（URL 之类）—— 但 `.d.mts` 由 `tsc` 生成，
 *   字符串字面量只出现在类型位置（如 `'worker' | 'process'`），不含 `//`。
 */
function normalize(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释（含 JSDoc）
    .replace(/^[ \t]*\/\/.*$/gm, '')        // 整行的行注释（行尾注释在 .d.mts 里不出现）
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * 生成一个包的类型面快照。
 *
 * 形状：`{ files: { '<文件名>': ['<归一化后的一行>', …] } }`
 * ★ 用**行数组**而不是整块字符串：diff 能精确到行，门禁报错也点得出是哪一行。
 */
export function packageTypeSurface(pkg) {
  const dir = TYPES_DIR(pkg);
  if (!fs.existsSync(dir)) return { files: {} };
  const files = {};
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.d.mts')).sort()) {
    files[name] = normalize(fs.readFileSync(path.join(dir, name), 'utf8')).split('\n').filter(Boolean);
  }
  return { files };
}

/** 生成两包的类型面快照 */
export function buildTypeSurfaces() {
  return { kernel: packageTypeSurface('kernel'), plugins: packageTypeSurface('plugins') };
}

/**
 * 比较两份类型面快照，列出增 / 删 / 改。
 *
 * @param {any} oldSnap 上一版
 * @param {any} newSnap 这一版
 * @returns {{added:object[],removed:object[],changed:object[]}} 每条带 `pkg` / `file` / `line`
 */
export function diffTypeSurfaces(oldSnap, newSnap) {
  const acc = { added: [], removed: [], changed: [] };
  for (const pkg of PKGS) {
    const of = oldSnap?.[pkg]?.files ?? {};
    const nf = newSnap?.[pkg]?.files ?? {};
    for (const name of new Set([...Object.keys(of), ...Object.keys(nf)])) {
      if (!(name in of)) { acc.added.push({ pkg, file: name, line: '(整个文件新增)' }); continue; }
      if (!(name in nf)) { acc.removed.push({ pkg, file: name, line: '(整个文件被删)' }); continue; }
      const o = new Set(of[name]);
      const n = new Set(nf[name]);
      for (const line of o) if (!n.has(line)) acc.removed.push({ pkg, file: name, line });
      for (const line of n) if (!o.has(line)) acc.added.push({ pkg, file: name, line });
    }
  }
  return acc;
}

const serialize = obj => JSON.stringify(obj, null, 2) + '\n';

async function main() {
  const mode = process.argv[2];
  const fresh = buildTypeSurfaces();

  // ★ 非空自检：生成物为空时**必须**报错，不能当成「一致」（空对空 diff 会骗人）。
  const empty = PKGS.filter(p => Object.keys(fresh[p].files).length === 0);
  if (empty.length) {
    console.error(`★ 判据失效：${empty.join(', ')} 的 types/ 下没有任何 .d.mts —— 先跑 \`npm run types:emit\``);
    process.exit(1);
  }

  if (mode === '--write') {
    for (const pkg of PKGS) {
      fs.writeFileSync(SNAPSHOT(pkg), serialize(fresh[pkg]));
      console.log(`✎ 已写入 packages/${pkg}/type-surface.json`);
    }
    return;
  }

  const drifted = [];
  for (const pkg of PKGS) {
    const abs = SNAPSHOT(pkg);
    if (!fs.existsSync(abs)) { drifted.push(`packages/${pkg}/type-surface.json 不存在（跑 \`node scripts/type-surface.mjs --write\`）`); continue; }
    const cur = JSON.parse(fs.readFileSync(abs, 'utf8').split('\r\n').join('\n'));
    const d = diffTypeSurfaces({ [pkg]: cur }, { [pkg]: fresh[pkg] });
    const n = d.added.length + d.removed.length;
    if (n) {
      drifted.push(`packages/${pkg}/type-surface.json 与此刻的 types/ 不一致（${n} 行差异）`);
      for (const a of d.added.slice(0, 10)) drifted.push(`  + ${a.file}: ${a.line}`);
      for (const r of d.removed.slice(0, 10)) drifted.push(`  - ${r.file}: ${r.line}`);
      if (n > 20) drifted.push(`  …（共 ${n} 行，只列前 10 条）`);
    }
  }
  if (drifted.length) {
    console.error('✘ 类型面快照与 types/ 不一致：\n' + drifted.join('\n')
      + '\n\n★ 修法：确认改动后跑 `node scripts/type-surface.mjs --write` 并一并提交。');
    process.exit(1);
  }
  console.log('✔ 类型面快照与 types/ 一致');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
