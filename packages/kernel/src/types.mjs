/**
 * @file packages/kernel/src/types.mjs
 * @description 通用微宿主与插件系统核心契约定义 (零业务耦合)
 */

import { isValidSemVer, compareSemVer, parseRange } from './semver.mjs';
import { CordiumError, ErrorCode } from './errors.mjs';
import { describeError } from './host-util.mjs';

/**
 * 插件生命周期状态枚举
 */
export const LifecycleState = Object.freeze({
  DISCOVERED: 'discovered',
  VALIDATED: 'validated',
  WAITING_DEPENDENCIES: 'waiting_dependencies',
  ACTIVATING: 'activating',
  ACTIVE: 'active',
  STOPPING: 'stopping',
  DISABLED: 'disabled',
  FAILED: 'failed'
});

// 一个服务名在同一作用域下只允许一个提供者，撞名即抛（已删除 `ServiceKind`，理由见 design/removed-apis.md §5）

/**
 * 服务访问级别 —— 由宿主装配层声明，插件无权决定
 *
 * 判别依据是【调用方能否自证身份】，而不是服务叫什么名字：
 * getService 内不得出现任何针对具体服务名的 if 特判。
 */
export const ServiceAccess = Object.freeze({
  PUBLIC: 'public',       // 提供者存在且 ACTIVE 即可取用
  DECLARED: 'declared',   // 额外要求：调用方 manifest.dependencies 声明了提供者插件
  SENSITIVE: 'sensitive', // 额外要求：调用方持 requiredPermission 且自身 ACTIVE
  INTERNAL: 'internal'    // 禁止插件取用，仅宿主装配路径可用
});

/**
 * ★★ 合法 access 值集（**成员校验用**）
 *
 * 为什么必须有：`ServiceAccess` 是 `Object.freeze` 的枚举，但**冻结不等于校验** ——
 * 传一个拼错的值（如 `'sensitve'`）时，`host.declareServiceContract` 的
 * `options.access || SENSITIVE` 只兜底 null/undefined，拼错值会**原样落表**；
 * 而 `#assertServiceAccess` 的三条 if 都不匹配 ⇒ **静默等同 `public`**。
 * 即：**最严格的意图落成最宽松的行为，且没有任何报错**。
 *
 * ★ 为什么是冻结【数组】而不是 Set：
 *   `Object.freeze(new Set())` 是**浅冻结** —— 它只冻结 Set 对象自身的属性，
 *   **`.add()` 仍然有效**（MDN：freeze 只作用于 immediate properties）。
 *   数组的 `Object.freeze` 才是真的挡住 push/splice。
 */
export const SERVICE_ACCESS_VALUES = Object.freeze(Object.values(ServiceAccess));

