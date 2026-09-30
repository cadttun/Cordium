// 边界门禁（CONTRIBUTING「边界」① / ③ + 插件层依赖方向）。
// ★ 此前三条边界都只写在文档里：往 host.mjs 注入一张 `PRODUCT_PROFILES` 装配表，全量测试照样全绿。
// ⚠️ 文本门禁的固有上限（同 neutrality.test.mjs）：拼接出来的 import 路径、运行期动态构造的表绕得过去；
//   它守的是「正常写法下的越界」，不是对抗性输入。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const KERNEL_SRC = 'packages/kernel/src';
const PLUGINS_SRC = 'packages/plugins/src';

function sources(dir) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter(n => n.endsWith('.mjs'))
    .map(n => ({ file: `${dir}/${n}`, text: fs.readFileSync(path.join(ROOT, dir, n), 'utf8') }));
}

/** 取出一个模块的全部 import / re-export 说明符（静态、副作用、动态三种写法） */
export function specifiers(text) {
  const out = [];
  const patterns = [
    /^[ \t]*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
}

// ─────────── 硬边界 ①：kernel/src 只 import 自己目录内的模块（或 node: 内置）───────────

const KERNEL_OK = /^(?:\.\/[\w.-]+\.mjs|node:[\w/]+)$/;

test('★ 硬边界 ①：kernel/src 不得 import 本目录之外的任何模块（业务实现 / 其它包 / 第三方）', () => {
  const hits = [];
  for (const { file, text } of sources(KERNEL_SRC)) {
    for (const spec of specifiers(text)) if (!KERNEL_OK.test(spec)) hits.push(`${file}  → ${spec}`);
  }
  assert.deepEqual(hits, [], '\n' + hits.join('\n'));
});

// ─────────── plugins/src 只经内核包名的两个入口取用内核 ───────────

// ★ 跨包一律走包名（package.json `exports` 是第一道闸：未导出的子路径 Node 直接拒绝解析）。
const PLUGINS_KERNEL_ENTRY = /^@cordium\/kernel(?:\/internal)?$/;

test('★ 依赖方向：plugins/src 引用内核只能走 @cordium/kernel / @cordium/kernel/internal', () => {
  const hits = [];
  for (const { file, text } of sources(PLUGINS_SRC)) {
    for (const spec of specifiers(text)) {
      if ((spec.includes('kernel') || spec.startsWith('.')) && !PLUGINS_KERNEL_ENTRY.test(spec) && !/^\.\/[\w.-]+\.mjs$/.test(spec)) {
        hits.push(`${file}  → ${spec}`);
      }
    }
  }
  assert.deepEqual(hits, [], '\n' + hits.join('\n'));
});

// ─────────── 跨包不得用相对路径（src 与 test 都算）───────────

const ALL_DIRS = ['packages/kernel/src', 'packages/kernel/test', 'packages/kernel/test/fixtures',
  'packages/plugins/src', 'packages/plugins/test', 'packages/plugins/test/fixtures',
  // 示例是读者照抄的起点：同样只许经包名取用，且不得碰 ./internal
  'examples/basic', 'examples/basic/plugins', 'examples/hot-reload', 'examples/hot-reload/plugins'];
// 跨出本包：`../../<别的包>/…`；测试引自己包的 src（`../src/…`）不算
const CROSS_PACKAGE_RELATIVE = /^(?:\.\.\/)+(?:\.\.\/)?(?:kernel|plugins)\//;

test('★ 跨包引用只走包名：src / test 里不得出现 ../../kernel/… 或 ../../plugins/… 之类的相对路径', () => {
  const hits = [];
  for (const dir of ALL_DIRS) {
    if (!fs.existsSync(path.join(ROOT, dir))) continue;
    for (const { file, text } of sources(dir)) {
      for (const spec of specifiers(text)) if (CROSS_PACKAGE_RELATIVE.test(spec)) hits.push(`${file}  → ${spec}`);
    }
  }
  assert.deepEqual(hits, [], '\n' + hits.join('\n'));
});

// ─────────── ./internal 是不稳定的内部子路径 —— 仓内只有 @cordium/plugins 的 src 能引 ───────────

test('★ @cordium/kernel/internal 只许 plugins/src 引用（kernel 自己的测试走相对路径即可，其余一律不许）', () => {
  const hits = [];
  for (const dir of ALL_DIRS.filter(d => d !== PLUGINS_SRC)) {
    if (!fs.existsSync(path.join(ROOT, dir))) continue;
    for (const { file, text } of sources(dir)) {
      for (const spec of specifiers(text)) if (spec === '@cordium/kernel/internal') hits.push(`${file}  → ${spec}`);
    }
  }
  assert.deepEqual(hits, [], '\n' + hits.join('\n'));
});

// ─────────── 包清单门禁（exports 定稿 / 目标存在 / 版本同步）───────────

const readPkg = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel, 'package.json'), 'utf8'));

