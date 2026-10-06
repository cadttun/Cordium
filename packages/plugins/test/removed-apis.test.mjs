/**
 * @file packages/plugins/test/removed-apis.test.mjs
 * @description 「删了什么」跨文件一致性门禁：`CHANGELOG.md` 每个 `### Removed` 条目，
 *   必须在 `design/removed-apis.md` 有留档，或在本条末尾写 `（无需留档）` 显式豁免。
 *
 * ── 起因（实测）────────────────────────────────────────────────────────────
 * 0.3.0 `### Removed` 的 2 条（`manifest` 的 `config` 字段 / `LifecycleState` 的
 * `VALIDATED` + `WAITING_DEPENDENCIES`）在 `design/removed-apis.md` 里**曾一条都没有**。
 * 两处各写一份「已删集合」，此前**没有任何机制**会发现漂移。
 *
 * ── 口径（为什么这么定）────────────────────────────────────────────────────
 * · 两处**不是同一份东西，也不合并**：
 *     - `CHANGELOG ### Removed` = 面向读者的**变更叙事**（登记「发生了一次删除」）；
 *     - `design/removed-apis.md` = 「**勿加回**」的**原文留档**（逐字保留删除理由与替代方案）。
 *   合并必然损坏其中一个。所以本门禁做**交叉核对**，不生成对方、也不造第三份集合。
 * · 只钉**单向**：CHANGELOG ⇒ 留档。**反向不钉** —— 留档是有意超集（实测：第 1~8 条在整个
 *   CHANGELOG 零出现；第 9 条 `restartRequired` 的删除记在 `### Changed`，根本不在 `### Removed`）。
 *   硬钉反向会立刻误报 9 条，并逼作者给内部形状决定编发布说明。
 * · 对标：Node 用**不可变编号**做稳定锚（`deprecations.json` 顶层 `"source": "doc/api/deprecations.md"`
 *   ⇒ 手写 md 才是源、JSON 是产物）；GitLab 在 CI 里跑 `rake gitlab:docs:check_deprecations` 校验
 *   源与生成物一致。**业界没有「双写手写列表硬双向对应」的形态**，故本门禁刻意不做。
 * · 「没匹配到」与「检查通过」**分开报**：找不到 `### Removed` 小节 / 留档解析不出条目
 *   ⇒ 报【判据失效】并失败，绝不当作通过（同 `boundary.test.mjs` 的版本声明门先例）。
 *
 * ⚠️ 故意不覆盖（别高估它）：
 *   ① 「源码删了、CHANGELOG 一条都没写」它看不见（两处都不记的删除无从核对）；
 *   ② 记在 `### Changed` 下的删除**不扫**（`### Changed` 里非删除条目占多数，无法机械区分）；
 *   ③ 不校验留档正文是否忠实于**实际被删的代码**（只能人读）；
 *   ④ 同名符号可能误配（另一条删除提及同名字符串即可假绿）；
 *   ⑤ 文本门禁的固有上限：拼接 / 动态构造的条目绕得过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHANGELOG = 'CHANGELOG.md';
const ARCHIVE = 'design/removed-apis.md';

// ★ 行尾归一放在读入那一刻：下面全是以行首为锚的正则，CRLF 会让它们整条失效（同 doc-examples.test.mjs）。
const readDoc = f => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\r\n').join('\n');

// ★ 显式豁免标记（写在条目**首行末尾**）。语义：本条删除不涉及需要留档的接口符号。
//   为什么**显式**而不是自动推断：被删符号已不在源码里，无法从当前导出面反查；启发式
//   「没写符号 ⇒ 当豁免」会把**忘写符号的潦草条目**静默放行 —— 正是本仓最反感的假绿。
const EXEMPT = /（无需留档）\s*$/;

/** 取字符串里的反引号 token。 */
const symbolsIn = s => [...s.matchAll(/`([^`]+)`/g)].map(m => m[1]);

/**
 * CHANGELOG 条目首行的**主体** = 第一个冒号（中英文都算）之前的部分。
 * ★ 为什么要切：首行冒号之后是**理由**，里面常出现别的反引号 token —— 实测 0.3.0 第 1 条的
 *   理由里就有 `{}` 与 `warn`。不切的话它们也会被算成「被删符号」，于是**任一条目都能被
 *   另一条的理由蹭中**（留档里只要有个叫 `warn` 的条目就假绿）。
 * ★ 约定：`- <主体>：<理由>` —— 主体点名被删的东西，理由说明为什么删。
 */
const headOf = line => {
  const i = line.search(/[：:]/);
  return i < 0 ? line : line.slice(0, i);
};

/**
 * 抽 CHANGELOG 的全部 `### Removed` 小节及其条目。
 * 条目 = `- ` 起头；缩进的续行并入上一条（实测 0.3.0 第 1 条就有续行）。
 */