/**
 * 判断一个值是否为合法的 access 级别。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidServiceAccess(value) {
  return SERVICE_ACCESS_VALUES.includes(value);
}

/**
 * ★★ 插件类别 —— 由插件在 manifest 里【自报】，取代宿主按 ID 前缀猜。
 *
 * ── 为什么需要这个字段 ──────────────────────────────────────────────
 * 旧实现：宿主用 `id.startsWith('plugin.storage') || …`
 * **7 个前缀**判断「这是不是基础设施」。实测两个后果：
 *   ① 同一份前缀表在应用层**复制了两份**（逐字相同）；
 *   ② ★★★ **误伤** —— 一个业务插件的 id 恰好以某个基础设施前缀开头
 *      ⇒ **用户停不掉它、插件列表里也看不到它**，而它的同类插件却正常显示。
 *      **两个同类插件一个隐身一个可见。**
 *
 * ── 外部依据（三家独立来源收敛到同一做法）──────────────
 *   · **VS Code `extensionKind`** —— 官方文档逐字：「`extensionKind` is a property in the
 *     **extension manifest**. It allows extensions to specify a preferred running location.」
 *     ★ 且 VS Code 团队成员在多个仓库留下的原文明确记录：
 *     「**VS Code currently infers** that your extension is a Workspace Extension.」
 *     —— 推断是**问题**，修法就是改成显式声明。
 *     ★★ 同一段原文里的临时补丁：「*As a **temporary workaround** … we've automatically
 *     added your extension to an **internal whitelist** so that is always treated as a UI
 *     extension*」—— **与上文那张 7 前缀表同形**。
 *     ⚠️ 口径：来源只说这是 **temporary workaround**；「该白名单后来被移除」**没有逐字来源**，
 *        故本注释不写它「已废弃」（引用不得比来源说得更重）。
 *   · **OpenClaw** 插件清单 `openclaw.plugin.json` —— **可选**字段 `kind`，
 *     类型 `PluginKind | PluginKind[]`，取值例：`"memory"` / `"context-engine"`，
 *     由 `plugins.slots.*` 选中。**字段名与本处一致。**
 *     ⚠️ **口径**：官方字段表里 `kind` 的
 *        **Required 列是 `No`** —— 全表只有 `id` 与 `configSchema` 是 `Yes`。
 *        ⇒ 可引用的是「**字段名同名**」与「**取值示例**」，
 *        **不得写成「必填」**（引用不能比来源更重）。
 *   · **Hermes Agent** `plugin.yaml` —— `kind` 取 `standalone`/`backend`/`exclusive`/
 *     `platform`/`model-provider`；且它区分「**bundled（随产品分发、受信任）** vs
 *     **user-installed（需显式 opt-in）**」—— 正是这里的「基础设施 vs 业务」之分。
 *
 * ── ★ 分层：`kind` 是【事实】，「能不能被停用」是【宿主策略】────────
 *   `kind` 描述「这个插件**是什么**」—— 由插件自报（同 `manifest.provides`）。
 *   而「`core` 是否可由用户停用」是**宿主策略**，住在应用装配层。
 *   ⇒ 将来若加沙箱、要把策略移到宿主，**清单不用改**。
 *
 * ── ★ 默认值方向：缺省 ⇒ `business` ────────────────────────────────
 *   第三方插件不该因为忘了写字段就被当成核心服务**锁死**（那会让用户连卸都卸不掉）。
 *   ⚠️ 内置基础设施插件若漏写 `kind` 会落成 business —— 内核不替你兜底，
 *   上层装配层应自行做「内置清单 ↔ kind」一致性检查。
 *
 * ⚠️ 与 `ServiceAccess` 同一个坑：**冻结不等于校验** —— 拼错值（如 `'Core'`）
 *   会静默落成最宽松的 `business`。故配 `isValidPluginKind` 并在 validateManifest 里抛错。
 */
export const PluginKind = Object.freeze({
  /** 基础服务：随产品分发、受信任、**不作为普通外挂业务插件被停用** */
  CORE: 'core',
  /** 业务插件（默认）：作者可自由启停 */
  BUSINESS: 'business'
});

/** ★ 合法 kind 值集（成员校验用；同 `SERVICE_ACCESS_VALUES` 的口径） */
export const PLUGIN_KIND_VALUES = Object.freeze(Object.values(PluginKind));

