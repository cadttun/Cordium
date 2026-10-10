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
import { buildSnapshots } from '../../../scripts/public-surface.mjs';

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