function removedSections(changelog) {
  const lines = changelog.split('\n');
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^###\s/.test(l)) {
      cur = /^###\s+Removed\s*$/.test(l) ? { headingLine: i + 1, items: [] } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (/^##\s/.test(l)) { cur = null; continue; }   // ★ 不能把 `## ` 一律当版本切：CHANGELOG 里混着非版本标题
    if (!cur) continue;
    if (l.startsWith('- ')) cur.items.push({ line: i + 1, first: l, text: l });
    else if (cur.items.length && /^\s+\S/.test(l)) cur.items[cur.items.length - 1].text += '\n' + l;
  }
  return out;
}

/** 抽 design/removed-apis.md 的条目：`## N. <子系统>：<符号…>`，附 `原位置：` 与 ```text 围栏。 */
function archiveEntries(md) {
  const entries = [];
  let cur = null;
  md.split('\n').forEach((l, i) => {
    const m = /^##\s+(\d+)\.\s+(.*)$/.exec(l);
    if (m) {
      cur = { num: Number(m[1]), title: m[2], line: i + 1, symbols: symbolsIn(m[2]), hasLocation: false, fences: 0 };
      entries.push(cur);
      return;
    }
    if (!cur) return;
    if (l.startsWith('原位置：')) cur.hasLocation = true;
    if (/^```text\s*$/.test(l)) cur.fences++;
  });
  return entries;
}

/** 交叉核对（纯函数，便于自检直接调用）。failures = 明确不一致；judged = 判据失效。 */
function crossCheck(changelog, archiveMd) {
  const sections = removedSections(changelog);
  const archive = archiveEntries(archiveMd);
  const failures = [];
  const judged = [];
  const matched = [];
  const exempt = [];

  // ★ 判据失效 ≠ 通过
  if (sections.length === 0) judged.push(`${CHANGELOG} 里找不到任何 \`### Removed\` 小节 —— 判据失效，请更新本测试，不要当作通过`);
  if (archive.length === 0) judged.push(`${ARCHIVE} 里解析不出任何 \`## N.\` 条目 —— 判据失效，请更新本测试，不要当作通过`);

  const known = new Set(archive.flatMap(e => e.symbols));
  for (const sec of sections) {
    for (const item of sec.items) {
      if (EXEMPT.test(item.first)) { exempt.push(item); continue; }
      const syms = symbolsIn(headOf(item.first));
      if (syms.length === 0) {
        judged.push(`${CHANGELOG}:${item.line} 首行冒号之前既无 \`符号\` 也无 \`（无需留档）\` 标记 —— 无法判定，请按 \`- <被删的东西>：<理由>\` 补上`);
        continue;
      }
      if (syms.some(s => known.has(s))) matched.push(item);
      else failures.push(`${CHANGELOG}:${item.line} 的删除 [${syms.join(', ')}] 在 ${ARCHIVE} 里没有对应条目`
        + `（补一条 \`## N.\`，或在本条末尾写 \`（无需留档）\` 显式豁免）`);
    }
  }
  return { sections, archive, matched, exempt, failures, judged };
}

const CHANGELOG_TEXT = readDoc(CHANGELOG);
const ARCHIVE_TEXT = readDoc(ARCHIVE);

// ════════════════════════════════════════════════════════════════════════════

test('★ 留档体例自检：编号连续、每条都有 `原位置：` 与 ```text 围栏', () => {
  const entries = archiveEntries(ARCHIVE_TEXT);
  assert.ok(entries.length >= 11, `留档条目数异常（${entries.length}）—— 判据失效`);
  assert.deepEqual(entries.map(e => e.num), entries.map((_, i) => i + 1),
    '`## N.` 编号必须从 1 连续无缺口（重排 / 跳号会让「第 N 条」失去稳定引用，对齐 Node 的「编号不可改」）');
  const bad = entries.filter(e => !e.hasLocation || e.fences !== 1);
  assert.deepEqual(bad.map(e => `${ARCHIVE}:${e.line} 原位置=${e.hasLocation} text围栏=${e.fences}`), []);
});

test('★ 每个 CHANGELOG `### Removed` 条目都有留档（或以 `（无需留档）` 显式豁免）', () => {
  const { sections, matched, exempt, failures, judged } = crossCheck(CHANGELOG_TEXT, ARCHIVE_TEXT);
  assert.deepEqual(judged, [], '\n' + judged.join('\n'));            // ★ 先报「判据失效」，再报不一致
  assert.ok(sections.reduce((n, s) => n + s.items.length, 0) > 0, '未解析到任何 Removed 条目 —— 判据失效');
  assert.deepEqual(failures, [], '\n' + failures.join('\n'));
  assert.ok(matched.length + exempt.length > 0, '没有任何条目参与核对 —— 门禁恒真');
});

test('★ 门禁自检：能判漏档、能识豁免、找不到小节时不是通过', () => {
  const miss = crossCheck('### Removed\n\n- `__ghost_symbol__`：删了。\n', ARCHIVE_TEXT);
  assert.equal(miss.failures.length, 1, '漏档必须被判出');
  assert.match(miss.failures[0], /__ghost_symbol__/);

  const ex = crossCheck('### Removed\n\n- `__ghost_symbol__`：纯内部。（无需留档）\n', ARCHIVE_TEXT);
  assert.deepEqual(ex.failures, []);
  assert.equal(ex.exempt.length, 1, '显式豁免必须被识别');

  const vague = crossCheck('### Removed\n\n- 删了某个东西。\n', ARCHIVE_TEXT);
  assert.equal(vague.judged.length, 1, '首行冒号前既无符号也无标记 ⇒ 判据失效（不是通过）');
  assert.deepEqual(vague.failures, []);

  // ★ 冒号之后的**理由**里的反引号 token 不算「被删符号」—— 否则本条会被留档里
  //   某个恰好同名的**别的**条目蹭中（`config` 在留档第 10 条里，实测这一条正是假绿来源）
  const reasonOnly = crossCheck('### Removed\n\n- `__ghost_symbol__`：理由里顺带提到 `config`。\n', ARCHIVE_TEXT);
  assert.equal(reasonOnly.failures.length, 1, '理由里提到留档中存在的符号，不得当成匹配');
  assert.match(reasonOnly.failures[0], /__ghost_symbol__/);

  const none = crossCheck('## [9.9.9]\n\n### Fixed\n\n- 修了个 bug。\n', ARCHIVE_TEXT);
  assert.equal(none.sections.length, 0);
  assert.ok(none.judged.length >= 1, '★ 找不到 `### Removed` 小节必须报判据失效，不是全绿');

  const emptyArchive = crossCheck(CHANGELOG_TEXT, '# 空\n');
  assert.ok(emptyArchive.judged.some(m => m.includes(ARCHIVE)), '留档为空必须报判据失效');

  const gap = archiveEntries('## 1. a：`x`\n原位置：`p`\n```text\nA\n```\n## 3. c：`z`\n原位置：`q`\n```text\nC\n```\n');
  assert.notDeepEqual(gap.map(e => e.num), gap.map((_, i) => i + 1), '跳号必须被判出');

  // 缩进续行不得被当成新条目（0.3.0 第 1 条实测就有续行）
  const cont = crossCheck('### Removed\n\n- `config`：删了。\n  （续行说明，不是新条目。）\n', ARCHIVE_TEXT);
  assert.equal(cont.sections[0].items.length, 1, '缩进续行必须并入上一条');
});

test('★ 回归：0.3.0 的两条 Removed 都锚到留档（防再次漂移）', () => {
  const { matched } = crossCheck(CHANGELOG_TEXT, ARCHIVE_TEXT);
  const firstLines = matched.map(m => m.first).join('\n');
  // ★ 用**内容**锚定，不用行号 —— 行号会随新版本上移
  assert.match(firstLines, /`config`/, '`manifest 的 config 字段` 未锚到留档');
  assert.match(firstLines, /`LifecycleState`/, '`LifecycleState` 的 VALIDATED / WAITING_DEPENDENCIES 未锚到留档');
});
