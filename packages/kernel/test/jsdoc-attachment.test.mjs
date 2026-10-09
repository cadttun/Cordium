/**
 * @file packages/kernel/test/jsdoc-attachment.test.mjs
 * @description 门禁：两包 `src` 里**没有「孤儿 JSDoc」** —— 一段 JSDoc 与它以为的声明之间**夹了别的东西**
 *   （另一个 JSDoc 块 / 一条 `export { … } from` 再导出语句），tsc 取「紧邻声明的最后一段」
 *   ⇒ 该声明**拿不到任何 JSDoc** ⇒ **参数推成隐式 `any`、返回类型退化**。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 *   本仓**三轮共抓到 11 处**，**全部零报错、零既有门禁**：
 *     · `activatePlugin`（文档被孤儿化 ⇒ `.d.mts` 参数一直是 `any`）
 *     · `#watchServiceForPlugin` / `#activateReadyDependencies`（同轮）
 *     · `normalizeDependencyMap`（JSDoc 与函数间夹了 `setOwn` 的 JSDoc ⇒ 返回退化成 `{}`）
 *     · `configureIsolation`（JSDoc 紧跟的是 `export { IsolationCode } from …` ⇒ 参数 `any` + 返回被钉成字面量）
 *     · **第三形态（6 处）**：`host.mjs` 构造函数里对 `this.#plugins / #serviceContracts /
 *       #channel / #auditLogs / #errorLogs / #manifestDiagnostics` 的 `@type` —— 挂在了
 *       **不产生类型的位置**（一条 `this.#x = …` 表达式语句）上 ⇒ 字段类型仍取自【类字段声明】，
 *       这些 `@type` 全是**空操作** ⇒ `getDiagnostics()` 的**稳定面**（`plugins[].state /
 *       services[].access / …`）静默退化成 `any`。
 *   这类缺陷**只在 `.d.mts` 里静默改变公开面类型**，`types-drift`（产物 == 重生成）也拦不住 ——
 *   因为「重生成」出来的就是那份**错的**产物。
 *
 * ── 判据（三条，皆从「tsc 怎么挂 JSDoc」倒推）────────────────────────────────
 *   ① **堆叠**：JSDoc 之后（跳过空行与 `//` 注释）紧跟**另一个 `/**`** ⇒ 前者被后者顶掉。
 *   ② **非声明**：JSDoc 之后是 `export { … }` / `export * …` / `import …`（**语句，不是声明**）
 *      ⇒ 文档挂到一条不产生符号的语句上。中间夹 `//` 注释要一并跳过（tsc 能穿过它）。
 *   ③ **空操作落点**：**含 `@type` 的** JSDoc 之后紧跟一条 `this.` 表达式语句（构造函数里的
 *      `this.#x = …`）⇒ `@type` 挂到无类型的语句上，字段类型仍取自类字段声明 ⇒ 断言静默失效。
 *      ★ 只认 `this.`：`@type` 落在**声明**（`const` / `let` / 字段声明）上是**有效的**，
 *        落在**类型转换**（`/** @type {T} *​/ (expr)`）上也是有效的 —— 二者都不报，避免假阳。
 *
 * ── 两条豁免（否则会假阳）──────────────────────────────────────────────────
 *   · **文件级文档**（`@file` / `@description` / `@module` / `@overview`）—— 本就不挂声明。
 *   · **`@typedef` / `@callback`** —— **自足**：tsc 从 JSDoc 直接建类型别名，与后续是什么无关
 *     （已由 `typedef-drift.test.mjs` 反证：`PluginContext` / `PluginManifest` 紧跟着另一个 JSDoc，仍被正确注册）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const FILE_DOC = /@file\b|@description\b|@module\b|@overview\b/;
const SELF_CONTAINED = /@typedef\b|@callback\b/;
const NON_DECL = /^(export\s+(\*|\{)|import\b)/;
const HAS_TYPE = /@type\b/;
const THIS_STMT = /^this\./;

/** 两包 `src` 下的全部 `.mjs`（相对仓库根）。 */
function srcFiles() {
  const out = [];
  for (const pkg of ['kernel', 'plugins']) {
    const dir = path.join(ROOT, 'packages', pkg, 'src');
    for (const n of fs.readdirSync(dir)) if (n.endsWith('.mjs')) out.push(`packages/${pkg}/src/${n}`);
  }
  return out;
}