/**
 * 判断一个值是否为合法的插件类别。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidPluginKind(value) {
  return PLUGIN_KIND_VALUES.includes(value);
}

/**
 * ★★ Manifest 字段表（**两套 schema 共享的单一事实来源**）
 *
 * 为什么必须有这张表：
 *   本项目有【两套】`validateManifest`（内核运行时契约 / 插件描述符契约），
 *   它们服务不同层次、**允许字段集不同**（例如内核版要 `optionalDependencies`
 *   做拓扑、插件版要 `name`/`config`），但**此前各自手写白名单** ——
 *   漏列一个字段就**静默丢弃**，本项目已因此踩过两次
 *   （`optionalDependencies` / `optionalProvider`），**每次都靠人肉发现**。
 *
 * 依据（Martin Fowler《Tolerant Reader》，逐字）：
 *   「**make sure there's only one bit of code that reads data payloads like this**」
 *   ⇒ 「读同一类载荷的代码只应有一处」—— 本表 + `diffManifestFields()` 即该处。
 *
 * ⚠️ 本表**只声明字段归属**，不改变任何现有校验行为（零行为变更）。
 *
 * ★★ 本表**不直接驱动**重建逻辑，也不升级为带归一化器的 schema。
 *   · 归一化本该是独立的一层（parse → validate → **normalize** → execute），
 *     `normalizeStringList` / `normalizeDependencyMap` 本来就是 JS 函数；
 *     把「怎么归一化」编码进表 = 在 JS 上造一个弱化版的 JS（inner-platform effect，公认反模式），
 *     且两层的严格性刻意不同（内核宽松 / 插件层严格），表会变成第二个校验器。
 *   · 漂移由两条门禁挡住（`service-contract.test.mjs`）：
 *     一条查「validator 实际产出的键 == 表」；一条查「每层每个字段收到畸形值都被归一化或 fail-loud」。
 *     `defaultsOnly` 另由一条断言「省略时输出里必有值」—— 表里没有无人检查的格子。
 */
export const MANIFEST_FIELD_TABLE = Object.freeze({
  /** 内核运行时契约：host.registerPlugin 走的 schema */
  kernel: Object.freeze([
    'id', 'version', 'apiVersion', 'displayName', 'description',
    'provides', 'dependencies', 'optionalDependencies', 'permissions', 'restartRequired',
    // ★ 插件类别 —— 取代宿主按 ID 前缀猜「这是不是基础设施」
    'kind'
  ]),
  /** 插件描述符契约：插件加载器 / catalog / ecosystem 走的 schema */
  plugin: Object.freeze([
    'id', 'name', 'version', 'apiVersion',
    'provides', 'permissions', 'dependencies', 'config',
    // ★ 两层共用同一份内置 manifest ⇒ 两层都必须承认它，
    //   否则会被 diffManifestFields 报成「跨层字段」（可见但不该报警的噪音）。
    'kind'
  ]),
  /**
   * 带默认值的可选字段：输入里没有、输出里必有。
   * ⇒ 计算「被丢弃字段」时**不得把它们报成问题**（否则是误报）。
   */
  defaultsOnly: Object.freeze(['displayName', 'description', 'restartRequired'])
});

/**
 * ★★ 规范化字符串列表（**两层 schema 共享的单一实现**）
 *
 * 依据：Fowler《Tolerant Reader》「make sure there's only one bit of code that
 * reads data payloads like this」+ Hunt & Thomas DRY
 * （「every piece of knowledge must have a single, unambiguous, authoritative
 * representation」——**DRY 管的是知识，不是文本**）。
 *
 * 本函数是「**列表类字段的 canonical 形状**」这**一条知识**的唯一落点：
 * 裁剪空白、丢弃空串、去重 —— 与插件层 `runtime.mjs` 的既有语义**逐字一致**。
 *
 * ⚠️ **不含严格性**：非数组一律返回 `[]`（**内核层刻意宽松**）。
 * 插件层保留自己的 `assert` 严格门 —— 那是**刻意的分层差异**，不属本函数职责。
 *
 * @param {any} value
 * @returns {string[]}
 */
export function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

