/**
 * @file packages/kernel/test/typedef-drift.test.mjs
 * @description 类型层字段表门禁：源码里每个「手抄的 `@typedef` 字段清单」都必须与
 *   **运行时的唯一真相源**同集。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 *   引入类型检查后，`PluginManifest` / `PluginDescriptor` / `PluginContext` / `HostEvents`
 *   这几个 `@typedef` 各写了一份**字段清单**。它们本身没错，但它们是**投影**，不是源头：
 *     · `PluginManifest`   ← `MANIFEST_FIELD_TABLE.kernel`
 *     · `PluginDescriptor` ← `MANIFEST_FIELD_TABLE.plugin`
 *     · `PluginContext`    ← 运行时 `#buildPluginCtx` 返回对象的键
 *     · `HostEvents`       ← 运行时 `host.events` 的键
 *   本仓已经因为「同一份知识两处各写一份」栽过两次（ctx 成员清单、诊断字段表），
 *   两个方向都会错且都**无声**：多列 ⇒ 假绿放行坏示例；漏列 ⇒ 假红误拒好示例。
 *   而 `@typedef` 尤其危险 —— 它只活在注释里，**没有任何运行时消费者**，
 *   所以漂了之后连一次报错都不会有，只会让下游 IDE 给出错误补全。
 *
 * ── 判据方向 ────────────────────────────────────────────────────────────────
 *   真相源是**运行时取值**（表 / 对象键），`@typedef` 是**被测对象**。
 *   反过来拿 typedef 当判据就是循环论证（判据取自被检查对象自身）。
 *
 * ── 为什么放在 kernel 侧却读 plugins 的源码 ──────────────────────────────────
 *   三张表的源头 `MANIFEST_FIELD_TABLE` 都在内核，门禁跟着源头走；
 *   跨包**读文件**不违反「跨包引用只走包名」那条硬边界（它管的是 import 说明符），
 *   `boundary.test.mjs` 的夹具镜像门禁已有同样的先例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CordiumHost } from '../src/index.mjs';
// ★ `MANIFEST_FIELD_TABLE` **不在**主入口（它是内部工具，`public-surface.test.mjs` 专门守这条），
//   本包测试走相对路径取 —— 与 host.test.mjs 同款。
import { MANIFEST_FIELD_TABLE } from '../src/types.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 读源码并归一换行（抽取正则锚定行首，CRLF 会让它整条失效）。 */
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');

/**
 * 抽某个 `@typedef {object} X` 的 `@property` 字段名。
 *
 * ★ 类型部分可能含**嵌套花括号**（如 `{(change: { id: string }) => void}`），
 *   所以必须做括号配平 —— 用 `\{[^}]*\}` 会在第一个 `}` 处截断，字段名整个抽错。
 * ★ 抽取到第一个非 `@property` 的行即停（typedef 块到此为止）。
 *
 * @returns {string[]} 按出现顺序；找不到该 typedef、或一条 `@property` 都没抽到 ⇒ `[]`
 */
