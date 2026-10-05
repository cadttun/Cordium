// Strict manifest validation (descriptor layer) for plugin catalogs and markets; never executes plugin code.
// ★ 统一走 internal.mjs（不直连内核实现文件，也不走会牵出 host.mjs 的 index.mjs）
import {
  normalizeStringList, normalizeDependencyMap, isValidSemVer,
  // ★ 类别常量与成员校验 —— 与内核层【共用同一份定义】（同 normalizeStringList 的口径）
  PluginKind, PLUGIN_KIND_VALUES, isValidPluginKind, PLUGIN_ID_PATTERN,
  // ★ 两层共用唯一错误类 + 码表（原 PluginError 已并入）
  CordiumError, ErrorCode,
  // ★ 丢字段诊断与内核同一判定（path = 'plugin'）
  diffManifestFields,
  // ★ 插件契约版本 = 内核契约版本（派生，不是第二份字面量）
  KERNEL_API_VERSION,
  // 选项对象：null ⇒ 不传；非普通对象 ⇒ 带码拒绝
  readOptions,
  // ★ 快照失败时的报文要用它（错误路径上的取值工具：对抛错的 getter / Proxy 也不会再抛）
  describeError
} from '@cordium/kernel/internal';

// ★ manifest 的版本格式门由内核 `isValidSemVer`（严格规范形式）承担，本层**不再自持正则**。
//   此前这里有一份 `VERSION_PATTERN`，是在内核引入 `isValidSemVer` 之前用于收紧前导零的；
//   内核收紧后它已被**完全蕴含** —— 两百万条语料（含结构化边界集）中，
//   「isValidSemVer 通过但该正则不匹配」的反例为 0 个，第二道断言永不可达。
//   ⇒ 删掉正则与那条断言，只保留下面这段**意图说明**（规则本身没有消失，只是换了承担者）：
//
//   规则：manifest 的版本必须是**规范形式**的 SemVer ——
//     · 前导零 ⇒ 拒绝（SemVer §2 / §9：数字标识符 MUST NOT include leading zeroes）
//     · 数字段越界、串长超限 ⇒ 拒绝（否则 catalog 条目永久无法比较）
//     · build metadata、首尾空白、`v` 前缀 ⇒ 拒绝（有意收紧：manifest 只收规范形式）
//   ★ 这些全部由 `isValidSemVer` 判定，与内核层 `validateManifest` **同一实现**，
//     两层不可能漂移。
const ID_PATTERN = PLUGIN_ID_PATTERN;   // ★ 与内核层同一份定义

// ★ 此前是独立字面量 '1.0.0'，与 KERNEL_API_VERSION 各写一份、零门禁 ⇒ 改一个忘另一个不会红，
//   而两者都用于「主版本相等」判定 ⇒ 漂移即跨层兼容性静默失守。现改为派生，结构上不可能漂移。
export const PLUGIN_API_VERSION = KERNEL_API_VERSION;

// 本文件的 assert 只守 manifest ⇒ 一律 invalid_manifest（与内核 validateManifest 同码）
function assert(condition, message) {
  if (!condition) throw new CordiumError(ErrorCode.INVALID_MANIFEST, message);
}

/**
 * ★★ **聚合诊断**：收集【全部】问题再一次性报出，而不是「发现一个就抛」。
 *
 * ── 为什么 ────────────────────────────────────────────────────────
 * 逐条抛（fail-fast）的代价是**修复成本随错误数线性增长**：
 * 实测一个 6 处字段都写错的 manifest，本层要**改 5 轮**才通过 ——
 * 每轮只被告知一个问题，改完重跑才知道下一个。字段越多越痛，而 manifest
 * 恰恰是「照模板手写、容易同时错几处」的东西。
 *
 * ⇒ 一次跑完所有判定，把问题**全部**列出来（带字段名），一次性交给调用方。
 *   一次修正一轮即可完成。
 *
 * ★ 与「门禁必须早于副作用」的关系：这里不是放松校验 —— 收集期间**不产生任何副作用**，
 *   收集完仍以同一个错误码抛出。变的只是「报几条」。
 *
 * @param {string} field 出问题的字段名（或位置标记）
 * @param {string} message 该字段的问题描述
 */