/**
 * 找出源码里的孤儿 JSDoc。
 * ★ 归一换行放在**读入那一刻**（抽取正则锚定行首，CRLF 会让它整条失效）。
 * @returns {Array<{ line: number, kind: string, next: string }>}
 */
export function findOrphans(source) {
  const lines = source.split('\r\n').join('\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('/**')) continue;
    let j = i;
    while (j < lines.length && !lines[j].includes('*/')) j++;
    if (j >= lines.length) break;                     // 未闭合：交给别的检查，这里不猜
    const block = lines.slice(i, j + 1).join('\n');
    if (FILE_DOC.test(block) || SELF_CONTAINED.test(block)) { i = j; continue; }
    let k = j + 1;
    while (k < lines.length && (lines[k].trim() === '' || lines[k].trim().startsWith('//'))) k++;
    if (k < lines.length) {
      const next = lines[k].trim();
      if (next.startsWith('/**')) out.push({ line: i + 1, kind: '堆叠（后跟另一个 JSDoc）', next });
      else if (NON_DECL.test(next)) out.push({ line: i + 1, kind: '非声明（后跟 import/再导出语句）', next });
      else if (HAS_TYPE.test(block) && THIS_STMT.test(next)) out.push({ line: i + 1, kind: '空操作落点（含 @type 的 JSDoc 后跟 this. 语句）', next });
    }
    i = j;
  }
  return out;
}

test('★ 两包 src 里不得有「孤儿 JSDoc」（JSDoc 与它的声明之间夹了别的东西）', () => {
  const bad = [];
  for (const file of srcFiles()) {
    for (const o of findOrphans(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      bad.push(`${file}:${o.line} —— ${o.kind}：${o.next.slice(0, 60)}`);
    }
  }
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
});

test('★ 门禁自检：抽取器必须判得出三种孤儿形态，且不误伤合法写法（否则是恒真假绿）', () => {
  // ① 堆叠：JSDoc 后紧跟另一个 JSDoc ⇒ 前者被顶掉
  assert.equal(findOrphans(['/** 说明 A */', '/** 说明 B */', 'function f() {}'].join('\n')).length, 1);
  // ② 非声明：JSDoc 后是再导出语句（中间夹 `//` 注释也要跳过）
  assert.equal(findOrphans(['/** 说明 */', '// 一段注释', "export { X } from './x.mjs';", 'export function g() {}'].join('\n')).length, 1);
  // ③ 非声明：JSDoc 后是 import
  assert.equal(findOrphans(['/** 说明 */', "import x from './x.mjs';"].join('\n')).length, 1);

  // ④ 负向：正常的「JSDoc + 声明」不得报
  assert.deepEqual(findOrphans(['/** 说明 */', 'export function f() {}'].join('\n')), []);
  // ⑤ 负向：声明前夹 `//` 注释 —— tsc 能穿过，不得报（configureIsolation 的对照组）
  assert.deepEqual(findOrphans(['/** 说明 */', '// 注释', 'function f() {}'].join('\n')), []);
  // ⑥ 负向：文件级文档自足，后跟另一个 JSDoc 不得报
  assert.deepEqual(findOrphans(['/** @file x.mjs */', '/** 说明 */', 'function f() {}'].join('\n')), []);
  // ⑦ 负向：`@typedef` 自足，后跟另一个 JSDoc 不得报（真实源码里就有这形态）
  assert.deepEqual(findOrphans([
    '/**', ' * @typedef {object} T', ' * @property {string} a', ' */',
    '/** 说明 */', 'function f() {}'
  ].join('\n')), []);
  // ⑧ 空操作落点：含 `@type` 的 JSDoc 后跟 `this.#x = …` ⇒ 类型挂不上（构造函数里的 @type 是空操作）
  assert.equal(findOrphans(['/** @type {Map<string, number>} */', 'this.#x = new Map();'].join('\n')).length, 1);
  // ⑨ 负向：同样后跟 `this.`，但 JSDoc 无 `@type`（纯描述）⇒ 不得报
  assert.deepEqual(findOrphans(['/** 只是描述，不设类型 */', 'this.#x = new Map();'].join('\n')), []);
  // ⑩ 负向：含 `@type` 但后跟的是【声明】⇒ `@type` 有效，不得报（对照组：区分「有效落点」与「空操作」）
  assert.deepEqual(findOrphans(['/** @type {Map<string, number>} */', 'const m = new Map();'].join('\n')), []);
});