function typedefFields(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.includes(`@typedef {object} ${name}`));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const head = /^\s*\*\s*@property\s/.exec(lines[i]);
    if (!head) break;
    const rest = lines[i].slice(head[0].length);
    if (!rest.startsWith('{')) break;
    let depth = 0;
    let j = 0;
    for (; j < rest.length; j++) {
      if (rest[j] === '{') depth++;
      else if (rest[j] === '}' && --depth === 0) { j++; break; }
    }
    // 花括号之后是字段名；再往后是可选描述，用空白 / 反引号切断
    const field = rest.slice(j).trim().split(/[\s`]/)[0];
    if (/^[A-Za-z_$][\w$]*$/.test(field)) out.push(field);
  }
  return out;
}

/** 造一个有插件在跑的宿主，用来取真实的 ctx 键。 */
async function liveCtx() {
  const host = new CordiumHost();
  let ctx = null;
  host.registerPlugin({ id: 'plugin.typedef', version: '1.0.0', apiVersion: '1.0.0' }, { activate(c) { ctx = c; } });
  await host.boot();
  return ctx;
}

/** 两包 `src` 下的全部 `.mjs`（相对仓库根的路径）。 */
function srcFiles() {
  const out = [];
  for (const pkg of ['kernel', 'plugins']) {
    const dir = path.join(ROOT, 'packages', pkg, 'src');
    for (const n of fs.readdirSync(dir)) if (n.endsWith('.mjs')) out.push(`packages/${pkg}/src/${n}`);
  }
  return out;
}

/**
 * 源码里**全部** `@typedef {object} X` 的声明点。
 * ★ 用**发现**而不是手列清单：手列的话，下一个新增的 typedef 会**静默漏网** ——
 *   本仓已因「白名单重建、漏列即静默丢弃」踩过三次。这里反过来：发现到什么，就必须交代什么。
 * @returns {Map<string, string>} typedef 名 → 相对路径
 */
function allTypedefs() {
  const out = new Map();
  for (const file of srcFiles()) {
    for (const m of read(file).matchAll(/@typedef \{object\} ([A-Za-z_$][\w$]*)/g)) {
      if (!out.has(m[1])) out.set(m[1], file);
    }
  }
  return out;
}

/**
 * 被比对的 typedef 及其**唯一真相源**。
 * ★ 抽成函数而不是写在测试里：下面的覆盖门禁要用**同一份**清单 ——
 *   两处各列一遍，就又造出一份会漂的手抄清单（那正是本文件要防的东西）。
 */
async function typedefCases() {
  const ctx = await liveCtx();
  // ★ 装配层入口在构造时就绪（不依赖插件），直接取一个空宿主的即可。
  const host = new CordiumHost();
  return [
    { what: 'PluginManifest', file: 'packages/kernel/src/types.mjs',
      truth: MANIFEST_FIELD_TABLE.kernel, from: 'MANIFEST_FIELD_TABLE.kernel' },
    { what: 'PluginDescriptor', file: 'packages/plugins/src/runtime.mjs',
      truth: MANIFEST_FIELD_TABLE.plugin, from: 'MANIFEST_FIELD_TABLE.plugin' },
    { what: 'PluginContext', file: 'packages/kernel/src/host.mjs',
      truth: Object.keys(ctx), from: '运行时 ctx 的键' },
    { what: 'HostEvents', file: 'packages/kernel/src/host.mjs',
      truth: Object.keys(host.events), from: '运行时 host.events 的键' },
  ];
}

/**
 * ★ 显式豁免：这些 typedef 描述的形状**没有既有的唯一真相源**（协议报文 / 回调袋 / 查询接口），
 *   不存在「与谁比对」的问题。豁免必须**显式**并写明理由 ——
 *   否则「没被覆盖」与「有意不覆盖」在结果里长得一模一样。
 */
const NO_TRUTH_SOURCE = new Map([
  ['ActionRegistryQueries', '宿主内部查询接口，形状没有外部真相源'],
  ['UIRegistryQueries', '同上'],
  ['ScopeReleaseCallbacks', '宿主内部回调袋，形状没有外部真相源'],
  ['IsolationRequest', '隔离端 IPC 报文协议；形状未校验，源码里已注明'],
]);

test('★★ 手抄的类型字段表都必须与运行时唯一真相源同集', async () => {
  const cases = await typedefCases();

  const judged = [];   // ★ 判据失效 ≠ 检查通过
  const drifted = [];
  for (const { what, file, truth, from } of cases) {
    const got = typedefFields(read(file), what);
    if (got.length === 0) {
      judged.push(`${file} 里抽不到 \`@typedef {object} ${what}\` 的 @property —— 判据失效（改名了？换了写法？）`);
      continue;
    }
    if (new Set(got).size !== got.length) drifted.push(`${what}: 字段有重复`);
    const miss = truth.filter((f) => !got.includes(f));
    const extra = got.filter((f) => !truth.includes(f));
    if (miss.length) drifted.push(`${what} 少列了 ${from} 里的：${miss.join(', ')}`);
    if (extra.length) drifted.push(`${what} 多列了 ${from} 里没有的：${extra.join(', ')}`);
  }
  assert.deepEqual(judged, [], '\n' + judged.join('\n'));
  assert.deepEqual(drifted, [], '\n' + drifted.join('\n'));
});