/**
 * ★★ 规范化依赖映射（**两层 schema + ecosystem 共享的单一实现**）
 *
 * 支持两种输入形状（**这是 ecosystem.mjs 自陈的对外契约**）：
 *   · `Array`  —— `['plugin.a']`          ⇒ `{ 'plugin.a': '*' }`
 *   · `Object` —— `{ 'plugin.a':'^1' }`   ⇒ 原样（键值均裁剪空白，空范围取 `'*'`）
 *
 * ⚠️ **本函数修掉一个静默数据损坏**：
 *   此前内核层写的是 `typeof x === 'object' ? { ...x } : {}`，
 *   而 **`typeof [] === 'object'`**（【官方】MDN《Spread syntax》：对象展开会枚举
 *   数组的下标属性，`{...['a']}` ⇒ `{ 0: 'a' }`）⇒ **数组被静默展开成 `{0:'a'}`**
 *   ⇒ `boot()` 抛 `Missing dependency '0'`，且鉴权快照 `pluginDependencies`
 *   被污染成 `Set(['0'])`，导致**合法的数组写法伪装成 `Security Violation`**。
 *
 * ⚠️ **类型错误一律抛 `invalid_manifest`**（内核层 / 插件层 / ecosystem 三处入口同一判定）。
 *
 * @param {any} value
 * @returns {Record<string,string>}
 */
/**
 * ★ 以【自有属性】写入 —— `obj['__proto__'] = x` 在普通对象上是改原型而不是写键，
 *   依赖名为 `__proto__` 时会被静默吞掉（实测）。defineProperty 让它成为普通键，
 *   随后由依赖检查响亮地报「Missing dependency '__proto__'」。
 */
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

export function normalizeDependencyMap(value, { field = 'dependencies', pluginId = null } = {}) {
  // ★ 类型错误一律抛 invalid_manifest（此前宽容退化：`{ p: 2 }` ⇒ `'*'` 任意版本放行、
  //   `'oops'` ⇒ `{}` 依赖整体消失、数组里的非字符串项被静默丢掉 —— 版本门禁的输入错了却 fail-open）。
  //   只拒【类型】：空串 / 纯空白仍按「未写」处理（范围 ⇒ `'*'`，与 npm 一致；数组项 ⇒ 跳过）。
  const fail = detail => new CordiumError(ErrorCode.INVALID_MANIFEST, `${field} ${detail}`, { pluginId });
  if (value === undefined || value === null) return {};
  if (Array.isArray(value)) {
    const result = {};
    for (const dep of value) {
      if (typeof dep !== 'string') throw fail(`entries must be strings, got ${typeof dep}`);
      if (dep.trim()) setOwn(result, dep.trim(), '*');
    }
    return result;
  }
  if (typeof value === 'object') {
    const result = {};
    for (const [key, range] of Object.entries(value)) {
      if (typeof range !== 'string') throw fail(`range for '${key}' must be a string, got ${typeof range}`);
      // ★ 范围字符串本身也要合法 —— 此前 `'>>>x'` / `'latest'` 能注册，到 boot 才报成
      //   dependency_version_mismatch（指向提供者），真因是依赖方 manifest 写错了。
      //   parseRange 与 satisfiesSemVer 同一套语法（npm semver 默认模式），不另写一份判定。
      const trimmed = range.trim() || '*';
      try {
        parseRange(trimmed);
      } catch (err) {
        throw new CordiumError(ErrorCode.INVALID_MANIFEST,
          `${field} range for '${key}' is not a valid SemVer range: '${range}'`, { pluginId, cause: err });
      }
      if (key.trim()) setOwn(result, key.trim(), trimmed);
    }
    return result;
  }
  throw fail(`must be an object or an array, got ${typeof value}`);
}

