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
  readOptions
} from '@cordium/kernel/internal';

// ★★★ 修复：原正则 `\d+` 会**放行前导零**（`01.0.0`），
// 而 SemVer 2.0.0 规范第 2 条明确要求：
//   "A normal version number MUST take the form X.Y.Z where X, Y, and Z are
//    non-negative integers, and MUST NOT contain leading zeroes."
//   （https://semver.org —— 第 2 条，MUST NOT）
//
// 【实测】`validatePluginManifest({version:'01.0.0'})`（旧名 validateManifest） 原实现**放行**，
//   而权威 oracle（`npm semver@7.7.4`）`compare('01.0.0', ...)` **抛
//   TypeError: Invalid Version: 01.0.0**。
//   ⇒ 这是一个 **fail-open 的校验门**：非法输入进了系统，直到比较时才炸。
//
// ⇒ 修法：把三段数字从 `\d+` 收紧为 `(0|[1-9]\d*)`（即「零」或「非零开头」）。
//   这同时对齐了 SemVer 对 prerelease 段数字标识符的同一条要求。
//
// ★ 兼容性：本仓的测试夹具与文档示例里，version **全部是 '1.0.0'** 这类
//   无前导零的写法 ⇒ 本收紧**不改变任何现有输入的行为**。
//
// ★★ prerelease 段同样要收紧（实测确认，非推测）：
//   SemVer §9 的同一条要求也适用于 prerelease 的**数字标识符** ——
//   "Numeric identifiers MUST NOT include leading zeroes."
//   【实测】权威 oracle 对 `1.0.0-01` **抛 TypeError: Invalid Version**，
//   而原来的 `[0-9A-Za-z.-]+` 会**放行**它。
//   ⇒ prerelease 改为「点分段，每段是 `0 | [1-9]\d* | 含字母的非数字标识符`」。
//
//   ⚠️ 该段正则对齐 semver.org FAQ 给出的**官方 ECMA Script 版**，但不是逐字相同。
//      差异**逐条实测**过（不是推断）：
//
//      · `[A-Za-z-]` vs 官方 `[a-zA-Z-]` —— ★ **实测完全等价**。
//        两侧的 `-` 都位于字符类**末尾**（字面量），字符集都是
//        { A-Z, a-z, - }。枚举 729 个输入比对：「我方放行但官方拒绝」= **0 个**。
//
//      · **有意收紧**：本仓**不接受 build metadata**（官方正则有 `(?:\+...)?`，本仓没有）。
//        实测 `VERSION_PATTERN.test('1.0.0+build')` = `false`，
//        而 oracle `compare('1.0.0+build','1.0.0')` **接受**。
//        ⇒ 这是**本仓的设计取舍**（manifest 版本不带 build 段），**不是**「与官方一致」。
//
// ★ 原先这里记录了两类「本层放行而 npm semver 拒绝」的已知边界
//   （数字段 > MAX_SAFE_INTEGER、串长 > 256），理由是真实输入不会出现。
//   实测它们会让 catalog 条目永久无法比较（compareSemVer 抛 TypeError），
//   现已由 parsedVersion 先过内核 `isValidSemVer`（严格规范形式）一并挡住：
//   · ✅ 前导零 / 数字段越界 / 串长 > 256 —— 拒绝（与 npm semver 一致）
//   · ⚠️ build metadata、首尾空白、`v` 前缀 —— 拒绝（有意收紧：manifest 只收规范形式）
//   ⇒ **它不是 semver 完备门，是 manifest 版本格式门。** 名字与用途都要按这个理解。
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const ID_PATTERN = PLUGIN_ID_PATTERN;   // ★ 与内核层同一份定义

// ★ 此前是独立字面量 '1.0.0'，与 KERNEL_API_VERSION 各写一份、零门禁 ⇒ 改一个忘另一个不会红，
//   而两者都用于「主版本相等」判定 ⇒ 漂移即跨层兼容性静默失守。现改为派生，结构上不可能漂移。
export const PLUGIN_API_VERSION = KERNEL_API_VERSION;

// 本文件的 assert 只守 manifest ⇒ 一律 invalid_manifest（与内核 validateManifest 同码）
function assert(condition, message) {
  if (!condition) throw new CordiumError(ErrorCode.INVALID_MANIFEST, message);
}

