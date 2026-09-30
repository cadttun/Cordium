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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '@cordium/kernel';
import { validatePluginManifest } from '../src/runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCS = ['README.md', 'PLUGIN_GUIDE.md'];

/** 取出 js 代码块的起止（只在 ```js / ```mjs 围栏内找示例，正文与其它语言的代码块不算） */
function jsFences(text) {
  const ranges = [];
  const re = /^```(?:js|mjs|javascript)[^\n]*\n([\s\S]*?)^```/gm;
  let m;
  while ((m = re.exec(text))) ranges.push([m.index + m[0].indexOf('\n') + 1, m.index + m[0].length]);
  return ranges;
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
  extractManifests(fs.readFileSync(path.join(ROOT, file), 'utf8')).map(e => ({ file, ...e })));

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