// ★★ 上面那条只比对了**点名的三个** —— 它的文件头却写着「源码里**每个**手抄的字段清单」。
//   口径比判据宽，就是「宣称强于实现」：下一个新增的 typedef 会**静默漏网**。
//   这条把口径补齐：**发现**到的每一个 typedef 都必须交代清楚（被比对 / 显式豁免），
//   并把「点名的东西已经不存在了」也一并报出来（过时的点名会让人以为某个形状「被管着」）。
test('★ 覆盖完整：src 里每个 `@typedef {object}` 都要么被比对、要么显式豁免', async () => {
  const found = allTypedefs();
  assert.ok(found.size > 0, '★ 判据失效：一个 typedef 都没发现 —— 抽取正则失效了，这不是「检查通过」');

  const covered = new Set([...(await typedefCases()).map((c) => c.what), ...NO_TRUTH_SOURCE.keys()]);
  const uncovered = [...found].filter(([name]) => !covered.has(name))
    .map(([name, file]) => `${file} 的 \`${name}\` 既没被比对、也没被显式豁免 —— 新加的手抄字段表必须交代清楚`);
  assert.deepEqual(uncovered, [], '\n' + uncovered.join('\n'));

  const stale = [...covered].filter((n) => !found.has(n));
  assert.deepEqual(stale, [], '点名的 typedef 在源码里已经不存在了 —— 点名过时（会让人以为某个形状「被管着」）');
});

test('★ 门禁自检：覆盖门禁真的能发现「新增了一个没人管的 typedef」', () => {
  const found = allTypedefs();
  assert.ok(found.has('PluginContext'), '前提：真实源码里确实有 PluginContext');
  // 负向：假装没覆盖它 ⇒ 覆盖门禁的判据必须能看见
  const covered = new Set(['PluginManifest', 'PluginDescriptor']);
  assert.ok([...found].some(([n]) => !covered.has(n)), '未覆盖的 typedef 必须能被看见（否则上面那条恒真）');
  // 正向对照：全部覆盖时不得误报
  const all = new Set(found.keys());
  assert.deepEqual([...found].filter(([n]) => !all.has(n)), [], '全覆盖不得误报');
});

test('★ 门禁自检：抽取器必须做括号配平、且能判别漂移（否则是恒真假绿）', () => {
  // ★ 嵌套花括号：类型里带内层 `{}` 时，字段名仍要抽对（朴素 `[^}]*` 会在这里错）
  const nested = [
    ' * @typedef {object} Probe',
    ' * @property {string} plain',
    ' * @property {(change: { id: string, to: string | null }) => void} withNested',
    ' * @property {Record<string,string>} mapped',
    ' */'
  ].join('\n');
  assert.deepEqual(typedefFields(nested, 'Probe'), ['plain', 'withNested', 'mapped']);

  // 非 @property 的行必须终止抽取（否则会把后面别的块的字段也算进来）
  const stopped = [' * @typedef {object} Probe', ' * @property {string} a', ' *', ' * @property {string} b'].join('\n');
  assert.deepEqual(typedefFields(stopped, 'Probe'), ['a'], '遇到非 @property 行必须停');

  // 找不到 typedef ⇒ 空数组（调用方据此报「判据失效」，不是通过）
  assert.deepEqual(typedefFields(nested, 'NoSuchTypedef'), []);

  // 判别力：真文档抽出来的字段集必须与真相源**真的比得上**
  const real = typedefFields(read('packages/kernel/src/types.mjs'), 'PluginManifest');
  assert.ok(real.length > 0, '真实源码必须抽得到 PluginManifest 的字段');
  assert.notDeepEqual(real, [...MANIFEST_FIELD_TABLE.kernel, 'ghostField'], '多一个字段必须比对失败');
  assert.notDeepEqual(real.filter((f) => f !== MANIFEST_FIELD_TABLE.kernel[0]), MANIFEST_FIELD_TABLE.kernel,
    '少一个字段必须比对失败');
});
