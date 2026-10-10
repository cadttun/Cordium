/**
 * @file scripts/public-surface.mjs
 * @description 生成两包的【公开面快照】—— **提交进仓的 JSON**，供跨版本 diff。
 *
 * ── 为什么要有这个 ──────────────────────────────────────────────────
 *   `packages/kernel/test/public-surface.test.mjs` 是「**半个 baseline**」：它冻结了**当前**公开面
 *   （增 / 删 / 改名即红），但**没有「上一版公开面」这个对象** ⇒ 答不了「这次改动该升哪一位」。
 *   ⇒ 把公开面抽成**提交进仓的 `public-surface.json`**（每包一份）。跨版本 `git diff` 即得公开面增量
 *     （api-extractor 的「报告入仓 + 构建比对」模型，**不引入任何工具**）。
 *
 * ── 判据来源 ────────────────────────────────────────────────────────
 *   全部**从代码取**（运行时 `Object.keys` / `Object.getOwnPropertyNames`），**不手抄** ——
 *   手抄清单会漂（本仓已踩 3 次）。门禁 = 「此刻生成的结果 == 仓内快照」，逐字节比对。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node scripts/public-surface.mjs           # 校验（不等则 exit 1，并打印差异）
 *   node scripts/public-surface.mjs --write   # 重写仓内快照（改了公开面后跑一次并提交）
 *
 * ⚠️ 只覆盖**公开面**：`index.mjs` / `internal.mjs`（内核）与六个子入口（插件）；
 *   `internal.mjs` 明确「不是公开 API」，列在这里只为**发现它自己的增删**（不是承诺）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 动态 import 本仓源码（不经包名解析，免得依赖 node_modules 布局） */
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const keys = obj => Object.keys(obj).sort();

/** 起一个最小宿主、抓 `ctx` 的成员名（`ctx.*` 是 KERNEL_API_VERSION 面的一部分） */
async function pluginContextMembers() {
  const { CordiumHost } = await load('packages/kernel/src/index.mjs');
  const host = new CordiumHost();
  let ctx = null;
  host.registerPlugin({ id: 'surface.probe', version: '1.0.0', apiVersion: '1.0.0' }, { activate(c) { ctx = c; } });
  await host.boot();
  return Object.keys(ctx).sort();
}

/** 内核包公开面 */
export async function kernelSurface() {
  const pub = await load('packages/kernel/src/index.mjs');
  const int = await load('packages/kernel/src/internal.mjs');
  return {
    exports: { '.': keys(pub), './internal': keys(int) },
    kernelApiVersion: pub.KERNEL_API_VERSION,
    errorCodes: keys(pub.ErrorCode),
    enums: {
      LifecycleState: keys(pub.LifecycleState),
      PluginKind: keys(pub.PluginKind),
      ServiceAccess: keys(pub.ServiceAccess),
      ActivationPolicy: keys(pub.ActivationPolicy),
      LogLevel: keys(pub.LogLevel),
      UnresolvedReason: keys(pub.UnresolvedReason),
      DispatchMode: keys(pub.DispatchMode)
    },
    hostPrototype: Object.getOwnPropertyNames(pub.CordiumHost.prototype).filter(n => n !== 'constructor').sort(),
    pluginContext: await pluginContextMembers(),
    diagnosticsStable: Object.keys(pub.DIAGNOSTICS_CONTRACT.stable).sort()
  };
}

/** 插件包公开面（六个子入口） */
export async function pluginsSurface() {
  const entries = ['runtime', 'ecosystem', 'catalog', 'isolation', 'loader', 'reload'];
  const exportsMap = {};
  for (const e of entries) exportsMap[`./${e}`] = keys(await load(`packages/plugins/src/${e}.mjs`));
  return { exports: exportsMap };
}

/** 生成两份快照（每包一份） */
export async function buildSnapshots() {
  return {
    kernel: { schemaVersion: 1, ...(await kernelSurface()) },
    plugins: { schemaVersion: 1, ...(await pluginsSurface()) }
  };
}

const FILES = {
  kernel: 'packages/kernel/public-surface.json',
  plugins: 'packages/plugins/public-surface.json'
};

const serialize = obj => JSON.stringify(obj, null, 2) + '\n';

async function main() {
  const write = process.argv.includes('--write');
  const snapshots = await buildSnapshots();
  const drifted = [];
  for (const [pkg, rel] of Object.entries(FILES)) {
    const abs = path.join(ROOT, rel);
    const next = serialize(snapshots[pkg]);
    if (write) {
      fs.writeFileSync(abs, next);
      console.log(`✎ 已写入 ${rel}`);
      continue;
    }
    const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (cur === null) drifted.push(`${rel} 不存在（跑 \`node scripts/public-surface.mjs --write\` 生成并提交）`);
    else if (cur.split('\r\n').join('\n') !== next) drifted.push(`${rel} 与此刻生成的结果不一致`);
  }
  if (write) return;
  if (drifted.length > 0) {
    console.error('★ 公开面快照漂移：\n' + drifted.join('\n')
      + '\n\n★ 修法：确认改动是【有意的公开面变更】后，跑 `node scripts/public-surface.mjs --write` 并一并提交。');
    process.exit(1);
  }
  console.log('✔ 公开面快照与代码一致');
}

// 仅在被直接执行时跑 main（被测试 import 时不跑）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
