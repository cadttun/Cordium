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
import { buildSnapshots, classifyBump } from '../../../scripts/public-surface.mjs';

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
  assert.ok(kernel.exports['.'].includes('CordiumHost'), '内核入口清单必须含 CordiumHost');
  assert.ok(kernel.pluginContext.includes('pluginId') && kernel.pluginContext.includes('getService'),
    'ctx 扫描非空且含已知成员');
  assert.ok(kernel.errorCodes.includes('INVALID_ARGUMENT'), '错误码清单必须含已知码');
  assert.ok(plugins.exports['./loader'].includes('loadPlugins'), '插件子入口清单必须含 loadPlugins');
});

test('★ 门禁自检：比对必须能判别内容差异与增删（否则是恒真假绿）', () => {
  assert.notEqual(serialize({ x: 1 }), serialize({ x: 2 }), '值变必须可判');
  assert.notEqual(serialize({ x: 1 }), serialize({ x: 1, y: 2 }), '增键必须可判');
  assert.equal(serialize({ x: 1 }), serialize({ x: 1 }), '同内容必须相等');
});

// ── 从 diff 算 bump（分类规则）────────────────────────────────────────
const base = () => ({
  kernel: { schemaVersion: 1, exports: { '.': ['A', 'B'] }, kernelApiVersion: '1.0.0', errorCodes: ['X'], enums: { E: ['P'] } },
  plugins: { schemaVersion: 1, exports: { './loader': ['loadPlugins'] } }
});
const withKernel = mutate => { const s = base(); mutate(s.kernel); return s; };

test('★ 删导出 ⇒ breaking；≥1.0 时 bump = major（删名字是最硬的一类）', () => {
  const cls = classifyBump(base(), withKernel(k => { k.exports['.'] = ['A']; }), '1.2.0');
  assert.equal(cls.nature, 'breaking');
  assert.equal(cls.bump, 'major');
  assert.deepEqual(cls.removed, [{ at: 'kernel > exports > .', name: 'B' }]);
});

test('★ 增导出 ⇒ additive；bump = minor（向后兼容）', () => {
  const cls = classifyBump(base(), withKernel(k => { k.exports['.'].push('C'); }), '1.2.0');
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
  const broken = withKernel(k => { k.exports['.'] = ['A']; });
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
  const broken = withKernel(k => { k.exports['.'] = ['A']; });
  const added = withKernel(k => { k.exports['.'].push('C'); });
  assert.notEqual(classifyBump(base(), broken, '0.4.0').bump, classifyBump(base(), broken, '1.0.0').bump,
    'breaking 必须随版本不同（否则映射写死）');
  assert.equal(classifyBump(base(), added, '0.4.0').bump, classifyBump(base(), added, '1.0.0').bump,
    'additive 在 0.x 与 1.x 下都应是 minor');
});