class ManifestIssues {
  #list = [];
  /**
   * @param {string} field 字段名（聚合清单里用于定位）
   * @param {string} message **与此前逐字相同**的报文（既有调用方按它断言）
   */
  add(field, message) { this.#list.push({ field, message }); return this; }
  /**
   * 某字段是否【没有】问题 —— 用于决定是否继续做依赖它的后续判定。
   * ★ 按 field 判定，而不是按报文：报文措辞会随下游断言调整，field 是稳定的定位键。
   *   （此前误按报文匹配，`apiVersion` 与 `plugin apiVersion` 对不上，门形同虚设。）
   */
  ok(field) { return !this.#list.some((i) => i.field === field); }
  throwIfAny() {
    if (this.#list.length === 0) return;
    // ★ 只有一条问题时，报文与此前**逐字相同**（下游按报文断言，不能变）；
    //   多条时才展开成带字段名的清单 —— 这样「一次报全部」是纯增量。
    const detail = this.#list.length === 1
      ? this.#list[0].message
      : `plugin manifest has ${this.#list.length} problems:\n`
        + this.#list.map((i) => `  · ${i.field}: ${i.message}`).join('\n');
    throw new CordiumError(ErrorCode.INVALID_MANIFEST, detail);
  }
}

function clone(value) {
  return structuredClone(value);
}

/**
 * 版本格式判定。★ 内核 `isValidSemVer` 是**唯一**判定（与内核层 validateManifest 同一实现）——
 * 它比本层原先的正则更严：前导零 / 数字段越界 / 串长 > 256 一并挡住，
 * 这类版本进了 catalog 后 compareSemVer 每次都抛 TypeError，条目无法再升级（实测）。
 * 返回 null 表示非法（由调用方决定是抛还是记入诊断）。
 */
function parseVersionBase(value, field, label, issues) {
  if (!isValidSemVer(value)) {
    issues?.add(field, `${label} must use semver x.y.z`);
    return null;
  }
  return value.split('-')[0].split('.').map(Number);
}

// 版本比较：全仓唯一实现是 `kernel/src/semver.mjs` 的 `compareSemVer()`（catalog 已改用它），
// 本层不再保留自己的比较函数。
//   并使用它，而不是在插件层重写。

export function validatePluginManifest(input, options) {
  const { apiVersion = PLUGIN_API_VERSION } = readOptions(options, 'validatePluginManifest', ['apiVersion']);
  assert(input && typeof input === 'object', 'plugin manifest is required');
  // ★★★ 入口快照：**先把顶层字段读一次落成普通对象，之后全程只看这份快照**。
  //
  //   此前本函数直接反复读 `input.x`（config 被读 **7 次**），于是有两个后果，
  //   都是「判据与判据的使用之间隔着可再读一次的输入」这一形状：
  //     ① **TOCTOU**：带 getter 的 manifest 可以让第 1 次读返回合法值、第 7 次读返回别的值 ——
  //        实测 `config` 前 6 读给 `{a:1}`、第 7 读给 `[1,2]`，最终落库的是**数组**，
  //        突破了「config 必须是普通对象（非数组）」这道门；
  //     ② **裸错误**：getter 抛错时 `code === undefined` 漏给调用方，
  //        而本层对外承诺「只抛带码错误」。
  //
  //   ⇒ 快照一次，两个问题一起关掉。内核层 `validateManifest` 早已是这个写法，本层此前漏了。
  let m;
  try { m = { ...input }; } catch (err) {
    throw new CordiumError(ErrorCode.INVALID_MANIFEST,
      `plugin manifest could not be read: ${describeError(err)}`, { cause: err });
  }
  // ★★ 从这里开始**收集问题**而不是逐条抛 —— 见 ManifestIssues 的注释。
  //    收集期间不产生任何副作用；下方 throwIfAny() 仍以同一个码一次性报出。
  const issues = new ManifestIssues();

  // ★ 必须先判类型：RegExp.test 会把参数转成字符串 ⇒ `1` / `['abc']` 都能通过，
  //   而返回值保留原类型 ⇒ catalog 排序崩溃、`['abc']` 与 `'abc'` 成为两条互不相认的记录（绕过降级检查）。
  // ⚠️ 字段名与报文措辞都必须与改动前【逐字一致】——
  //   下游（含本仓既有测试）按这些报文断言，改措辞等于破坏契约。
  //   这里只加「字段名」这一层定位，报文本体一律保持原样。
  if (!(typeof m.id === 'string' && ID_PATTERN.test(m.id))) issues.add('id', 'plugin id is invalid');
  if (typeof m.version !== 'string') issues.add('version', 'plugin version must be a string');
  if (m.apiVersion !== undefined && typeof m.apiVersion !== 'string') issues.add('apiVersion', 'plugin apiVersion must be a string');
  if (!(typeof m.name === 'string' && m.name.trim())) issues.add('name', 'plugin name is required and must be a non-empty string');

  // 版本判定：**各自独立**收集 —— 这样 version 与 apiVersion 的问题能同时报出，
  // 而不是「先修一个再跑一遍才知道下一个」。
  if (typeof m.version === 'string') parseVersionBase(m.version, 'version', 'plugin version', issues);
  const requiredMajor = (typeof m.apiVersion === 'string' ? m.apiVersion : apiVersion);
  if (parseVersionBase(requiredMajor, 'apiVersion', 'plugin apiVersion', issues) !== null && issues.ok('apiVersion')) {
    const hostMajor = parseVersionBase(apiVersion, 'host apiVersion', 'host apiVersion', issues);
    const reqMajor = requiredMajor.split('-')[0].split('.')[0];
    if (hostMajor !== null && reqMajor !== String(hostMajor[0])) {
      issues.add('apiVersion', 'plugin api version is incompatible');
    }
  }
  // ★ 类别成员校验 —— 拼错值（`'Core'`）若静默落成 business，
  //   表现是「最严格的意图落成最宽松的行为且无报错」（与内核层 access 级别同一个坑）。
  //   ⚠️ 只在【显式传值】时校验：缺省 ⇒ 走下面的默认值，不报错。
  if (!(m.kind === undefined || m.kind === null || isValidPluginKind(m.kind))) {
    issues.add('kind', `plugin kind is invalid: ${String(m.kind)} (expected one of: ${PLUGIN_KIND_VALUES.join(', ')})`);
  }
  // ★★ 严格性门（**本层特有，刻意保留**）：列表类字段必须是数组、且不得含空串/重复项。
  //    真正的**规范化**（裁剪空白 / 去重 / 依赖映射归一）已抽到内核层共享实现 ——
  //    本层只负责「先严格校验、再调用共享规范化」。
  //
  //    ⚠️ **判据必须与改动前【逐字一致】**：`normalizeStringList` 与旧实现的内联表达式
  //       完全相同（`[...new Set(x.map(String).trim().filter(Boolean))]`），
  //       故只比长度即可。**不得额外加 `every(item => item.trim() === item)` 之类的检查** ——
  //       那会把 `[' a ']`（旧：通过并 trim 成 `['a']`）变成抛错，
  //       属于**计划外的行为变更**（曾误加，已回退）。
  const strictList = (value, label) => {
    if (!(value === undefined || Array.isArray(value))) { issues.add(label, `${label} must be an array`); return null; }
    const raw = value || [];
    const normalized = normalizeStringList(raw);
    if (normalized.length !== raw.length) { issues.add(label, `${label} contains empty or duplicate entries`); return null; }
    return normalized;
  };
  // 依赖映射：**归一与严格性都与内核层同一实现**。
  // ★ 类型错误报 invalid_manifest —— 此前宽容退化为 `{}` / `'*'`，
  //   版本门禁的输入错了却 fail-open。（旧的宽容是实现遗留，不是设计决定；
  //   这里是有意的行为变更。）
  // ★ config 必须是普通对象（此前数组原样透传）。缺省 / null ⇒ {}。
  if (!(m.config === undefined || m.config === null
    || (typeof m.config === 'object' && !Array.isArray(m.config)))) {
    issues.add('config', 'plugin config must be an object');
  }

  // ★ 严格性门的【归一化结果】在这里就取出来用，不再在下面重算一遍 ——
  //   重算会绕开这道门（曾误改成 `normalizeStringList(m.provides || [])`，
  //   空串元素因此不再被拒，被既有测试当场抓住）。
  const provides = strictList(m.provides, 'provides');
  const permissions = strictList(m.permissions, 'permissions');

  // ★ 一次报出【全部】问题（单条时措辞与此前逐字相同，多条时展开成清单）
  issues.throwIfAny();

  // ★ 走到这里 ⇒ 上面每一项都已通过（provides / permissions 必非 null）
  return {
    id: m.id,
    name: String(m.name).trim(),
    version: m.version,
    apiVersion: m.apiVersion || apiVersion,
    provides,
    permissions,
    dependencies: normalizeDependencyMap(m.dependencies, { pluginId: m.id }),
    config: m.config && typeof m.config === 'object' ? clone(m.config) : {},
    // ★ 缺省 ⇒ business（与内核层逐字一致；两层语义必须对齐，否则
    //   「内核认为是 core、插件层认为是 business」会造成按哪一层读结果就不同）
    kind: m.kind || PluginKind.BUSINESS
  };
}

/**
 * ★ 同 `validatePluginManifest`，另返回白名单重建丢掉的字段。
 *
 * 为什么是新入口而不是改返回形状：`validatePluginManifest` 的返回值已定稿，改它是破坏性变更；
 * 这里是纯增量。`diagnostic` 与内核 `diffManifestFields` 同一形状（`path: 'plugin'`），
 * 可直接交给 `host.recordManifestDiagnostic`。不丢字段时为 `null`。
 *
 * @returns {{ manifest: object, diagnostic: object|null }}
 */
export function validatePluginManifestDetailed(input, options) {
  const manifest = validatePluginManifest(input, options);
  return { manifest, diagnostic: diffManifestFields('plugin', input, manifest, manifest.id) };
}
