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

// ─────────── 两包各存一份的测试夹具必须逐字节相同（防漂）───────────

// ★ 上面那道门禁（跨包只走包名）堵死了「两包共用一份夹具」⇒ 只能各存一份。
//   而各存一份就是本仓反复踩的「**手抄清单会漂**」的同款形态（两个方向都会无声跑偏）——
//   所以用这条门禁把它钉死：改了一边忘了另一边，当场红。
// ★ 判据是**逐字节相同**，不是「大致一样」：夹具里有注释解释口径，注释漂了也会误导读者。
const MIRRORED_FIXTURES = ['deep-frozen.mjs'];

test('★ 两包各存一份的测试夹具必须逐字节相同（防「改了一边忘另一边」）', () => {
  const bad = [];
  for (const name of MIRRORED_FIXTURES) {
    const a = path.join(ROOT, 'packages/kernel/test/fixtures', name);
    const b = path.join(ROOT, 'packages/plugins/test/fixtures', name);
    // ★ 「没找到」与「检查通过」分开报（规矩 44）：任一份不存在 ⇒ 判据失效，不是通过
    if (!fs.existsSync(a) || !fs.existsSync(b)) {
      bad.push(`${name}：两份夹具没有同时存在（判据失效，请更新本测试，不要当作通过）`);
      continue;
    }
    if (fs.readFileSync(a, 'utf8') !== fs.readFileSync(b, 'utf8')) bad.push(`${name}：两份内容不一致`);
  }
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
  // ★ 非恒真：镜像清单不能是空的，且确实存在（否则本门禁是空扫）
  assert.ok(MIRRORED_FIXTURES.length > 0, '镜像清单为空 —— 门禁恒真');
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
  // ★ 根（private，从不发布）也纳入 —— 此前它漂到 0.2.0 无人管（lockstep 只管两包）。
  assert.equal(readPkg('.').version, k.version, '根版本随两包同步 —— 防再次漂移（0.2.1 前它停在 0.2.0）');
});

// ── 运行时零依赖：判据范围（2026-10 实测 + npm 官方文档）──────────────────
// ★ 会进【消费方安装树】的字段（实测 npm 11：装完 node_modules 顶层真的出现这些包）：
//   · dependencies           —— 一直有管
//   · optionalDependencies   —— **默认安装**（只是安装失败被容忍）；`--omit=optional` 才跳过
//   · peerDependencies       —— **npm 7 起默认自动安装**；范围无解时消费方**整个装不上**
// ★ 会【把第三方物理打进 tarball】的字段：bundledDependencies / bundleDependencies
//   （实测：与匹配的 dependencies 同时存在时，tarball 里出现 `package/node_modules/<第三方>/**`）
// ★ 声明面字段（npm 对非 root 包忽略，但仍是「声明了第三方」，且换包管理器语义不同）：
//   overrides / resolutions / packageExtensions
// ★ devDependencies **明确豁免**：消费方 `npm install` **不会**安装依赖的 devDependencies。
//   ⚠️ 措辞订正（实测）：`npm pack` 的 package.json **会保留** devDependencies
//   （`chalk@5.6.2` 的真实发布物就带着 10 条）—— 正确的说法是「**消费方安装树不含**」，
//   不是「产物清单不含」。豁免的结论不变，但理由以前写错了。
// ⚠️ 本门禁只看 manifest：源码里 `import` 了未声明的包由硬边界①覆盖；
//   手动把第三方 vendored 进 `src/`（`files:["src"]` 会照发）文本门禁看不见，属残留风险。
const FIRST_PARTY = '@cordium/';
const INSTALL_TREE_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const BUNDLE_FIELDS = ['bundledDependencies', 'bundleDependencies'];
const DECLARATION_FIELDS = ['overrides', 'resolutions', 'packageExtensions'];

/** 返回 pkg 里所有「非本仓」的运行时 / 产物面依赖，形如 `optionalDependencies.left-pad` */
export function runtimeThirdParty(pkg, allow = []) {
  const ok = name => name.startsWith(FIRST_PARTY) || allow.includes(name);
  const bad = [];
  for (const field of INSTALL_TREE_FIELDS) {
    for (const name of Object.keys(pkg[field] ?? {})) if (!ok(name)) bad.push(`${field}.${name}`);
  }
  for (const field of BUNDLE_FIELDS) {
    const v = pkg[field];
    if (v === true) bad.push(`${field}: true（会把全部依赖打进产物）`);
    else if (Array.isArray(v)) for (const name of v) if (!ok(name)) bad.push(`${field}.${name}`);
  }
  for (const field of DECLARATION_FIELDS) {
    for (const name of Object.keys(pkg[field] ?? {})) if (!ok(name)) bad.push(`${field}.${name}`);
  }
  return bad.sort();
}

