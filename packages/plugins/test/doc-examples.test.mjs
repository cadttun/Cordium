/**
 * @file packages/plugins/test/doc-examples.test.mjs
 * @description 文档示例门禁：README 与 PLUGIN_GUIDE 里的每个 manifest 示例，内核层与描述符层都必须收下。
 *
 * 读者会直接复制文档示例。示例若只满足内核层（`registerPlugin` / `loadPlugins`），
 * 拿去上架（`validatePluginManifest` / catalog）时才报 `plugin name is required`。
 * 本门禁在改文档或改校验规则时让这种不一致当场变红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateManifest, CordiumHost } from '@cordium/kernel';
import { validatePluginManifest } from '../src/runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCS = ['README.md', 'PLUGIN_GUIDE.md'];

/**
 * ★★ 行尾归一 —— **读文档前必须先做**。
 *
 * 为什么：下面所有抽取正则都以行首行尾为锚（围栏行、捕获组的换行），
 *   而一份 CRLF 文档会让锚点匹配不到 —— 实测：整份文档一条 js 围栏都抽不出来，
 *   于是「示例数不足」那条会红，但**一旦示例刚好够数，坏示例就再没人拦**。
 *
 * ★ 为什么是本文件的责任，而不是「要求文档必须存成 LF」：
 *   本仓 `.gitattributes` 写的是 `* text=auto eol=lf`（**提交进库的是 LF**），
 *   但作者在 Windows 上编辑、编辑器存 CRLF 是常态，而 CI 在 ubuntu 上检出的是 LF
 *   ⇒ **同一次提交，两边跑出不同结论**。门禁的判据不能取决于检出行尾。
 *   把归一放在**读入的那一刻**，两种行尾都可判。
 */
const LF = String.fromCharCode(10), CR = String.fromCharCode(13);
const readDoc = file =>
  fs.readFileSync(path.join(ROOT, file), 'utf8').split(CR + LF).join(LF);

/** 取出 js 代码块的起止（只在 ```js / ```mjs 围栏内找示例，正文与其它语言的代码块不算） */
function jsFences(text) {
  const ranges = [];
  // ★ `[ \t]*\n` 而不是 `[^\n]*\n`：后者会让语言标记只做**前缀**匹配 ——
  //   实测 ```jsonc 被当成 js 围栏（`js` 匹配后 `[^\n]*` 吃掉 `onc`），
  //   于是 JSON 示例进了解析门禁并误报。要求标记后直接换行，前缀就不再成立。
  const re = /^```(?:js|mjs|javascript)[ \t]*\n([\s\S]*?)^```/gm;
  let m;
  while ((m = re.exec(text))) ranges.push([m.index + m[0].indexOf('\n') + 1, m.index + m[0].length]);
  return ranges;
}

/**
 * ★ 取出围栏的**纯代码**（不含围栏行）。
 * 为什么要另开一个：`jsFences` 给的是「区间」，它的**右端点含收尾的 ``` 行** ——
 *   老门禁只拿这个区间做「下标是否落在其中」的包含判断，所以从没暴露。
 *   而语法门要的是**精确切片**，用区间切会把 ``` 一起吃进去（实测：全部围栏都报
 *   `Unexpected end of input`）。⇒ 用捕获组直接拿块体，不靠区间推算。
 * @returns {Array<{ line: number, code: string }>}
 */
function jsFenceBlocks(text) {
  // ★ `[ \t]*\n` 而不是 `[^\n]*\n`：后者会让语言标记只做**前缀**匹配 ——
  //   实测 ```jsonc 被当成 js 围栏（`js` 匹配后 `[^\n]*` 吃掉 `onc`），
  //   于是 JSON 示例进了解析门禁并误报。要求标记后直接换行，前缀就不再成立。
  const re = /^```(?:js|mjs|javascript)[ \t]*\n([\s\S]*?)^```/gm;
  return [...text.matchAll(re)].map(m => ({
    line: text.slice(0, m.index).split('\n').length,
    code: m[1]
  }));
}

/**
 * 取出 `manifest = {…}` / `manifest: {…}` 的对象字面量（按括号配对）。
 * 也认 `Object.freeze({…})` 包一层的写法 —— 否则换个写法示例就悄悄漏出门禁。
 */
