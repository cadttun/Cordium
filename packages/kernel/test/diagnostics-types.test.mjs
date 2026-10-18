/**
 * 诊断稳定面的**类型**门禁。
 *
 * ── 守的是什么 ──────────────────────────────────────────────────────
 *   `DIAGNOSTICS_CONTRACT.stable['services[]']` **点名承诺**了六个字段
 *   （`name` / `access` / `requiredPermission` / `methods` / `activeProvider` / `providerCount`）。
 *
 *   ★★ 但「点名的名字出现在契约表里」与「消费方能在类型层用上它们」是**两件事**：
 *      此前 `serviceSnapshot` 写 `@returns {object}` ⇒ `getDiagnostics().services` 退化成
 *      **`object[]`** ⇒ 消费方读 `d.services[0].name` 拿到 `any`。
 *      **契约在类型层形同不存在** —— 而所有既有门禁（契约表对照、字段齐全断言）都还是绿的。
 *
 *   ⇒ 本门禁补的正是这一格：**契约点名了，类型就必须真的说得出它**。
 *
 * ★ 为什么从**生成的声明**读而不是从源码读：消费方拿到的是 `.d.mts`。
 *   源码里写得再准，若某处用 `@returns {object}` 把它抹平，消费方看到的还是 `any`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIAGNOSTICS_CONTRACT } from '../src/types.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DTS = fs.readFileSync(path.join(ROOT, 'types/host.d.mts'), 'utf8');

/**
 * 取出 `getDiagnostics(): { ... }` 那一段（按大括号配对，不靠行号）。
 *
 * ★ 必须先剥注释再找 —— `getDiagnostics()` 在 JSDoc 正文里出现过多次（实测：
 *   直接 `indexOf` 命中的是**注释里**那一次，于是 `{` 落在别的声明上）。
 *   ⇒ 判据必须建在**代码**上，不能建在「文件里第一次出现这个词的位置」上。
 */
function getDiagnosticsBlock() {
  const code = DTS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const m = /(?:^|\n)\s*getDiagnostics\(\)\s*:/.exec(code);
  assert.ok(m, 'types/host.d.mts 里找不到 getDiagnostics 的**声明**');
  const open = code.indexOf('{', m.index + m[0].length - 1);
  assert.ok(open >= 0, 'getDiagnostics 声明后面没有类型字面量');
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  throw new Error('getDiagnostics 的类型字面量没有闭合');
}

/** 取出 `services: [...]` 这一段的类型文本 */
function servicesSegment(block) {
  const at = block.indexOf('services:');
  assert.ok(at >= 0, 'getDiagnostics 返回值里没有 services');
  let depth = 0;
  let started = false;
  for (let i = at; i < block.length; i += 1) {
    const ch = block[i];
    if (ch === '{' || ch === '[') { depth += 1; started = true; }
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (started && depth === 0) return block.slice(at, i + 1);
    } else if (ch === ';' && depth === 0) {
      return block.slice(at, i + 1);
    }
  }
  return block.slice(at);
}

test('★★ 诊断稳定面点名的字段，在生成的声明里必须真的是【具体类型】而不是 object/any', () => {
  const seg = servicesSegment(getDiagnosticsBlock());

  // ★ 先钉住最要命的那一种退化：整个 services 数组被抹成 object[]
  assert.doesNotMatch(seg, /\bservices\s*:\s*object\s*\[\]/,
    '★★ services 退化成 object[] —— 契约点名的字段在类型层全部消失（消费方拿到 any）。\n'
    + `实际声明片段：${seg}`);
  assert.doesNotMatch(seg, /\bservices\s*:\s*any\s*\[\]/,
    '★★ services 退化成 any[]');

  // ★ 再逐字段核对：契约点名的每一个都必须出现在声明里
  const named = DIAGNOSTICS_CONTRACT.stable['services[]'];
  assert.ok(Array.isArray(named) && named.length >= 6, '契约表本身必须点名字段');
  const missing = named.filter(f => !new RegExp(`\\b${f}\\s*:`).test(seg));
  assert.deepEqual(missing, [],
    '\n以下稳定面字段在 types/host.d.mts 的 services 声明里找不到：\n' + missing.join('\n'));
});

test('★ 门禁自检：判据能识别退化形态（否则是恒真的假绿）', () => {
  const good = 'services: { name: string; access: string }[];';
  const bad = 'services: object[];';
  assert.doesNotMatch(good, /\bservices\s*:\s*object\s*\[\]/);
  assert.match(bad, /\bservices\s*:\s*object\s*\[\]/);
  // ★ 字段名判据也要有正向对照：出现在别处的同名字段不能算数
  const named = DIAGNOSTICS_CONTRACT.stable['services[]'];
  assert.equal(named.filter(f => new RegExp(`\\b${f}\\s*:`).test('name: string;')).length, 1);
});

test('★ 不稳定的扩展字段（scopedProviders 等）也如实描述，而不是靠 any 兜底', () => {
  const seg = servicesSegment(getDiagnosticsBlock());
  // ★ 它们不在承诺面，但「实现里有、类型里没有」同样是谎报 —— 消费方要排障时会读它们
  for (const extra of ['scopedProviderCount', 'scopedProviders']) {
    assert.match(seg, new RegExp(`\\b${extra}\\b`), `${extra} 在实现里有，声明里也要有`);
  }
});

test('★ getDiagnostics 的相关门禁（本文件）在契约表变动时会跟着动', () => {
  // 契约表若删掉一个稳定字段，上面的逐字段核对会自动少查一项 —— 这是对的
  // （判据取自被检查对象自身在这里**成立**，因为「契约说了什么」正是唯一真相源）。
  // 但必须保证它**不是空集**，否则逐字段核对会退化成恒真。
  assert.ok(DIAGNOSTICS_CONTRACT.stable['services[]'].length > 0);
});
