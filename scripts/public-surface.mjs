/**
 * @file scripts/public-surface.mjs
 * @description 生成两包的【公开面快照】（提交进仓的 JSON，供跨版本 diff），并【从 diff 算出该升哪个 semver 位】。
 *
 * ── 为什么要有这个 ──────────────────────────────────────────────────
 *   `packages/kernel/test/public-surface.test.mjs` 是「半个 baseline」：冻结了**当前**公开面，但
 *   **没有「上一版公开面」这个对象** ⇒ 答不了「这次改动该升哪一位」。
 *   ⇒ 把公开面抽成**提交进仓的 `public-surface.json`**（每包一份），跨版本 `git diff` 即得公开面增量；
 *     再用 `classifyBump` 把增量**分类**成 `major / minor`（api-extractor「报告入仓 + 构建比对」模型，**不引入任何工具**）。
 *
 * ── 判据来源 ────────────────────────────────────────────────────────
 *   全部**从代码取**（运行时 `Object.keys` / `Object.getOwnPropertyNames`），**不手抄** —— 手抄清单会漂。
 *   门禁 = 「此刻生成的结果 == 仓内快照」，逐字节比对。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node scripts/public-surface.mjs           # 校验（不等则 exit 1，并打印差异 + 建议 bump）
 *   node scripts/public-surface.mjs --write   # 重写仓内快照（改了公开面后跑一次并提交）
 *   node scripts/public-surface.mjs --bump    # 只打印「当前代码 vs 仓内快照」的分类（JSON，exit 0）
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

/**
 * 内核包公开面
 *
 * ★★ 刻意**不含 `./testing`**：那一档是「公开可达、不承诺 semver」的预览面。
 *   把它算进快照 ⇒ 夹具每改一次形状，`classifyBump` 都会判成 breaking ⇒
 *   等于**给测试夹具加上了它明确不承担的承诺**。
 *   ⇒ 预览面由 `testing-surface.test.mjs` 单独钉（只钉「不泄漏到主入口」与「显式具名导出」），
 *     不参与跨版本 diff。
 */
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

// ────────────────────────────────────────────────────────────────────
// 从 diff 算 bump
// ────────────────────────────────────────────────────────────────────

/**
 * 把快照当成「名字列表的树」递归遍历，收集 增 / 删 / 改。
 * @param {any} oldObj 上一版（仓内快照）
 * @param {any} newObj 这一版（此刻代码）
 * @param {string[]} pathArr 当前路径
 * @param {{removed:object[],added:object[],changed:object[]}} acc 累加器
 */
function collectDiff(oldObj, newObj, pathArr, acc) {
  const oldK = oldObj && typeof oldObj === 'object' ? Object.keys(oldObj) : [];
  const newK = newObj && typeof newObj === 'object' ? Object.keys(newObj) : [];
  for (const key of new Set([...oldK, ...newK])) {
    if (key === 'schemaVersion') continue; // 本仓自己的工件版本，不属于公开面
    const o = oldObj?.[key];
    const n = newObj?.[key];
    const at = [...pathArr, key].join(' > ');
    if (Array.isArray(o) || Array.isArray(n)) {
      const os = new Set(o ?? []);
      const ns = new Set(n ?? []);
      for (const x of os) if (!ns.has(x)) acc.removed.push({ at, name: x });
      for (const x of ns) if (!os.has(x)) acc.added.push({ at, name: x });
    } else if ((o && typeof o === 'object') || (n && typeof n === 'object')) {
      collectDiff(o, n, [...pathArr, key], acc);
    } else if (o !== n) {
      acc.changed.push({ at, from: o, to: n });
    }
  }
}

