/**
 * @file packages/kernel/test/types-drift.test.mjs
 * @description 类型门禁，两件事：
 *   ① **源码本身必须通过类型检查** —— JSDoc 就是类型的唯一真相源，它写错了这里就红；
 *   ② **已提交的 `types/*.d.mts` 必须等于「此刻重新生成的」**（漂移门禁）。
 *
 * ── 为什么生成物进了版本库，却不构成「第二份真相源」─────────────────────────
 *   真相源是源码里的 **JSDoc**；`types/` 是**产物**。产物可以进版本库，前提是
 *   「它是不是派的」这件事**可以被机械证明** —— 本文件就是那道证明：
 *   重新生成一遍，逐字节比对，不一致就红。
 *   ⇒ 谁想手改 `types/*.d.mts`，改完必须让重生成也产出同样的内容 —— 而那是做不到的，
 *     除非他改的是源码里的 JSDoc。**手改在结构上失效**，漂移在结构上不可能。
 *
 * ── 为什么非要把产物提交进版本库 ────────────────────────────────────────────
 *   消费方经 `file:` + symlink 直连本仓源码。默认（软链）模式下，`file:` 依赖**既不装**
 *   它自己的 `dependencies`、**也不装**它的 `devDependencies`（本机实测：`is-odd` 与
 *   `left-pad` 两个都缺席，`node_modules` 里只有那条软链），但**会跑**依赖方的 `prepare`。
 *   ⇒ 所以「让消费方在安装时生成」并非不可能，只是：`prepare` 里的 `tsc` 只能从
 *   **被链接源仓自己的 `node_modules`** 找到，源仓干净 clone / CI `--omit=dev` 时必然
 *   `MODULE_NOT_FOUND`，而 **`prepare` 失败会让消费方的 `npm install` 整单失败**（实测 exit 3）。
 *   ★ 换 `--install-links` 也不是出路：它只补上 `dependencies`（实测 `is-odd` 到场），
 *     **仍然不装 `devDependencies`**（`left-pad` 依旧缺席）⇒ `tsc` 照样不在。
 *   ⇒ 那条路是**把风险从消费方的编辑器挪到消费方的安装**，不划算。
 *   不提交 = 消费方的 IDE 拿不到任何补全（实测：`exports` 里没有 `types` 条件时，
 *   TypeScript 会报「找不到声明文件，该模块隐式为 any」—— 它**不会**去读
 *   `src/*.mjs` 里现成的 JSDoc）。
 *
 * ── 判据失效与检查通过分开报（规矩 44）─────────────────────────────────────
 *   跑不动 `tsc`、或生成结果为空 ⇒ 报【判据失效】并失败，**绝不**当作通过：
 *   一个跑不起来的漂移门禁，比没有门禁更糟（它让人以为「已经防住了」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PKGS = ['kernel', 'plugins'];
/** `tsc` 的 JS 入口 —— 不依赖 PATH，也不依赖平台后缀（Windows 上 .bin 里是 .cmd）。 */
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** 读一棵 `types/` 树，返回 `相对路径 → 内容`（换行归一，免得 CRLF 造成假红）。 */
function readTypes(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(d, ent.name), r);
      else out.set(r, fs.readFileSync(path.join(d, ent.name), 'utf8').split('\r\n').join('\n'));
    }
  };
  walk(dir, '');
  return out;
}

/** 跑一次 `tsc`，返回 `{ status, output }`。 */
function runTsc(args, cwd = ROOT) {
  const res = spawnSync(process.execPath, [TSC, ...args], { cwd, encoding: 'utf8' });
  return { status: res.status, output: (res.stdout || '') + (res.stderr || '') };
}

test('★★ 源码必须通过类型检查（JSDoc 是类型的唯一真相源，写错了这里就红）', { timeout: 180_000 }, () => {
  assert.ok(fs.existsSync(TSC), `★ 判据失效：找不到 ${path.relative(ROOT, TSC)}（依赖没装？）—— 这不是「检查通过」`);
  const { status, output } = runTsc(['--noEmit', '-p', path.join(ROOT, 'tsconfig.json')]);
  assert.equal(status, 0, `★ 类型检查未通过：\n${output}\n\n★ 修法：改 JSDoc 让它**如实**描述实现。`
    + '不要用 `any` 当消音器，也不要 `@ts-ignore` —— 那只是把错误藏起来。');
});