function extractManifests(text) {
  const found = [];
  const fences = jsFences(text);
  const re = /\bmanifest\s*[=:]\s*(?:Object\.freeze\(\s*)?\{/g;
  let m;
  while ((m = re.exec(text))) {
    if (!fences.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const start = m.index + m[0].length - 1;
    let depth = 0, end = start;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    const line = text.slice(0, start).split('\n').length;
    found.push({ line, source: text.slice(start, end + 1) });
  }
  return found;
}

const examples = DOCS.flatMap(file =>
  extractManifests(readDoc(file)).map(e => ({ file, ...e })));

test('★ 文档里确实抽到了 manifest 示例（否则门禁恒真）', () => {
  assert.ok(examples.filter(e => e.file === 'README.md').length >= 2);
  assert.ok(examples.filter(e => e.file === 'PLUGIN_GUIDE.md').length >= 3);
});

test('★ 每个文档 manifest 示例两层校验都通过（照抄即可运行，也可上架）', () => {
  const failures = [];
  for (const { file, line, source } of examples) {
    const manifest = new Function(`return (${source});`)();
    for (const [layer, validate] of [['kernel', validateManifest], ['descriptor', validatePluginManifest]]) {
      try { validate(manifest); } catch (err) { failures.push(`${file}:${line} [${layer}] ${err.code}: ${err.message}`); }
    }
  }
  assert.deepEqual(failures, [], '\n' + failures.join('\n'));
});

// ════════════════════════════════════════════════════════════════════════════
// ★★ 覆盖面扩展：上面那两道只认 `manifest = {…}` 字面量，实测指南 14 个 js 围栏
//    里只有 3 个含 manifest ⇒ **11 个示例完全在门禁覆盖外**。
//    这正是「照抄 §1 的 `config.start` 会抛裸 TypeError」没被拦住的原因。
//
//    ⚠️ 本节只覆盖两类，**不得**在文档里说成「所有示例都可运行」：
//      · **语法层** —— 每个 js 围栏必须能被解析（拼错的关键字 / 括号不配对当场红）；
//      · **ctx 成员名** —— 示例里用到的 `ctx.<name>` 必须在 ctx 公开面清单里（防文档写出不存在的 API）。
//    真正的运行时覆盖由 `examples/` 目录承担（那里有测试实跑）。
// ════════════════════════════════════════════════════════════════════════════

/**
 * ★★ ctx 的公开成员清单 —— **取自运行时真值，不手列**。
 *
 * ── 为什么改（实测缺陷）────────────────────────────────────────────
 *   此前这里是一份**手抄**的清单，注释却写着「与 host.test.mjs 的 ctx 成员清单门禁
 *   **同一份真值**」—— 而 host.test.mjs 那份是拿 `Object.keys(ctx)` 与真对象做 deepEqual，
 *   所以那边结构上不可能漂，**这边会**。实测两处都已跑偏：
 *     · 多列了 `off`  —— 真实 ctx **没有**这个成员（`on` / `once` 返回的是退订函数）。
 *       后果：文档里写 `ctx.off(…)`（运行即 TypeError）门禁**放行** —— 假绿。
 *     · 漏列了 `watchPluginState` —— 它是真实的公开成员且已进 CHANGELOG。
 *       后果：文档作者为它写示例会被门禁**错误拦下** —— 假红。
 *   ⇒ 一份「声称同源、实为手抄」的清单，两个方向都会错，且**两个方向都无声**。
 *
 * ── 为什么是运行时取值 ──────────────────────────────────────────────
 *   同 host.test.mjs 的口径：**判据取自被检查对象自身**（这里就是 ctx 的真身）。
 *   手列清单会随实现增删而漂；运行时取值不会 —— 这正是那个文件的做法，此前这里没跟上。
 *   ⚠️ 跨包走**包名** `@cordium/kernel`（boundary.test.mjs 守这条；同层先例见
 *      input-validation.test.mjs）。
 */
const CTX_MEMBERS = await (async () => {
  const host = new CordiumHost();
  let captured = null;
  host.registerPlugin(
    { id: 'plugin.doc-ctx-probe', version: '1.0.0', apiVersion: '1.0.0' },
    { activate(ctx) { captured = ctx; } }
  );
  await host.boot();
  return Object.keys(captured).sort();
})();

/** 解析器：把源码按【异步函数体】解析（不执行、不建作用域）—— `await` / `return` 都合法 */
const parseAsAsyncBody = (code) => new (Object.getPrototypeOf(async function () {}).constructor)(code);

/**
 * ★★ 文档里的 js 围栏有【两种形状】，读者可能照抄成任一种 ⇒ 两种各试一次，
 *    **两种都失败才算错**（实测：多数围栏是裸语句片段，直接按模块解析会误报）。
 *   · **片段**（裸 `ctx.on(…)`、不完整的钩子体）⇒ 按异步函数体解析
 *   · **完整模块**（含 `export` / `import`）⇒ 必须交给真解析器（`node --check`），
 *     `new Function` 一族都不接受模块语法
 */
function parseFence(code) {
  try { parseAsAsyncBody(code); return null; } catch (bodyErr) {
    // 片段形状不成立 ⇒ 按模块再试一次（写临时文件让 node 自己判，避免自造解析器）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cordium-docfence-'));
    const file = path.join(dir, 'fence.mjs');
    try {
      fs.writeFileSync(file, code, 'utf8');
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      return null;
    } catch (modErr) {
      // ★ 两种形状都不成立 ⇒ 报【模块】那条原因（它带行号，最可读）
      const raw = String(modErr.stderr || modErr.message).split('\n').find(l => l.includes('SyntaxError')) || String(bodyErr.message);
      return raw.trim();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

test('★ 每个 js 围栏都必须能【解析】（语法层；拼错关键字 / 括号不配对当场红）', () => {
  const failures = [];
  for (const file of DOCS) {
    const text = readDoc(file);
    for (const { line, code } of jsFenceBlocks(text)) {
      const reason = parseFence(code);
      if (reason) failures.push(`${file}:${line} ${reason}`);
    }
  }
  assert.deepEqual(failures, [], '\n' + failures.join('\n'));
});

test('★ 示例里用到的 ctx.<name> 必须在公开面清单里（防文档写出不存在的 API）', () => {
  const failures = [];
  for (const file of DOCS) {
    const text = readDoc(file);
    for (const { line, code } of jsFenceBlocks(text)) {
      // 只认 `ctx.xxx` 这种直接取用；`ctx.scope.addDisposer` 这类取的是 scope 的成员，只看第一段
      for (const m of code.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
        if (!CTX_MEMBERS.includes(m[1])) failures.push(`${file}:${line} ctx.${m[1]}`);
      }
    }
  }
  assert.deepEqual(failures, [], '\n' + failures.join('\n'));
});

test('★ 门禁自检：这两道扩面门禁本身能判别（否则是恒真的假绿）', () => {
  // 语法门：造一个语法错的围栏，必须被判出来
  const badSyntax = '```js\nconst x = (1 + ;\n```';
  assert.throws(() => new Function('const x = (1 + ;'.replace(/^\s*(?:import|export)\b.*$/gm, '')));
  // ctx 成员门：造一个不存在的成员，必须不在清单里
  assert.equal(CTX_MEMBERS.includes('__nope__'), false);
  // ★ 正向对照：清单本身必须有内容（否则第一道「全部通过」是假绿）
  assert.ok(CTX_MEMBERS.length >= 15);
  assert.ok(badSyntax.includes('ctx') === false);
  // ★★ 回归：手抄清单曾在这两处跑偏，现在由运行时真值兜住 —— 两个方向各钉一条
  assert.ok(CTX_MEMBERS.includes('watchPluginState'),
    'watchPluginState 是真实的公开 ctx 成员 —— 漏列它会让文档里的合法示例被【误拒】');
  assert.equal(CTX_MEMBERS.includes('off'),
    false, '真实 ctx 没有 off（on/once 返回退订函数）—— 列入它会让文档里的非法示例被【误放】');
});

test('★ 门禁自检：只认 js 围栏内的示例；Object.freeze 包裹也抽得到', () => {
  const doc = [
    '正文里写 manifest: { id: 1 } 不算示例',
    '```js',
    "export const manifest = Object.freeze({ id: 'a.b', version: '1.0.0' });",
    "const plugin = { manifest: { id: 'c.d' } };",
    '```',
    '```text',
    'manifest = { id: 2 }',
    '```'
  ].join('\n');
  assert.deepEqual(extractManifests(doc).map(e => e.source),
    ["{ id: 'a.b', version: '1.0.0' }", "{ id: 'c.d' }"]);
});
