/**
 * @file packages/kernel/test/public-surface-snapshot.test.mjs
 * @description 公开面快照门禁：仓内的 `public-surface.json` 必须逐字节等于【此刻从代码生成】的结果。
 *
 * ── 与 `public-surface.test.mjs` 的分工 ─────────────────────────────
 *   · `public-surface.test.mjs` = **冻结面**（带注释的、人读的契约；增 / 删 / 改名即红）；
 *   · 本文件 = **baseline 对象**（机器读的快照，跨版本 `git diff` 即得公开面增量 ——
 *     「该升哪一位」答得了）。两者是同一公开面的**两个视图**，任一改动都会同时打红。
 *
 * ★ 判据取自**代码**（`scripts/public-surface.mjs` 运行时取值），**不手抄** ⇒ 快照不可能与实现漂。
 * ★ 覆盖**两包**（内核 `index` / `internal` + 插件六子入口），故放在内核测试目录（内核是基座）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshots, classifyBump, kindOf } from '../../../scripts/public-surface.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FILES = { kernel: 'packages/kernel/public-surface.json', plugins: 'packages/plugins/public-surface.json' };
const serialize = obj => JSON.stringify(obj, null, 2) + '\n';

test('★★ 公开面快照必须逐字节等于此刻生成的结果（跨版本 diff 的 baseline）', async () => {
  const snapshots = await buildSnapshots();
  const drifted = [];
  for (const [pkg, rel] of Object.entries(FILES)) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { drifted.push(`${rel} 不存在 —— 判据失效（跑 \`node scripts/public-surface.mjs --write\`）`); continue; }
    const cur = fs.readFileSync(abs, 'utf8').split('\r\n').join('\n');
    if (cur !== serialize(snapshots[pkg])) drifted.push(`${rel} 与此刻生成的结果不一致`);
  }
  assert.deepEqual(drifted, [], '\n' + drifted.join('\n')
    + '\n\n★ 修法：确认改动是【有意的公开面变更】后，跑 `node scripts/public-surface.mjs --write` 并一并提交。');
});

test('★ 快照必须真的抓到了公开面（非空扫描，否则门禁是空转）', async () => {
  const { kernel, plugins } = await buildSnapshots();
  // ★ 导出表现在是「名字 → 种类」的对象（schemaVersion 2），不再是字符串数组。
  assert.ok('CordiumHost' in kernel.exports['.'], '内核入口清单必须含 CordiumHost');
  assert.ok(kernel.pluginContext.includes('pluginId') && kernel.pluginContext.includes('getService'),
    'ctx 扫描非空且含已知成员');
  assert.ok(kernel.errorCodes.includes('INVALID_ARGUMENT'), '错误码清单必须含已知码');
  assert.ok('loadPlugins' in plugins.exports['./loader'], '插件子入口清单必须含 loadPlugins');
});

test('★★ 快照必须记录导出**种类**（否则 async→普通函数的形状变化完全隐形）', async () => {
  const { kernel, plugins } = await buildSnapshots();
  // 已知种类的三种代表：class / function / object（值对象）
  assert.equal(kernel.exports['.'].CordiumHost, 'class', 'CordiumHost 是 class');
  assert.equal(kernel.exports['.'].isRetryable, 'function', 'isRetryable 是普通函数');
  assert.equal(kernel.exports['.'].ErrorCode, 'object', 'ErrorCode 是值对象');
  assert.ok(plugins.exports['./isolation'].startIsolated === 'function');
  // 非空自检：所有种类都必须是已知取值之一（防止取错成 undefined）
  const KNOWN = new Set(['async-function', 'async-generator-function', 'generator-function',
    'class', 'function', 'array', 'object', 'null', 'string', 'number', 'boolean', 'symbol', 'bigint', 'undefined']);
  const bad = [];
  for (const [entry, table] of Object.entries(kernel.exports)) {
    for (const [name, kind] of Object.entries(table)) if (!KNOWN.has(kind)) bad.push(`kernel ${entry} ${name} = ${kind}`);
  }
  for (const [entry, table] of Object.entries(plugins.exports)) {
    for (const [name, kind] of Object.entries(table)) if (!KNOWN.has(kind)) bad.push(`plugins ${entry} ${name} = ${kind}`);
  }
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
});

test('★ 门禁自检：比对必须能判别内容差异与增删（否则是恒真假绿）', () => {
  assert.notEqual(serialize({ x: 1 }), serialize({ x: 2 }), '值变必须可判');
  assert.notEqual(serialize({ x: 1 }), serialize({ x: 1, y: 2 }), '增键必须可判');
  assert.equal(serialize({ x: 1 }), serialize({ x: 1 }), '同内容必须相等');
});

// ── 从 diff 算 bump（分类规则）────────────────────────────────────────
const base = () => ({
  kernel: { schemaVersion: 2, exports: { '.': { A: 'function', B: 'function' } }, kernelApiVersion: '1.0.0', errorCodes: ['X'], enums: { E: ['P'] } },
  plugins: { schemaVersion: 2, exports: { './loader': { loadPlugins: 'function' } } }
});
const withKernel = mutate => { const s = base(); mutate(s.kernel); return s; };

test('★ 删导出 ⇒ breaking；≥1.0 时 bump = major（删名字是最硬的一类）', () => {
  const cls = classifyBump(base(), withKernel(k => { delete k.exports['.'].B; }), '1.2.0');
  assert.equal(cls.nature, 'breaking');
  assert.equal(cls.bump, 'major');
  assert.deepEqual(cls.removed, [{ at: 'kernel > exports > .', name: 'B' }]);
});

test('★ 增导出 ⇒ additive；bump = minor（向后兼容）', () => {
  const cls = classifyBump(base(), withKernel(k => { k.exports['.'].C = 'function'; }), '1.2.0');
  assert.equal(cls.nature, 'additive');
  assert.equal(cls.bump, 'minor');
  assert.deepEqual(cls.added, [{ at: 'kernel > exports > .', name: 'C' }]);
});

test('★ 无变化 ⇒ none / no_change', () => {
  const cls = classifyBump(base(), base(), '1.2.0');
  assert.equal(cls.nature, 'none');
  assert.equal(cls.bump, 'no_change');
  assert.deepEqual([cls.removed, cls.added, cls.changed], [[], [], []]);
});

test('★★ 0.x 语义：同一个 breaking，0.4.0 下只要求 minor（SemVer §4）', () => {
  const broken = withKernel(k => { delete k.exports['.'].B; });
  assert.equal(classifyBump(base(), broken, '0.4.0').bump, 'minor', '0.x 破坏 ⇒ minor');
  assert.equal(classifyBump(base(), broken, '1.0.0').bump, 'major', '≥1.0 破坏 ⇒ major');
  assert.equal(classifyBump(base(), broken, '0.4.0').nature, 'breaking', 'nature 始终如实');
});

test('★ 标量改（kernelApiVersion）⇒ breaking（换 API 版本本身就是大事件）', () => {
  const cls = classifyBump(base(), withKernel(k => { k.kernelApiVersion = '2.0.0'; }), '1.2.0');
  assert.equal(cls.nature, 'breaking');
  assert.deepEqual(cls.changed, [{ at: 'kernel > kernelApiVersion', from: '1.0.0', to: '2.0.0' }]);
});

test('★ 枚举成员新增 ⇒ additive（同 break-check），但必须出 note（闭枚举穷举会漏）', () => {
  const cls = classifyBump(base(), withKernel(k => { k.enums.E.push('Q'); }), '1.2.0');
  assert.equal(cls.nature, 'additive');
  assert.equal(cls.bump, 'minor');
  assert.ok(cls.notes.some(n => n.includes('kernel > enums > E > Q')), '必须点名到具体成员');
});

test('★ 删整个子入口 ⇒ breaking，且逐名列出（不是只报「入口没了」）', () => {
  const s = base();
  delete s.plugins.exports['./loader'];
  const cls = classifyBump(base(), s, '1.2.0');
  assert.equal(cls.nature, 'breaking');
  assert.deepEqual(cls.removed, [{ at: 'plugins > exports > ./loader', name: 'loadPlugins' }]);
});

test('★ 映射自检：bump 必须真的随版本走（breaking 在 0.x/1.x 不同；additive 两边都是 minor）', () => {
  const broken = withKernel(k => { delete k.exports['.'].B; });
  const added = withKernel(k => { k.exports['.'].C = 'function'; });
  assert.notEqual(classifyBump(base(), broken, '0.4.0').bump, classifyBump(base(), broken, '1.0.0').bump,
    'breaking 必须随版本不同（否则映射写死）');
  assert.equal(classifyBump(base(), added, '0.4.0').bump, classifyBump(base(), added, '1.0.0').bump,
    'additive 在 0.x 与 1.x 下都应是 minor');
});

// ── 导出种类（schemaVersion 2 新增）────────────────────────────────
test('★★ 种类变化 ⇒ breaking（改前它完全隐形：只记名字时 async→普通函数=零变化）', () => {
  // 真实案例：`callIsolated` 由 `async function` 改成普通 `function`，
  // 名字没变、`typeof` 仍是 "function"，只记名字的快照报「零变化」。
  const cls = classifyBump(base(), withKernel(k => { k.exports['.'].A = 'async-function'; }), '1.2.0');
  assert.equal(cls.nature, 'breaking', '种类变化必须判 breaking');
  assert.deepEqual(cls.changed, [{ at: 'kernel > exports > .', name: 'A', from: 'function', to: 'async-function' }]);
});

test('★★ 格式演进：旧快照（字符串数组）vs 新快照（名字→种类）不得造假 breaking', () => {
  // 这是「改快照格式」本身必须过的关：如果直接把数组与对象相减，
  // 要么抛 TypeError（实测原实现如此），要么把每个导出都报成变化。
  // 正确行为：**只比名字** —— 旧版没记种类 ⇒ 种类未知 ⇒ 不判种类变化。
  const legacy = {
    kernel: { schemaVersion: 1, exports: { '.': ['A', 'B'] }, kernelApiVersion: '1.0.0', errorCodes: ['X'], enums: { E: ['P'] } },
    plugins: { schemaVersion: 1, exports: { './loader': ['loadPlugins'] } }
  };
  const cls = classifyBump(legacy, base(), '0.5.0');
  assert.equal(cls.nature, 'none', '同一份公开面、只是格式不同 ⇒ 必须判 no_change');
  assert.deepEqual([cls.removed, cls.added, cls.changed], [[], [], []]);

  // 反向：新 → 旧同样不得炸
  const back = classifyBump(base(), legacy, '0.5.0');
  assert.equal(back.nature, 'none');
});

test('★ 格式演进下「真的删了名字」仍必须被看见（不能因为跨格式就漏报）', () => {
  const legacy = {
    kernel: { schemaVersion: 1, exports: { '.': ['A', 'B'] }, kernelApiVersion: '1.0.0', errorCodes: ['X'], enums: { E: ['P'] } },
    plugins: { schemaVersion: 1, exports: { './loader': ['loadPlugins'] } }
  };
  const cls = classifyBump(legacy, withKernel(k => { delete k.exports['.'].B; }), '0.5.0');
  assert.equal(cls.nature, 'breaking');
  assert.deepEqual(cls.removed, [{ at: 'kernel > exports > .', name: 'B' }]);
});

test('★ 普通数组（enums / errorCodes）必须按集合比，不能被当成导出表', () => {
  // 实测踩到过：数组落进对象递归分支 ⇒ 拿**下标**当键 ⇒ 枚举新增被误判成 changed（breaking）。
  const cls = classifyBump(base(), withKernel(k => { k.enums.E.push('Q'); }), '1.2.0');
  assert.equal(cls.nature, 'additive', '枚举成员新增是 additive，不是 breaking');
  assert.deepEqual(cls.changed, [], '不得产生 changed');
  assert.deepEqual(cls.added, [{ at: 'kernel > enums > E', name: 'Q' }]);
});

// ── 种类判据本身的判别力（**不是**验证它输出的形状）──────────────
test('★★ 判据必须挡住 Symbol.toStringTag 伪造（否则数据能改写自己的分类）', () => {
  // 实测：一个普通对象挂上 `Symbol.toStringTag = 'AsyncFunction'`，
  // `Object.prototype.toString.call` 就返回 `[object AsyncFunction]`。
  // 若先看 tag 再看 typeof，它会被记成 async-function —— 快照会被数据本身骗。
  const fakeObj = { [Symbol.toStringTag]: 'AsyncFunction' };
  assert.equal(kindOf(fakeObj), 'object', '伪造 tag 的普通对象必须记 object，不能记 async-function');

  const fakeFn = Object.assign(function () {}, { [Symbol.toStringTag]: 'AsyncFunction' });
  assert.equal(kindOf(fakeFn), 'function', '伪造 tag 的普通函数必须记 function');
});

test('★★ 判据必须挡住 class 的 static toString 劫持与压缩形态（否则 class 被记成 function）', () => {
  // 实测：`String(v)` 会调用用户定义的 toString。
  const hijacked = class D { static toString() { return 'D'; } };
  assert.equal(kindOf(hijacked), 'class', 'static toString 不得让 class 降级成 function');

  // 实测：`class{}`（压缩后无空格）会让 `startsWith('class ')` 漏判。
  const compressed = new Function('return (class {})')();
  assert.equal(kindOf(compressed), 'class', '无空格的 class{} 必须仍判 class');

  assert.equal(kindOf(class {}), 'class');
  assert.equal(kindOf(class Named {}), 'class');
});

test('★ 判据对四种函数形态与值对象都要判对（含 async generator 的复合判据）', () => {
  assert.equal(kindOf(function () {}), 'function');
  assert.equal(kindOf(() => {}), 'function', 'arrow 与普通函数运行时不可区分 ⇒ 一律 function');
  assert.equal(kindOf(async function () {}), 'async-function');
  assert.equal(kindOf(async () => {}), 'async-function');
  assert.equal(kindOf(function* () {}), 'generator-function');
  assert.equal(kindOf(async function* () {}), 'async-generator-function',
    'async generator = isAsync && isGen 同时为真（单个谓词分不出来）');
  assert.equal(kindOf({}), 'object');
  assert.equal(kindOf([]), 'array');
  assert.equal(kindOf(null), 'null');
  assert.equal(kindOf('x'), 'string');
});

test('★ generatorVersion 必须能被 diff 忽略（工具升级 ≠ 公开面变化）', () => {
  const oldSnap = base();
  const newSnap = base();
  for (const pkg of ['kernel', 'plugins']) newSnap[pkg].generatorVersion = 99;
  const cls = classifyBump(oldSnap, newSnap, '1.2.0');
  assert.equal(cls.nature, 'none', 'generatorVersion 变化不得被判成公开面变化');
  assert.deepEqual([cls.removed, cls.added, cls.changed], [[], [], []]);
});

test('★ 种类判据自检：能区分 async / generator / class / 普通函数，且不误伤值对象', async () => {
  // 直接对真实模块取种类，验证判据本身（而不是只验证它输出的形状）。
  const mod = await import('../../../packages/plugins/src/isolation.mjs');
  const { buildSnapshots } = await import('../../../scripts/public-surface.mjs');
  const { plugins } = await buildSnapshots();
  const iso = plugins.exports['./isolation'];
  // 全部导出都要有种类，且与实际 typeof 自洽
  for (const [name, kind] of Object.entries(iso)) {
    const isFnLike = ['function', 'async-function', 'generator-function', 'async-generator-function', 'class'].includes(kind);
    assert.equal(isFnLike, typeof mod[name] === 'function', `${name}: 种类 ${kind} 与 typeof 不自洽`);
  }
  assert.equal(iso.IsolationCode, 'object', '值对象记 object');
});