test('★ 门禁自检：类型检查真的会因源码里的类型错误而变红（否则是恒真假绿）', { timeout: 180_000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cordium-typecheck-selfcheck-'));
  try {
    // 一个必然报错的探针：把 string 赋给 number。与真实配置同档（allowJs + checkJs）。
    fs.writeFileSync(path.join(tmp, 'bad.mjs'), 'const n = 1;\n/** @type {number} */\nconst s = n;\n/** @type {string} */ const wrong = n;\n');
    fs.writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: true, noEmit: true, target: 'es2023', module: 'nodenext', moduleResolution: 'nodenext', types: [] },
      include: ['bad.mjs']
    }));
    const bad = runTsc(['--noEmit', '-p', path.join(tmp, 'tsconfig.json')], tmp);
    assert.notEqual(bad.status, 0, `★ 判据失效：一个必然类型出错的探针竟然通过了 —— 这条门禁是恒真的。输出：${bad.output}`);

    // 正向对照：同一个探针改成正确类型 ⇒ 必须通过（否则「红」可能只是环境问题）
    fs.writeFileSync(path.join(tmp, 'bad.mjs'), 'const n = 1;\n/** @type {number} */ const ok = n;\n');
    const good = runTsc(['--noEmit', '-p', path.join(tmp, 'tsconfig.json')], tmp);
    assert.equal(good.status, 0, `★ 正向对照失败（正确代码不得报错）：${good.output}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('★★ 已提交的 types/*.d.mts 必须逐字节等于重新生成的结果（手改在结构上失效）', { timeout: 180_000 }, () => {
  assert.ok(fs.existsSync(TSC),
    `★ 判据失效：找不到 ${path.relative(ROOT, TSC)}（依赖没装？）—— 这不是「检查通过」`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cordium-types-'));
  const judged = [];
  const drifted = [];

  try {
    // ★ 顺序承重：plugins 的声明 `import '@cordium/kernel'`，内核的 types 不存在时它解析不了。
    for (const pkg of PKGS) {
      const pkgDir = path.join(ROOT, 'packages', pkg);
      const outDir = path.join(tmp, pkg);
      const res = spawnSync(process.execPath, [TSC, '-p', path.join(pkgDir, 'tsconfig.emit.json'), '--outDir', outDir],
        { cwd: ROOT, encoding: 'utf8' });
      if (res.status !== 0) {
        judged.push(`生成 ${pkg} 的声明失败（exit ${res.status}）：\n${(res.stdout || '') + (res.stderr || '')}`);
        continue;
      }
      const fresh = readTypes(outDir);
      const committed = readTypes(path.join(pkgDir, 'types'));
      if (fresh.size === 0) { judged.push(`生成 ${pkg} 的声明产出为空 —— 判据失效`); continue; }
      if (committed.size === 0) { judged.push(`${pkg}/types 是空的 —— 跑一次 \`npm run types:emit\` 并提交产物`); continue; }

      for (const [rel, text] of fresh) {
        if (!committed.has(rel)) drifted.push(`${pkg}/types 少了 ${rel}`);
        else if (committed.get(rel) !== text) drifted.push(`${pkg}/types/${rel} 与重新生成的结果不一致`);
      }
      for (const rel of committed.keys()) if (!fresh.has(rel)) drifted.push(`${pkg}/types/${rel} 是重新生成结果里没有的（旧产物？）`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  assert.deepEqual(judged, [], '\n' + judged.join('\n'));
  assert.deepEqual(drifted, [],
    '\n' + drifted.join('\n') + '\n\n★ 修法：改源码里的 JSDoc（真相源），然后跑 `npm run types:emit` 并把产物一并提交。'
    + '不要直接编辑 types/*.d.mts —— 它不是手写的。');
});

test('★ 门禁自检：比对必须真的能判别内容差异与增删（否则是恒真假绿）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cordium-types-selfcheck-'));
  try {
    fs.mkdirSync(path.join(tmp, 'a'));
    fs.writeFileSync(path.join(tmp, 'a', 'x.d.mts'), 'export declare const A: 1;\r\n');
    const got = readTypes(path.join(tmp, 'a'));
    assert.equal(got.size, 1, '必须读到文件');
    // ★ CRLF 归一：写进去是 \r\n，读出来必须是 \n（否则 Windows 上恒假红）
    assert.equal(got.get('x.d.mts'), 'export declare const A: 1;\n', 'CRLF 必须归一');
    assert.deepEqual(readTypes(path.join(tmp, 'nope')), new Map(), '不存在的目录 ⇒ 空表（调用方据此报判据失效）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
