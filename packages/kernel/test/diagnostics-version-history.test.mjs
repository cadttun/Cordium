/**
 * ★★ 诊断契约「版本 → 形状」表（`DIAGNOSTICS_VERSION_HISTORY`）的门禁。
 *
 * 守四件事：
 *   ① 表不落后于常量：末行 `schemaVersion` == `DIAGNOSTICS_CONTRACT.schemaVersion`；
 *   ② 版本只增不跳号、首行为 1；`release` 合法且不回退；
 *   ③ `change` 非空、不重复（挡占位符）；
 *   ④ ★ 各行 `added` 之并 == 当前稳定面 —— 稳定面加键却不记是哪一版加的 ⇒ 红。
 *
 * ★ 判据写成纯函数 `historyProblems(history, contract)`：真实输入必须零问题，
 *   每条规则再各喂一份**故意写坏**的输入，证明它真能变红（不是恒真的假绿）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DIAGNOSTICS_CONTRACT } from '../src/index.mjs';
import { DIAGNOSTICS_VERSION_HISTORY, isValidSemVer, compareSemVer } from '../src/internal.mjs';
import { unfrozenPaths } from './fixtures/deep-frozen.mjs';

const keyOf = (path, key) => `${path === '' ? '<root>' : path}.${key}`;

/** @returns {string[]} 问题清单；空 = 通过 */
function historyProblems(history, contract) {
  const problems = [];
  if (history.length === 0) return ['表为空'];
  if (history[0].schemaVersion !== 1) problems.push(`首行 schemaVersion 应为 1，实为 ${history[0].schemaVersion}`);
  if (history.at(-1).schemaVersion !== contract.schemaVersion) {
    problems.push(`末行 schemaVersion=${history.at(-1).schemaVersion} ≠ 契约 ${contract.schemaVersion}（改了版本号却没记一行）`);
  }
  const changes = new Set();
  const added = new Map();
  history.forEach((row, i) => {
    if (!isValidSemVer(row.release)) problems.push(`第 ${i} 行 release 非法：${row.release}`);
    if (typeof row.change !== 'string' || row.change.trim() === '') problems.push(`第 ${i} 行 change 为空`);
    else if (changes.has(row.change)) problems.push(`第 ${i} 行 change 重复`);
    else changes.add(row.change);
    if (i > 0) {
      const prev = history[i - 1];
      const step = row.schemaVersion - prev.schemaVersion;
      if (step !== 0 && step !== 1) problems.push(`第 ${i} 行 schemaVersion 从 ${prev.schemaVersion} 到 ${row.schemaVersion}（只许 +0 / +1）`);
      if (isValidSemVer(row.release) && isValidSemVer(prev.release) && compareSemVer(row.release, prev.release) < 0) {
        problems.push(`第 ${i} 行 release ${row.release} 早于上一行 ${prev.release}`);
      }
    }
    for (const [path, keys] of Object.entries(row.added)) {
      for (const key of keys) {
        const k = keyOf(path, key);
        if (added.has(k)) problems.push(`${k} 在第 ${added.get(k)} 行与第 ${i} 行重复登记`);
        else added.set(k, i);
      }
    }
  });
  const stable = new Set(Object.entries(contract.stable).flatMap(([p, keys]) => keys.map(k => keyOf(p, k))));
  for (const k of stable) if (!added.has(k)) problems.push(`稳定键 ${k} 不在任何一行的 added 里（没回答它是哪一版加的）`);
  for (const k of added.keys()) if (!stable.has(k)) problems.push(`added 登记了 ${k}，但它已不在稳定面（删键必须 bump 并另记）`);
  return problems;
}

test('★★ 真实的版本历史与契约一致（零问题）', () => {
  assert.deepEqual(historyProblems(DIAGNOSTICS_VERSION_HISTORY, DIAGNOSTICS_CONTRACT), []);
});

test('★ 版本历史逐层冻结（消费方改不了内核的历史记录）', () => {
  assert.deepEqual(unfrozenPaths(DIAGNOSTICS_VERSION_HISTORY), []);
});

test('★★ 门禁有判别力：每条规则各喂一份写坏的输入，都必须变红', () => {
  const H = DIAGNOSTICS_VERSION_HISTORY;
  const C = DIAGNOSTICS_CONTRACT;
  const red = (label, history, contract = C) =>
    assert.ok(historyProblems(history, contract).length > 0, `${label} 应当变红`);

  red('改了契约版本号却没加行', H, { ...C, schemaVersion: C.schemaVersion + 1 });
  red('稳定面加键却不记版本', H, { ...C, stable: { ...C.stable, '': [...C.stable[''], 'newKey'] } });
  red('稳定面删键却还登记着', H, { ...C, stable: { ...C.stable, '': C.stable[''].filter(k => k !== 'booted') } });
  red('跳号', [...H, { schemaVersion: H.at(-1).schemaVersion + 2, release: '9.0.0', change: 'x', added: {} }],
    { ...C, schemaVersion: H.at(-1).schemaVersion + 2 });
  red('release 回退', [...H, { schemaVersion: H.at(-1).schemaVersion, release: '0.1.0', change: 'y', added: {} }]);
  red('release 非法', [...H, { schemaVersion: H.at(-1).schemaVersion, release: 'next', change: 'z', added: {} }]);
  red('change 为空', [...H, { schemaVersion: H.at(-1).schemaVersion, release: '9.0.0', change: ' ', added: {} }]);
  red('change 重复', [...H, { ...H.at(-1), added: {} }]);
  red('同一个键登记两次', [...H, { schemaVersion: H.at(-1).schemaVersion, release: '9.0.0', change: 'dup', added: { '': ['booted'] } }]);
});