/**
 * ★★ 通用判定：**白名单重建**中被丢弃的字段 —— 【这条知识的唯一落点】。
 *
 * 依据：Fowler《Tolerant Reader》「make sure there's only one bit of code that reads
 * data payloads like this」+ Hunt & Thomas DRY
 * （「every piece of knowledge must have a single, unambiguous, authoritative
 * representation」——**DRY 管的是知识，不是文本**）。
 *
 * 「**输入里有、输出里没有 ⇒ 那就是被白名单丢掉的**」是**一条知识**。
 * 本项目有**两处**白名单重建（manifest 两层 schema / 服务契约字段），
 * 此前只有 manifest 那处接了这个判定 —— 契约那处**静默丢弃且无任何报错**（实测）。
 * ⇒ 抽成本函数，两处共用。
 *
 * ★ 判据严格限定为「**输入里有、输出里没有**」——
 *   不能反着算，否则带默认值的字段（如 `displayName`）会被误报。
 *
 * ★ **不丢字段时返回 `null`** ⇒ 调用方据此跳过，**正常路径零开销**。
 *
 * @param {any} input 原始输入
 * @param {any} output 白名单重建后的结果
 * @returns {string[]|null} 被丢弃的字段名；无丢弃时为 `null`
 */
export function diffWhitelistFields(input, output) {
  if (!input || typeof input !== 'object' || !output || typeof output !== 'object') return null;
  const known = new Set(Object.keys(output));
  const dropped = Object.keys(input).filter((k) => !known.has(k));
  return dropped.length === 0 ? null : dropped;
}

/**
 * 计算**服务契约**在**白名单重建**中被丢弃的字段。
 *
 * ★ 与 `diffManifestFields` 共用 `diffWhitelistFields` —— 同一条知识不写两遍。
 *
 * ★★ **为什么不另建一张「合法键集」常量**（施工中推翻的原设计）：
 *   判据取自 `Object.keys(record)` —— 即**契约记录的实际形状**。
 *   若再维护一张键集常量，就多出**第二个真相源**：记录里加了字段而常量没跟，
 *   或常量写了而记录没接，两种漂移都会重新制造「声明了却不生效」。
 *   ⇒ 直接以**实际输出**为准，**结构上不可能漂移**（同丢字段诊断的设计口径）。
 *
 * ⚠️ 契约场景【没有】「跨层字段」这个概念（不像 manifest 有两套 schema），
 *   所以全部丢弃字段一律 `warn`。
 *
 * @param {string} serviceName 用于诊断归属
 * @param {object} input 调用方传入的 options
 * @param {object} output 白名单重建后的契约记录
 * @returns {null|{path:string, pluginId:string, fields:string[],
 *                 unknownFields:string[], crossLayerFields:string[], severity:string}}
 */
export function diffServiceContractFields(serviceName, input, output) {
  const dropped = diffWhitelistFields(input, output);
  if (!dropped) return null;
  return {
    path: 'service-contract',
    // ★ 本字段是【归属槽】：manifest 场景填插件 ID，契约场景填服务名
    //   （契约由宿主声明，没有插件归属 —— 见 declareServiceContract 的注释）。
    pluginId: String(serviceName || ''),
    fields: dropped,
    unknownFields: dropped,
    crossLayerFields: [],
    // 契约没有「另一层的合法字段」这回事 ⇒ 一律 warn
    severity: 'warn'
  };
}

/**
 * 计算 Manifest 在**白名单重建**中被丢弃的字段。
 *
 * ★ 判据严格限定为「**输入里有、输出里没有**」——
 *   不能反着算，否则 `displayName` 等带默认值字段会被误报（见 `defaultsOnly`）。
 *
 * ★★ **按「是否真未知」分级**：
 *
 *   原实现把所有「本层不保留」的字段一律报 `warn` ⇒ **对真实内置插件【全部误报】**
 *   （实测 6/6：内置 manifest 两层共用，插件层不保留 `displayName`/`description`，
 *   但**内核层保留着** ⇒ 字段**根本没丢**）。
 *
 *   ⇒ 现在分两类：
 *   · **`unknownFields`** —— **两层字段表都不认**（拼写错误 / 更新的 schema）
 *     ⇒ `severity: 'warn'`（**这才是丢字段诊断要抓的**）
 *   · **`crossLayerFields`** —— **属于另一层的合法字段**（共享 manifest 的正常现象）
 *     ⇒ `severity: 'info'`（**可见但不报警**）
 *
 * ⚠️ **不采用「按入口是否双层」的开关**：同一个入口在不同装配路径下层次不同，
 *   函数自身无法知道；而按【字段归属】分级**无需调用方提供额外信息**。
 *
 * @param {'kernel'|'plugin'} path 该次校验属于哪一层 schema
 * @param {object} input 原始输入
 * @param {object} output 白名单重建后的结果
 * @param {string} [pluginId] 用于诊断归属（缺失时回退 `input.id`）
 * @returns {null|{path:string, pluginId:string, fields:string[],
 *                 unknownFields:string[], crossLayerFields:string[], severity:string}}
 *          无丢弃字段时返回 `null`（调用方据此跳过，零开销）
 */