test('★ 运行时零依赖：消费方安装树 / 产物里不得出现第三方（devDependencies 豁免）', () => {
  const k = readPkg('packages/kernel');
  const p = readPkg('packages/plugins');
  const bad = [...runtimeThirdParty(k), ...runtimeThirdParty(p, ['@cordium/kernel'])];
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
});

test('★ 门禁自检：零依赖谓词能判别各类字段，且不误伤 devDependencies 与同仓依赖', () => {
  const K = { name: '@cordium/kernel' };
  const P = { name: '@cordium/plugins', dependencies: { '@cordium/kernel': '0.3.0' } };
  // 正向对照（规矩 42）：合法现状必须为空
  assert.deepEqual(runtimeThirdParty(K), []);
  assert.deepEqual(runtimeThirdParty(P, ['@cordium/kernel']), []);
  assert.deepEqual(runtimeThirdParty({ ...K, devDependencies: { oxlint: '1.86.0' } }), [],
    'devDependencies 必须豁免（消费方安装树不含它）');
  // 负向：每一类第三方写法都必须命中，否则门禁恒真
  for (const [label, obj] of [
    ['optionalDependencies', { optionalDependencies: { 'left-pad': '1.3.0' } }],
    ['peerDependencies', { peerDependencies: { 'left-pad': '*' } }],
    ['bundleDependencies', { bundleDependencies: ['left-pad'] }],
    ['bundledDependencies', { bundledDependencies: ['left-pad'] }],
    ['bundleDependencies: true', { bundleDependencies: true }],
    ['overrides', { overrides: { 'left-pad': '1.3.0' } }],
    ['resolutions', { resolutions: { 'left-pad': '1.3.0' } }],
    ['dependencies', { dependencies: { 'left-pad': '1.3.0' } }]
  ]) assert.ok(runtimeThirdParty({ ...K, ...obj }).length > 0, `必须命中：${label}`);
});

// ─────────── 发布面文档的版本声明随包版本同步 ───────────

test('★ 发布面文档的版本声明随包版本同步（徽章 / 正文 / 产物名 / 依赖 pin / 支持版本线 / CI 同款命令）', () => {
  // 版本号此前只在三处 package.json 与 lockfile 之间钉住，文档里的版本声明无人管 ——
  // 结果是 README 的徽章、正文、产物名、安装示例的依赖 pin 四类声明一起停在旧版本，
  // 读者照抄安装示例会指向一个【不存在的 tgz】。这条给那一类补上机械防线。
  const v = readPkg('packages/kernel').version;
  const minorLine = v.split('.').slice(0, 2).join('.') + '.x';
  const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const bad = [];

  const readme = read('README.md');
  const claims = [
    [/badge\/version-([0-9][\w.-]*)-/, '徽章'],
    [/当前为 ([0-9][\w.-]*)，/, '正文「当前为 X」'],
    [/dist\/cordium-kernel-([0-9][\w.-]*)\.tgz/, 'pack 产物名（kernel）'],
    [/dist\/cordium-plugins-([0-9][\w.-]*)\.tgz/, 'pack 产物名（plugins）'],
    [/@cordium\/kernel@([0-9][\w.-]*)/, '安装示例的依赖 pin']
  ];
  for (const [re, label] of claims) {
    const found = [...readme.matchAll(new RegExp(re.source, 'g'))].map(m => m[1]);
    // ★「没匹配到」与「检查通过」必须分开报：判据本身失效不是绿灯。
    if (found.length === 0) bad.push(`${label}：README 里找不到该声明的判据 —— 判据失效，请更新本测试，不要当作通过`);
    for (const got of found) if (got !== v) bad.push(`${label}：README 写 ${got}，包版本是 ${v}`);
  }

  const security = read('SECURITY.md');
  if (!security.includes(`| ${minorLine} | ✅ |`)) bad.push(`SECURITY 支持版本表未把当前版本线 ${minorLine} 标为受支持`);

  // CONTRIBUTING 自称「CI 同款」的静态检查命令：必须与 CI 里跑的那条逐字一致
  const ciLine = read('.github/workflows/test.yml').split(/\r?\n/).find(l => l.includes('oxlint --deny-warnings'));
  if (!ciLine) bad.push('CI 里找不到 oxlint 命令行 —— 判据失效，请更新本测试，不要当作通过');
  else {
    const cmd = ciLine.trim().replace(/^-\s*run:\s*/, '');
    if (!read('CONTRIBUTING.md').includes(cmd)) bad.push(`CONTRIBUTING 的静态检查命令与 CI 不一致，CI 实跑的是：${cmd}`);
  }

  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
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