function clone(value) {
  return structuredClone(value);
}

function parsedVersion(value, label) {
  // ★ 先过内核的 isValidSemVer（与内核层 validateManifest 同一判定）——
  //   此前本层只靠 VERSION_PATTERN：放行超过 MAX_SAFE_INTEGER 的数字段与超长串，
  //   这类版本进了 catalog 后 compareSemVer 每次都抛 TypeError，条目无法再升级（实测）。
  assert(isValidSemVer(value), `${label} must use semver x.y.z`);
  const match = String(value || '').match(VERSION_PATTERN);
  assert(match, `${label} must use semver x.y.z`);
  return {
    base: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function version(value, label) {
  return parsedVersion(value, label).base;
}

// 版本比较：全仓唯一实现是 `kernel/src/semver.mjs` 的 `compareSemVer()`（catalog 已改用它），
// 本层不再保留自己的比较函数。
//   并使用它，而不是在插件层重写。

export function validatePluginManifest(input, options) {
  const { apiVersion = PLUGIN_API_VERSION } = readOptions(options, 'validatePluginManifest');
  assert(input && typeof input === 'object', 'plugin manifest is required');
  // ★ 必须先判类型：RegExp.test 会把参数转成字符串 ⇒ `1` / `['abc']` 都能通过，
  //   而返回值保留原类型 ⇒ catalog 排序崩溃、`['abc']` 与 `'abc'` 成为两条互不相认的记录（绕过降级检查）。
  assert(typeof input.id === 'string' && ID_PATTERN.test(input.id), 'plugin id is invalid');
  assert(typeof input.version === 'string', 'plugin version must be a string');
  assert(input.apiVersion === undefined || typeof input.apiVersion === 'string', 'plugin apiVersion must be a string');
  assert(typeof input.name === 'string' && input.name.trim(), 'plugin name is required and must be a non-empty string');
  version(input.version, 'plugin version');
  const [requiredMajor] = version(input.apiVersion || apiVersion, 'plugin apiVersion');
  const [hostMajor] = version(apiVersion, 'host apiVersion');
  assert(requiredMajor === hostMajor, 'plugin api version is incompatible');
  // ★ 类别成员校验 —— 拼错值（`'Core'`）若静默落成 business，
  //   表现是「最严格的意图落成最宽松的行为且无报错」（与内核层 access 级别同一个坑）。
  //   ⚠️ 只在【显式传值】时校验：缺省 ⇒ 走下面的默认值，不报错。
  assert(
    input.kind === undefined || input.kind === null || isValidPluginKind(input.kind),
    `plugin kind is invalid: ${String(input.kind)} (expected one of: ${PLUGIN_KIND_VALUES.join(', ')})`
  );
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
    assert(value === undefined || Array.isArray(value), `${label} must be an array`);
    const raw = value || [];
    const normalized = normalizeStringList(raw);
    assert(normalized.length === raw.length, `${label} contains empty or duplicate entries`);
    return normalized;
  };
  // 依赖映射：**归一与严格性都与内核层同一实现**。
  // ★ 类型错误抛 invalid_manifest —— 此前宽容退化为 `{}` / `'*'`，
  //   版本门禁的输入错了却 fail-open。（旧的宽容是实现遗留，不是设计决定；
  //   这里是有意的行为变更。）
  // ★ config 必须是普通对象（此前数组原样透传）。缺省 / null ⇒ {}。
  assert(input.config === undefined || input.config === null
    || (typeof input.config === 'object' && !Array.isArray(input.config)), 'plugin config must be an object');
  return {
    id: input.id,
    name: String(input.name).trim(),
    version: input.version,
    apiVersion: input.apiVersion || apiVersion,
    provides: strictList(input.provides, 'provides'),
    permissions: strictList(input.permissions, 'permissions'),
    dependencies: normalizeDependencyMap(input.dependencies, { pluginId: input.id }),
    config: input.config && typeof input.config === 'object' ? clone(input.config) : {},
    // ★ 缺省 ⇒ business（与内核层逐字一致；两层语义必须对齐，否则
    //   「内核认为是 core、插件层认为是 business」会造成按哪一层读结果就不同）
    kind: input.kind || PluginKind.BUSINESS
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