export function diffManifestFields(path, input, output, pluginId) {
  // ★ 通用判定已抽到 `diffWhitelistFields`（见其说明）—— 本函数只保留 manifest 特有的分级。
  //   ⚠️ 公开签名与返回值**逐字节不变**：三个插件层/内核调用方与既有测试不受影响。
  const dropped = diffWhitelistFields(input, output);
  if (!dropped) return null;

  const otherLayer = path === 'kernel' ? MANIFEST_FIELD_TABLE.plugin : MANIFEST_FIELD_TABLE.kernel;
  const unknownFields = dropped.filter((k) => !otherLayer.includes(k));
  const crossLayerFields = dropped.filter((k) => otherLayer.includes(k));

  return {
    path,
    pluginId: String(pluginId || input.id || ''),
    fields: dropped,
    unknownFields,
    crossLayerFields,
    // ★ 只有「两层都不认」才是真问题；跨层字段是共享 manifest 的正常现象
    severity: unknownFields.length > 0 ? 'warn' : 'info'
  };
}

/** 内核插件 API 版本：插件 manifest.apiVersion 的主版本必须与之相同 */
export const KERNEL_API_VERSION = '1.0.0';

/** 插件 id 字符集（与插件层 runtime.mjs 的 ID_PATTERN 同一规则） */
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * 校验 Manifest 合法性
 * @param {any} manifest
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new CordiumError(ErrorCode.INVALID_MANIFEST, 'Plugin manifest must be an object');
  }
  // ★ manifest 来自插件模块，可以是带 getter 的对象或 Proxy ——
  //   ① getter / ownKeys 抛错此前原样漏出（无码的裸 Error）；
  //   ② getter 每次读返回不同值：校验时读到合法 id，重建输出时再读就换成了别的（先查后用）。
  //   ⇒ 先把顶层字段【读一次】落成普通对象，之后只看这份快照；读取或校验中的任何非 CordiumError 一律转 invalid_manifest。
  let snapshot;
  try {
    snapshot = { ...manifest };
  } catch (err) {
    throw new CordiumError(ErrorCode.INVALID_MANIFEST, `Plugin manifest could not be read: ${describeError(err)}`, { cause: err });
  }
  try {
    return validateManifestSnapshot(snapshot);
  } catch (err) {
    if (err instanceof CordiumError) throw err;
    throw new CordiumError(ErrorCode.INVALID_MANIFEST, `Plugin manifest is malformed: ${describeError(err)}`, { cause: err });
  }
}

