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

/**
 * 取一个导出值的**种类**。
 *
 * ── 为什么需要这个 ────────────────────────────────────────────────
 *   只记名字的快照对「形状变化」是瞎的：`async function f()` 改成 `function f()`
 *   在 `Object.keys()` 里一模一样，快照报「零变化」，而调用方的语义可能已经变了。
 *
 * ── 判据（逐条实测验证过）────────────────────────────────────────
 *   `Object.prototype.toString.call(v)` 能区分 async / generator，但**区分不了 class 与普通函数**
 *   （两者都是 `[object Function]`）⇒ class 靠 `String(v)` 以 `class ` 开头补判。
 *   ★ **arrow function 与普通 function 在运行时不可区分**（都是 `[object Function]`，
 *     `String(v)` 也都可能是任意形态）⇒ 刻意**不细分**，一律记 `function`。
 *     分不出的东西硬分只会产生**假变化**。
 *
 * @param {any} v 导出值
 * @returns {string} 种类标签
 */
function kindOf(v) {
  const tag = Object.prototype.toString.call(v);
  if (tag === '[object AsyncFunction]') return 'async-function';
  if (tag === '[object AsyncGeneratorFunction]') return 'async-generator-function';
  if (tag === '[object GeneratorFunction]') return 'generator-function';
  if (typeof v === 'function') return String(v).startsWith('class ') ? 'class' : 'function';
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  if (typeof v === 'object') return 'object';
  return typeof v;   // string / number / boolean / symbol / bigint / undefined
}

/** 把一个模块的导出取成 `{ 名字: 种类 }`（按名字排序） */
function exportKinds(mod) {
  const out = {};
  for (const k of Object.keys(mod).sort()) out[k] = kindOf(mod[k]);
  return out;
}

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
    exports: { '.': exportKinds(pub), './internal': exportKinds(int) },
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
  for (const e of entries) exportsMap[`./${e}`] = exportKinds(await load(`packages/plugins/src/${e}.mjs`));
  return { exports: exportsMap };
}

/**
 * 快照工件自身的格式版本。
 *
 * · **1**：`exports` 是**字符串数组**（只记名字）
 * · **2**：`exports` 是**名字 → 种类** 的对象（`{ CordiumHost: 'class', … }`）
 *
 * ★ 升版理由：种类变化（`async function` → `function`）在 v1 里**完全隐形**。
 * ★ **跨格式比较不会崩**：`collectDiff` 的 `asExportTable` 同时吃两种格式，
 *   旧版（数组）与新版（对象）比时**只比名字**（旧版种类未知 ⇒ 不判种类变化）。
 *   ⇒ 历史快照**不需要重写**，也不会因格式演进造出假的 breaking。
 */
export const SNAPSHOT_SCHEMA_VERSION = 2;

/** 生成两份快照（每包一份） */
export async function buildSnapshots() {
  return {
    kernel: { schemaVersion: SNAPSHOT_SCHEMA_VERSION, ...(await kernelSurface()) },
    plugins: { schemaVersion: SNAPSHOT_SCHEMA_VERSION, ...(await pluginsSurface()) }
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
/**
 * 把一份「导出表」规约成 `名字 → 种类` 的 Map。
 *
 * ★ **同时吃两种格式**，这是格式演进的关键：
 *   · **旧格式**（schemaVersion 1）＝`['A', 'B']` 字符串数组 ⇒ 种类记 `null`（那一版没记种类）
 *   · **新格式**（schemaVersion 2）＝`{ A: 'function', B: 'class' }`
 *   ⇒ 拿新版代码去比旧版快照时**不会崩**，也不会因为「旧版没记种类」而把每个导出都报成变化。
 *     跨格式比较时**只比名字**（种类未知就不判种类）—— 这是唯一诚实的做法：
 *     把「不知道」当成「变了」会造假的 breaking。
 *
 * ★ 只在**确认是导出表**的地方调用（见 `collectDiff` 的 `isExportTable` 判据）——
 *   不能见到对象就套，否则 `enums` / `diagnosticsStable` 这类普通对象会被误当成导出表。
 *
 * @param {any} v 导出表（数组或对象）
 * @returns {Map<string, string|null>}
 */
function asExportTable(v) {
  if (Array.isArray(v)) return new Map(v.map(x => [String(x), null]));
  return new Map(Object.entries(v ?? {}).map(([k, kind]) => [k, typeof kind === 'string' ? kind : null]));
}

function collectDiff(oldObj, newObj, pathArr, acc) {
  const oldK = oldObj && typeof oldObj === 'object' ? Object.keys(oldObj) : [];
  const newK = newObj && typeof newObj === 'object' ? Object.keys(newObj) : [];
  for (const key of new Set([...oldK, ...newK])) {
    if (key === 'schemaVersion') continue; // 本仓自己的工件版本，不属于公开面
    const o = oldObj?.[key];
    const n = newObj?.[key];
    const at = [...pathArr, key].join(' > ');

    // ★ 导出表只出现在 `exports > <入口>` 这一层 —— 用**路径**限定（`pathArr` 是父级路径，
    //   所以末项就是 `exports`）。不能「见到对象就当成导出表」，否则 enums / diagnosticsStable
    //   会被误解析成导出表、进而把「成员新增」算成「名字改了」。
    const isExportTable = pathArr[pathArr.length - 1] === 'exports';
    if (isExportTable) {
      const ot = o == null ? new Map() : asExportTable(o);
      const nt = n == null ? new Map() : asExportTable(n);
      for (const name of ot.keys()) if (!nt.has(name)) acc.removed.push({ at, name });
      for (const name of nt.keys()) if (!ot.has(name)) acc.added.push({ at, name });
      // 种类变化：只在**两边都有种类**时才判（跨格式时旧版是 null = 不知道）
      for (const [name, oldKind] of ot) {
        const newKind = nt.get(name);
        if (oldKind && newKind && oldKind !== newKind) {
          acc.changed.push({ at, name, from: oldKind, to: newKind });
        }
      }
      continue;
    }
    // ★ 普通数组（`enums > E` / `errorCodes` / `pluginContext` / `hostPrototype` …）按**集合**比，
    //   不能落进下面的递归分支 —— 数组也是 `object`，按对象递归就会拿**下标**当键，
    //   于是「枚举成员新增」被误判成 `changed`（`{at: '… > E > 1', to: 'Q'}`）而不是 `added`，
    //   进而把 additive 判成 breaking。这条是施工中实测踩到的。
    if (Array.isArray(o) || Array.isArray(n)) {
      const os = new Set(o ?? []);
      const ns = new Set(n ?? []);
      for (const x of os) if (!ns.has(x)) acc.removed.push({ at, name: x });
      for (const x of ns) if (!os.has(x)) acc.added.push({ at, name: x });
      continue;
    }
    if ((o && typeof o === 'object') || (n && typeof n === 'object')) {
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