/**
 * 比较两份快照，给出「变动的性质」与「建议的 semver 位」。
 *
 * 规则（2026 业界口径 —— oasdiff / Fern / `@clerk/break-check` 一致）：
 *   · **删**一个名字（导出 / 错误码 / 枚举成员 / 原型方法 …）或**改**一个标量（如 `kernelApiVersion`）⇒ `breaking`
 *   · **增**一个名字 ⇒ `additive`
 *   · 无变化 ⇒ `none`
 * ★ **0.x 语义**（SemVer §4「0.y.z anything MAY change」）：包版本 < 1.0.0 时，**breaking 也只要求 minor**。
 *   ⇒ `bump` 随**当前包版本**映射；`nature` 始终如实反映「会不会破坏消费者」。
 * ★ 枚举**成员新增**归 `additive`（同 `break-check`），但会出 `notes` —— 闭枚举消费者穷举 `switch` 可能漏。
 *
 * @param {any} oldSnap 上一版快照
 * @param {any} newSnap 这一版快照
 * @param {string} currentVersion 当前包版本（决定 0.x / ≥1.0 的映射）
 * @returns {{nature:string,bump:string,removed:object[],added:object[],changed:object[],notes:string[]}}
 */
export function classifyBump(oldSnap, newSnap, currentVersion) {
  const acc = { removed: [], added: [], changed: [] };
  for (const pkg of ['kernel', 'plugins']) collectDiff(oldSnap?.[pkg], newSnap?.[pkg], [pkg], acc);
  const nature = acc.removed.length || acc.changed.length ? 'breaking' : acc.added.length ? 'additive' : 'none';
  const atLeastOne = !String(currentVersion).startsWith('0.');
  const bump = nature === 'none' ? 'no_change' : nature === 'breaking' ? (atLeastOne ? 'major' : 'minor') : 'minor';
  const notes = [];
  const enumAdds = acc.added.filter(a => a.at.split(' > ').includes('enums'));
  if (enumAdds.length) notes.push(`⚠ 枚举成员新增（闭枚举消费者穷举 switch 可能漏）：${enumAdds.map(a => `${a.at} > ${a.name}`).join(', ')}`);
  return { nature, bump, ...acc, notes };
}

// ────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────

const FILES = {
  kernel: 'packages/kernel/public-surface.json',
  plugins: 'packages/plugins/public-surface.json'
};

const serialize = obj => JSON.stringify(obj, null, 2) + '\n';

/** 读仓内已提交的两份快照；缺任一 ⇒ null */
function readCommitted() {
  const out = {};
  for (const [pkg, rel] of Object.entries(FILES)) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return null;
    out[pkg] = JSON.parse(fs.readFileSync(abs, 'utf8'));
  }
  return out;
}

/** 当前包版本（决定 0.x / ≥1.0 的 bump 映射） */
function readKernelVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/kernel/package.json'), 'utf8')).version;
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const bumpOnly = argv.includes('--bump');
  const snapshots = await buildSnapshots();

  if (bumpOnly) {
    const oldSnap = readCommitted();
    if (!oldSnap) {
      console.error('★ 仓内没有 public-surface.json，先跑 `node scripts/public-surface.mjs --write`。');
      process.exit(1);
    }
    console.log(JSON.stringify(classifyBump(oldSnap, snapshots, readKernelVersion()), null, 2));
    return;
  }

  const drifted = [];
  for (const [pkg, rel] of Object.entries(FILES)) {
    const abs = path.join(ROOT, rel);
    const next = serialize(snapshots[pkg]);
    if (write) {
      fs.writeFileSync(abs, next);
      console.log(`✎ 已写入 ${rel}`);
      continue;
    }
    const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\r\n').join('\n') : null;
    if (cur === null) drifted.push(`${rel} 不存在（跑 \`node scripts/public-surface.mjs --write\` 生成并提交）`);
    else if (cur !== next) drifted.push(`${rel} 与此刻生成的结果不一致`);
  }
  if (write) return;

  if (drifted.length > 0) {
    const oldSnap = readCommitted();
    const cls = oldSnap ? classifyBump(oldSnap, snapshots, readKernelVersion()) : null;
    const advice = cls
      ? `\n\n建议 bump：${cls.bump}（性质：${cls.nature}；删 ${cls.removed.length} / 增 ${cls.added.length} / 改 ${cls.changed.length}）`
        + (cls.notes.length ? '\n' + cls.notes.join('\n') : '')
      : '';
    console.error('★ 公开面快照漂移：\n' + drifted.join('\n') + advice
      + '\n\n★ 修法：确认改动是【有意的公开面变更】后，跑 `node scripts/public-surface.mjs --write` 并一并提交。');
    process.exit(1);
  }
  console.log('✔ 公开面快照与代码一致');
}

// 仅在被直接执行时跑 main（被测试 import 时不跑）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