function validateManifestSnapshot(manifest) {
  if (!manifest.id || typeof manifest.id !== 'string') {
    throw new CordiumError(ErrorCode.INVALID_MANIFEST, 'Plugin manifest missing required string field: id');
  }
  // ★ 内核层此前只查「非空字符串」，比插件层还宽 —— 两层严格性方向相反。
  //   现与插件层对齐：id 字符集、version 必须是合法 SemVer、apiVersion 主版本必须兼容。
  //   （id 字符集同时挡住 `__proto__` 这类键名，以及含空格 / 分隔符的撞键 id。）
  if (!PLUGIN_ID_PATTERN.test(manifest.id)) {
    throw new CordiumError(ErrorCode.INVALID_MANIFEST, `Plugin id '${manifest.id}' is invalid (expected lowercase segments joined by . _ -)`);
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    throw new CordiumError(ErrorCode.INVALID_MANIFEST, `Plugin ${manifest.id} missing required string field: version`);
  }
  if (!isValidSemVer(manifest.version)) {
    throw new CordiumError(ErrorCode.INVALID_MANIFEST, `Plugin ${manifest.id} version '${manifest.version}' is not valid SemVer`);
  }
  if (!manifest.apiVersion || typeof manifest.apiVersion !== 'string') {
    throw new CordiumError(ErrorCode.INVALID_MANIFEST, `Plugin ${manifest.id} missing required string field: apiVersion`);
  }
  if (!isValidSemVer(manifest.apiVersion)
      || compareSemVer(`${manifest.apiVersion.split('.')[0]}.0.0`, `${KERNEL_API_VERSION.split('.')[0]}.0.0`) !== 0) {
    throw new CordiumError(ErrorCode.INCOMPATIBLE_API_VERSION,
      `Plugin ${manifest.id} targets apiVersion '${manifest.apiVersion}', incompatible with kernel API ${KERNEL_API_VERSION}`
    );
  }

  // ★ 类别成员校验 —— 必须在【写表之前】抛错，理由同 access 级别：
  //   拼错值（`'Core'` / `'infra'`）若静默落成 `business`，表现是
  //   「**最严格的意图落成最宽松的行为，且没有任何报错**」（与 ServiceAccess 同一个坑）。
  //   只在【显式传值】时校验：缺省 ⇒ 走下面的默认值，不报错。
  if (manifest.kind !== undefined && manifest.kind !== null && !isValidPluginKind(manifest.kind)) {
    throw new CordiumError(ErrorCode.INVALID_MANIFEST,
      `Plugin ${manifest.id} declares unknown kind '${String(manifest.kind)}' `
      + `(expected one of: ${PLUGIN_KIND_VALUES.join(', ')})`
    );
  }

  // ★ 展示类字段显式传了非字符串 ⇒ 响亮失败（此前原样透传，下游按字符串用时才炸）。
  //   缺省 / null / 空串仍走默认值（与依赖字段同一口径：只拒【类型】）。
  for (const field of ['displayName', 'description']) {
    const v = manifest[field];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw new CordiumError(ErrorCode.INVALID_MANIFEST,
        `Plugin ${manifest.id} ${field} must be a string, got ${Array.isArray(v) ? 'array' : typeof v}`);
    }
  }

  return {
    id: manifest.id,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    displayName: manifest.displayName || manifest.id,
    description: manifest.description || '',
    // ★★ 列表/依赖类字段改用【两套 schema 共享】的规范化器（见文件上方两个函数的注释）。
    //    此前内核层各自手写 —— 与插件层语义不一致（不去重、不裁剪空白），
    //    且 `dependencies` 的 `{...x}` 会把【数组静默展开成 `{0:'a'}`】。
    provides: normalizeStringList(manifest.provides),
    dependencies: normalizeDependencyMap(manifest.dependencies, { pluginId: manifest.id }),
    // 可选依赖：缺失不报错、不参与拓扑（存在时才参与）。
    // ⚠️ 本函数是【白名单重建】—— 此处未列出的键会被静默丢弃，
    //    因此 manifest 里写了 optionalDependencies 却漏了这一行，声明就会凭空消失。
    optionalDependencies: normalizeDependencyMap(manifest.optionalDependencies, { field: 'optionalDependencies', pluginId: manifest.id }),
    permissions: normalizeStringList(manifest.permissions),
    restartRequired: Boolean(manifest.restartRequired),
    // ★ 缺省 ⇒ business（第三方插件不该因忘写字段就被锁死；内置插件的一致性由上层装配层检查）
    kind: manifest.kind || PluginKind.BUSINESS
  };
}