test('★ exports 清单定稿（增删子路径 = 有意的 API 变更，必须同时改这里）', () => {
  assert.deepEqual(Object.keys(readPkg('packages/kernel').exports).sort(), ['.', './internal', './package.json']);
  assert.deepEqual(Object.keys(readPkg('packages/plugins').exports).sort(),
    ['./catalog', './ecosystem', './isolation', './loader', './package.json', './reload', './runtime']);
});

test('★ 每个 exports 目标文件都存在（改名 / 删文件不同步即红）', () => {
  const missing = [];
  for (const rel of ['packages/kernel', 'packages/plugins']) {
    for (const [sub, target] of Object.entries(readPkg(rel).exports)) {
      if (!fs.existsSync(path.join(ROOT, rel, target))) missing.push(`${rel} ${sub} → ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('★ 版本同步（lockstep）：两包 version 相等，plugins 对 kernel 的依赖钉在同一版本', () => {
  const k = readPkg('packages/kernel');
  const p = readPkg('packages/plugins');
  assert.equal(k.name, '@cordium/kernel');
  assert.equal(p.name, '@cordium/plugins');
  assert.equal(p.version, k.version, '两包必须同步打版本');
  assert.equal(p.dependencies?.['@cordium/kernel'], k.version, 'plugins 依赖的 kernel 版本必须等于 kernel 自身版本');
  assert.equal(k.private, true, '不发公开 registry（防手滑 npm publish）');
  assert.equal(p.private, true, '不发公开 registry（防手滑 npm publish）');
});

// ─────────── 硬边界 ③：kernel/src 与 plugins/src 不得出现产品装配清单 ───────────

// 装配清单的两种典型形态：
//   (a) 一张有名字的表（插件列表 / 装配档位 / 预置契约表）；
//   (b) 在内核里直接拿字面量调用装配入口（等于把某个应用的装配写死进基座）。
const ASSEMBLY_NAME = /PROFILE|ASSEMBL|BUILTIN|PRESET|PLUGIN_LIST|_PLUGINS$|MANIFESTS$|SERVICE_CONTRACTS$/i;
const TOP_LEVEL_DECL = /^(?:export\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
// ★ 只认【写死的名字】：字符串、字符串数组、带字符串 / 计算键 / id 的对象字面量。
//   内核自己的 `declarePermissions([record.requiredPermission])` 是转发变量，不是装配清单，不得误伤。
const LITERAL_ASSEMBLY_CALL =
  /\b(?:registerPlugin|declareServiceContracts?|declarePermissions)\s*\(\s*(?:['"`]|\[\s*['"`]|\{\s*(?:['"`]|\[|id\s*:))/;

export function assemblyHits(file, text) {
  const hits = [];
  for (const m of text.matchAll(TOP_LEVEL_DECL)) {
    if (ASSEMBLY_NAME.test(m[1])) hits.push(`${file}  装配表命名：${m[1]}`);
  }
  text.split(/\r?\n/).forEach((line, i) => {
    if (LITERAL_ASSEMBLY_CALL.test(line)) hits.push(`${file}:${i + 1}  字面量装配调用：${line.trim()}`);
  });
  return hits;
}

test('★ 硬边界 ③：kernel/src 不得出现产品装配清单（装配表 / 字面量装配调用）', () => {
  // ★ plugins/src 同样不得出现装配清单 —— 它是「机制包」，不带任何具体插件列表
  const hits = [KERNEL_SRC, PLUGINS_SRC].flatMap(dir => sources(dir)).flatMap(({ file, text }) => assemblyHits(file, text));
  assert.deepEqual(hits, [], '\n' + hits.join('\n'));
});

// ─────────── 门禁自检（否则门禁恒真）───────────

test('★ 门禁自检：import 说明符提取覆盖多行 / 副作用 / 动态三种写法', () => {
  const sample = [
    "import {\n  a, b,\n  // 注释\n  c\n} from '../../x/y.mjs';",
    "import 'side-effect';",
    "export { z } from './z.mjs';",
    "const m = await import('pkg-dyn');"
  ].join('\n');
  assert.deepEqual(specifiers(sample).sort(), ['../../x/y.mjs', './z.mjs', 'pkg-dyn', 'side-effect']);
  assert.ok(!KERNEL_OK.test('../../plugins/src/runtime.mjs'));
  assert.ok(!KERNEL_OK.test('some-package'));
  assert.ok(KERNEL_OK.test('./types.mjs') && KERNEL_OK.test('node:fs'));
  assert.ok(!PLUGINS_KERNEL_ENTRY.test('../../kernel/src/host.mjs'));
  assert.ok(!PLUGINS_KERNEL_ENTRY.test('../../kernel/src/internal.mjs'), '相对路径也不许');
  assert.ok(!PLUGINS_KERNEL_ENTRY.test('@cordium/kernel/src/host.mjs'));
  assert.ok(PLUGINS_KERNEL_ENTRY.test('@cordium/kernel') && PLUGINS_KERNEL_ENTRY.test('@cordium/kernel/internal'));
  for (const bad of ['../../kernel/src/index.mjs', '../../plugins/src/runtime.mjs', '../../../kernel/x.mjs']) {
    assert.ok(CROSS_PACKAGE_RELATIVE.test(bad), `必须命中：${bad}`);
  }
  for (const ok of ['../src/host.mjs', './fixtures/errors.mjs', '../../src/index.mjs', '@cordium/plugins/runtime']) {
    assert.ok(!CROSS_PACKAGE_RELATIVE.test(ok), `不得误伤：${ok}`);
  }
});

test('★ 门禁自检：装配清单能判别，且不误伤内核现有的通用表', () => {
  const bad = [
    'export const PRODUCT_PROFILES = { basic: [] };',
    'const BASE_SERVICE_CONTRACTS = [];',
    'export const DEFAULT_PLUGINS = [];',
    "    host.registerPlugin({ id: 'x', version: '1.0.0' }, entry);",
    "    this.declareServiceContracts({ 'svc.x': { access: 'public' } });",
    "    this.declarePermissions(['perm.x']);"
  ];
  for (const line of bad) assert.ok(assemblyHits('f', line).length > 0, `必须命中：${line}`);
  const ok = [
    'export const MANIFEST_FIELD_TABLE = Object.freeze({});',
    'export const SERVICE_ACCESS_VALUES = Object.freeze([]);',
    'export const PLUGIN_KIND_VALUES = [];',
    'this.declareServiceContract(serviceName, spec);',
    'if (record.requiredPermission !== null) this.declarePermissions([record.requiredPermission]);',
    '`… must be declared by the host via host.declarePermissions()`'
  ];
  for (const line of ok) assert.deepEqual(assemblyHits('f', line), [], `不得误伤：${line}`);
});
