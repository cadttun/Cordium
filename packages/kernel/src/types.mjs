/**
 * @file packages/kernel/src/types.mjs
 * @description 通用微宿主与插件系统核心契约定义 (零业务耦合)
 */

import { isValidSemVer, compareSemVer, parseRange } from './semver.mjs';
import { CordiumError, ErrorCode } from './errors.mjs';
import { describeError } from './host-util.mjs';

/**
 * 插件生命周期状态枚举
 *
 * ★ 删除了 `VALIDATED` / `WAITING_DEPENDENCIES`：**死枚举**（零赋值点、零测试断言、零下游使用，
 *   随首次提交一起带进来的残留）。删前已实测全仓无外部按字符串断言。
 *
 * ★ 新增 `READY`：已登记、依赖齐备、**等待被触发**（按需激活，见 `manifest.activation`）。
 *   ⚠️ **不复用**被删的那两个名字：它们说的是「校验过」「等依赖」，而本态的语义是
 *   「**已就绪、等触发**」—— 名字对不上语义就是下一个坑。
 */
export const LifecycleState = Object.freeze({
  DISCOVERED: 'discovered',
  /** 已登记、依赖满足，等待被触发（`manifest.activation === 'lazy'`） */
  READY: 'ready',
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
  // 入参是 unknown，而值集是具体字面量联合 ⇒ 用 unknown 视图比较（值集本身不变）
  return /** @type {readonly unknown[]} */ (SERVICE_ACCESS_VALUES).includes(value);
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
  // 入参是 unknown，而值集是具体字面量联合 ⇒ 用 unknown 视图比较（值集本身不变）
  return /** @type {readonly unknown[]} */ (PLUGIN_KIND_VALUES).includes(value);
}

/**
 * ★★ 审计日志级别 —— **固定集**。
 *
 * ── 为什么必须固定，不能像 `ui.type` 那样走注册制 ──────────────────
 *   内核**自己**按 level 分流：`error` 级会【另存一份】到 `recentErrors`
 *   （500 槽的共享环形缓冲会被话多的 info 插件冲掉，而「出过事」是永久证据），
 *   并且【只对 error 级抓栈】。这两件事都写死在 `log()` 里 ⇒
 *   内核**必须**知道全部合法值，不能把这套语义交出去。
 *   （对照 `ui.type`：内核只存不解释，值集属消费者 ⇒ 走注册制。**分层不同，做法不同。**）
 *
 * ── 实测的坑（本文件第三次同形）──────────────────────────────────
 *   `log('Error')` / `log('err')` / `log('fatal')` 此前**全部照收**：
 *   · 不进 `recentErrors` —— **出错证据从诊断里消失**；
 *   · 不带栈（抓栈只认 `level === 'error'`）；
 *   · **零报错**。
 *   ⇒ 「拼错值静默落成最宽松的那个」，与 `ServiceAccess` / `PluginKind` 同一个坑。
 *
 * ★ `debug` 是既有实践，不是新增能力：本内核的**下游应用**已在用 `ctx.log('debug', …)`，
 *   今天靠「宽容照收」才没炸。纳入合法集后它成为**契约**。
 */
export const LogLevel = Object.freeze({
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error'
});

/** ★ 合法日志级别值集（成员校验用） */
export const LOG_LEVEL_VALUES = Object.freeze(Object.values(LogLevel));

/**
 * 判断一个值是否为合法的日志级别。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidLogLevel(value) {
  // 入参是 unknown，而值集是具体字面量联合 ⇒ 用 unknown 视图比较（值集本身不变）
  return /** @type {readonly unknown[]} */ (LOG_LEVEL_VALUES).includes(value);
}

/**
 * ★★ 激活时机 —— `eager`（缺省）在 `boot()` 时激活；`lazy` 登记后停在 `ready`，等触发。
 *
 * ★ 为什么只有一个开关，**没有 `activationEvents: [...]` 清单**：
 *   本内核的触发点只有两类 —— **显式** `host.activatePlugin(id)` 与**首次派发同名 action**。
 *   而 action 名**无法从 manifest 推导**（它是在 `activate` 里 `ctx.registerAction` 登记的），
 *   所以「声明一串事件名」**没有任何东西会去消费它** —— 一个无人消费的声明就是一句空话。
 *   ⇒ 与 VS Code 1.74 起「由 `contributes` 隐式推导 activationEvents」是**同一方向**：少声明、多推导。
 *
 * ★★ 触发点为什么不能接在**服务取用**或**事件派发**上（这是设计里最硬的一条约束）：
 *   `getService` 与 `emit` / `waterfall` 都是**同步返回**的，
 *   而激活是异步的（`activate` 可以是 async、有超时）。把激活挂上去就得把这些 API 改成 async
 *   —— 那等于换一个框架。**不是取舍，是无解。**
 *   对照：OSGi 能靠「类加载 / 服务请求」驱动懒激活（Java 的类加载可被阻塞等待）；
 *   VS Code 能靠 `onCommand`（它的扩展宿主本就是异步消息通道）。**形态不同，不能照抄。**
 *
 * ★ 缺省值方向：缺省 ⇒ `eager` —— **现有行为逐字不变**，不写这个字段的插件一律照旧在 boot 时激活。
 */
export const ActivationPolicy = Object.freeze({
  /** 缺省：`boot()` 时激活 */
  EAGER: 'eager',
  /** 登记后停在 `ready`，被显式激活或首次派发同名 action 时激活 */
  LAZY: 'lazy'
});

/** ★ 合法 activation 值集（成员校验用） */
export const ACTIVATION_POLICY_VALUES = Object.freeze(Object.values(ActivationPolicy));

/**
 * 判断一个值是否为合法的激活时机。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidActivationPolicy(value) {
  // 入参是 unknown，而值集是具体字面量联合 ⇒ 用 unknown 视图比较（值集本身不变）
  return /** @type {readonly unknown[]} */ (ACTIVATION_POLICY_VALUES).includes(value);
}

/**
 * `unresolvedDependencies[].reason` 的**取值集合**（诊断快照的稳定面字段）。
 *
 * ★ 为什么要导出它：快照里这个字段此前是**纯字面量**，消费方想知道「我认全了没有」
 *   只能跨仓读实现或暴力探测 —— 两条路都不干净。同类的 `LifecycleState` / `PluginKind`
 *   早就导出了，唯独它没有。
 *
 * ★ 导出之后**实现必须回改成本常量**（`host.mjs` 的产出点与比较点）。
 *   否则导出物与实现各说各话 —— 那就是**第二真相源**，本仓栽过两次的坑。
 *   `UNRESOLVED_REASON_VALUES` 由本对象**派生**（`Object.values`），不是另抄一份。
 *
 * ★ 四类的分工（详见 `host.mjs` 的产出点）：
 *   · `missing` / `version_mismatch` —— 与 `boot()` 的拒绝**同源**；
 *   · `cycle` / `not_running` —— **不会**让 `boot()` 抛错，回答的是「它为什么没起来」。
 */
export const UnresolvedReason = Object.freeze({
  /** 依赖根本没登记 */
  MISSING: 'missing',
  /** 登记了，但版本范围不满足 */
  VERSION_MISMATCH: 'version_mismatch',
  /** 与这个依赖**互相**可达 ⇒ 拓扑排序必然失败 */
  CYCLE: 'cycle',
  /** 依赖在、版本也对，但**此刻它跑不起来**（等触发的懒插件 / 被停用 / 已失败 / 被上游的环挡住） */
  NOT_RUNNING: 'not_running'
});

/** ★ 合法 reason 值集（由 `UnresolvedReason` 派生，不另抄） */
export const UNRESOLVED_REASON_VALUES = Object.freeze(Object.values(UnresolvedReason));


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
    'provides', 'dependencies', 'optionalDependencies', 'permissions', 'hotReload',
    // ★ 插件类别 —— 取代宿主按 ID 前缀猜「这是不是基础设施」
    'kind',
    // ★ 激活时机（'eager' 缺省 / 'lazy' 按需）
    'activation'
  ]),
  /**
   * 插件描述符契约：插件加载器 / catalog / ecosystem 走的 schema
   *
   * ★★ 已删除 `config` —— 它此前被校验、被克隆产出，但**零读取路径**
   *   （内核字段表也不认它），插件作者写了默认配置却永远拿到 `{}`。
   *   联网对标：VS Code / OSGi / cordis / OpenClaw 无一家在清单里放「裸默认配置对象」，
   *   主流形态是「schema + 用户覆盖 + 合并」（cordis 的默认值写在插件代码的 schema 里，
   *   清单只放覆盖值）；唯一相近的 npm `config` 面向脚本环境变量，不是插件运行时。
   *   ⇒ 留一个永不生效的字段会**误导未来的实现**（让人以为 config 已经有位置了）。
   *   ⚠️ **加载清单的 `entry.config`（`loadPlugins` 的 `config:`）不受影响** ——
   *   那才是真正生效的配置来源，语义清晰。
   */
  plugin: Object.freeze([
    'id', 'name', 'version', 'apiVersion',
    'provides', 'permissions', 'dependencies',
    // ★ 两层共用同一份内置 manifest ⇒ 两层都必须承认它，
    //   否则会被 diffManifestFields 报成「跨层字段」（可见但不该报警的噪音）。
    'kind',
    'activation'
  ]),
  /**
   * 带默认值的可选字段：输入里没有、输出里必有。
   * ⇒ 计算「被丢弃字段」时**不得把它们报成问题**（否则是误报）。
   */
  defaultsOnly: Object.freeze(['displayName', 'description', 'hotReload'])
});

/**
 * 诊断快照的结构版本：**稳定面**发生不兼容改动时递增（增字段不算）。
 */
const DIAGNOSTICS_SCHEMA_VERSION = 1;

/**
 * ★★ 诊断快照的**稳定性契约**（唯一真相源）—— `getDiagnostics()` 的哪一部分可以依赖。
 *
 * ── 为什么必须显式表态 ────────────────────────────────────────────
 *   `getDiagnostics()` 此前**从没有文档说它稳定还是不稳定**，而消费方**已经在读它**
 *   （实测消费方 **9 个真调用点**：读 `plugins` / `totalPlugins`，把记录**当 manifest 用**、
 *    用字符串字面量 `record.state === 'active'` 判活跃）。
 *   ⇒ 内核随手改个字段名，消费方**静默失灵**，而且无从追责。
 *
 * ── 为什么是【分区】而不是「全都稳定」或「全都不稳定」────────────────
 *   联网先例两边都有，且都成体系：
 *     · **Kubernetes 指标**（官方页逐字）：Stable 承诺「observe **strict API contracts** and
 *       **no labels can be added or removed**」／Beta「observe a **looser** API contract…
 *       labels **can be added** while in beta」／Alpha「**do not have any API guarantees**.
 *       These metrics must be used at your own risk」。★ **三档同页并列**，正是本仓「分区」的形态来源。
 *     · **OpenTelemetry 语义约定**：Development（旧称 Experimental）/ **release_candidate** / Stable，
 *       且用**独立子入口**划线 —— 「The "incubating" entry-point … **is NOT subject to the
 *       restrictions of semantic versioning and MAY contain breaking changes in minor releases.**」
 *     · **k6**：allowlist 措辞（逐字）—— 「This document serves as an explicit allow list policy.
 *       **Only APIs specifically mentioned within this document are covered by our stability
 *       guarantees.** Any API not explicitly included is not covered by this policy and
 *       **may be subject to breaking changes.**」
 *   ⇒ 本仓取 **allowlist 形态**（最省事、最诚实）：**点名即承诺，没点名的一律不承诺**。
 *
 * ★★ 上面三条各给了一半，**强制性那一半来自另一处**（此前误记在 k6 名下）：
 *   k6 的 allowlist 只说「没点名的不覆盖」，**不含「没点名就报错」**。
 *   「必须显式选边、否则门禁变红」这一半的依据是 **API Extractor**（官方逐字）：
 *   「API Extractor uses release tags to track the maturity of your API. **By default, it
 *   requires every declaration in your API to have a release tag.**」——
 *   其官方文档把理由写得比本仓还清楚：「When adding a new API, choosing a release tag requires
 *   the person to **stop and think about visibility**」。
 *   ⇒ 本仓 = **k6 的 allowlist 语义 + API Extractor 的强制分类**，两者缺一不可：
 *     只有 allowlist ⇒ 新字段静默「不被承诺」，没人需要做决定；只有强制分类 ⇒ 没有「不承诺」这一档。
 *
 * ⚠️ **一处已撤回的引用**：此前这里引过一句英文，声称是 `kubectl describe` 的原文。
 *   独立复核（含本仓自查）在 **kubernetes.io 一手页面找不到那句话** —— 它只出现在第三方转述里。
 *   意思在 K8s 官方确有（机器读 `-o json`、人读文本），但**那句英文不是官方原文**，
 *   ⇒ 按「引用不得比来源更重」删掉，不拿二手转述冒充满一手引文。
 *
 * ── ★★ 分区按【路径】逐层给，不按顶层键一把分 ────────────────────────
 *   反例（第一版写错过的形态）：顶层 `plugins` 划进稳定面，就等于**整条记录**都稳定 ——
 *   于是往记录里加一个 `activationMs` 这种纯排障字段，也成了对下游的承诺。
 *   正解是**逐层**：`plugins` 稳定的是「有这条路径」，**记录内部**再各有一张稳定键表。
 *   ⇒ 同一把尺子量到底，门禁才能**机械判定**（见 `diagnostics-contract.test.mjs`）。
 *
 * ★ 枚举值**可增不可改**（与 OTel / K8s 一致）—— 新增一个 `state` 取值不算破坏，
 *   改掉既有取值的字面量才是。
 *   ⚠️ 守它的**不是** `Object.freeze`：冻结只挡运行时改对象，**挡不住改源码里的字面量**。
 *   真正守它的是 `diagnostics-contract.test.mjs` 里那条「既有取值逐字钉住、允许新增」的断言。
 *
 * ★★ **消费方契约**：只读 `stable` 里点名的路径，**忽略未知字段**（Tolerant Reader）——
 *   这样内核**加**字段不会打到它。反过来，消费方读了 `unstable` 里的东西，
 *   就得自己承担内核随时改它的后果。
 *
 * ★ `schemaVersion` 本身**不在稳定面**：它是给「机器读契约版本」用的，
 *   而它的取值集合会随契约演进 —— 承诺它就等于承诺「版本号不会变」，那是自相矛盾。
 */
export const DIAGNOSTICS_CONTRACT = Object.freeze({
  /** 本次契约的结构版本（= 下面几张表的形状版本） */
  schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,

  /**
   * 稳定面：`点名的路径 → 在该路径下承诺的键集`。
   *
   * ★ 用【路径 → 键集】而不是一张扁平键表：扁表无法表达「`plugins` 这一层稳定，
   *   记录内部另有约定」—— 而诊断快照恰恰是**三层嵌套**（顶层 / plugins[] / services[]）。
   *   路径是**从快照根算起的点分路径**（`''` = 根）。
   */
  stable: Object.freeze({
    '': Object.freeze(['hostVersion', 'booted', 'totalPlugins', 'actionsCount', 'uiContributionsCount', 'plugins', 'services']),
    // ★★ 记录字段 = manifest 投影 + 生命周期。**从契约表派生，不手列** ——
    //    往 manifest 加字段 ⇒ 投影自动带出 ⇒ 自动进入稳定面。手列就是「漏列即静默丢弃」那个坑。
    'plugins[]': Object.freeze([...MANIFEST_FIELD_TABLE.kernel, 'state', 'error', 'activationMs', 'unresolvedDependencies']),
    // ⚠️ 只收「契约本身 + 提供者归属」；`scopedProviders` 明细属不稳定（排障用，随作用域机制演进）。
    'services[]': Object.freeze(['name', 'access', 'requiredPermission', 'methods', 'activeProvider', 'providerCount'])
  }),

  /**
   * ★ 不稳定面（随时可变，**不承诺兼容**）—— 列出来是为了让「不承诺」也是**显式**的，
   *   而不是靠读者猜「没写的那些到底算不算」。
   */
  unstable: Object.freeze([
    // 文本与条数（K8s 同判：人类可读输出不是稳定的机器契约）
    'recentLogs', 'recentErrors', 'errorLogCount',
    // 字段诊断的内部形状
    'manifestDiagnostics', 'manifestDiagnosticsDropped',
    // 通道内部摘要、权限清单、作用域提供者明细
    'channel', 'permissions', 'services[].scopedProviderCount', 'services[].scopedProviders',
    // 契约版本号本身随契约演进
    'schemaVersion'
  ])
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
 * ★ **只收一种形状**：
 *   · `Object` —— `{ 'plugin.a':'^1' }` ⇒ 原样（键值均裁剪空白，空范围取 `'*'`）
 *   · `Array`  —— **已取消**，一律 fail-loud 抛 `invalid_manifest`。
 *     理由**不是**「生产代码没人用」，而是它**结构上写不下版本范围**：数组项没有位置放
 *     range，只能一律当 `'*'` ⇒ 「用数组声明依赖」= **自动放弃版本约束**，且零提示。
 *     （它同时是本函数下面那处静默数据损坏的入口 —— 两件事同源。）
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
  //   `'oops'` ⇒ `{}` 依赖整体消失 —— 版本门禁的输入错了却 fail-open）。
  //   只拒【类型】：空串 / 纯空白仍按「未写」处理（范围 ⇒ `'*'`，与 npm 一致）。
  const fail = detail => new CordiumError(ErrorCode.INVALID_MANIFEST, `${field} ${detail}`, { pluginId });
  if (value === undefined || value === null) return {};
  if (Array.isArray(value)) {
    // ★★ 数组形式【已取消】。理由不是「生产代码没人用」，而是它**结构上写不下版本范围**：
    //   数组项没有位置放 range，只能一律当 `'*'` ⇒ 「用数组声明依赖」= **自动放弃版本约束**，且零提示。
    //   与已修的「非法范围字符串」「空串」同源 —— `'*'` 是那几条 fail-open 路径共同的兜底值。
    //   ★ 依据（规范层）：RFC 9413《Maintaining Robust Protocols》推翻了「宽进」的鲁棒性原则，
    //     并点名对早期实现尤其有害；一个字段只留一种形态，解析分支才不会重叠。
    throw fail("must be an object mapping plugin id to a SemVer range (e.g. { 'plugin.a': '^1.0.0' }), "
      + 'got an array (the array form cannot express a version range and is no longer accepted)');
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
  throw fail(`must be an object mapping plugin id to a SemVer range (e.g. { 'plugin.a': '^1.0.0' }), got ${typeof value}`);
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
 * @param {Record<string, unknown>} input 原始输入（形状未校验）
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

/**
 * ★★ `apiVersion` 兼容判据的**唯一实现** —— 内核层（运行时契约）与描述符层（上架契约）共用。
 *
 * 语义 = 「**内核满足插件声明的最低要求**」= 该值的 caret 范围。判据两条：
 *
 * ```
 *   ① 破坏边界相同   ② 内核版本 ≥ 插件要求的版本
 * ```
 *
 * ★ **破坏边界 = 版本号里最左的那个非零位**（node-semver 对 caret 的定义就是这句：
 *   "Allows changes that do not modify the left-most non-zero element in the
 *   `[major, minor, patch]` tuple."）。所以：
 *
 * ```
 *   ^1.4.2  = >=1.4.2 <2.0.0      边界 = major
 *   ^0.9.0  = >=0.9.0 <0.10.0     边界 = minor（0.x 是初始开发期，minor 就是破坏位）
 *   ^0.0.3  = >=0.0.3 <0.0.4      边界 = patch
 * ```
 *
 * ★ 依据：SemVer §4「Major version zero (0.y.z) is for initial development.
 *   Anything MAY change at any time.」；node-semver README 的 caret 三例逐字；
 *   VS Code 运行时同样按 minor 判 0.x，并**强制**作者为 0.x 写出 minor
 *   （"for 0.X.Y, that means up to 0.X must be specified"）。
 *
 * ★ 为什么写成显式判据而不是构造 `^${pluginApiVersion}` 交给范围匹配：
 *   两条读出来就是这句话本身，不经过范围字符串的解析。**判据与 caret 等价** ——
 *   测试里有一条逐值比对 `satisfiesSemVer(kernel, '^' + plugin)` 的等价性断言钉住这点。
 *
 * ★ 为什么必须只有一份实现：两层各写一遍必漂 —— 而漂的表现是「内核拒、描述符层放行」
 *   （或反过来），同一份 manifest **按读哪一层给出不同结论**。此前两层确实是各写一遍。
 *
 * @param {string} kernelApiVersion 内核的 `KERNEL_API_VERSION`
 * @param {string} pluginApiVersion 插件 manifest 声明的 apiVersion
 * @returns {boolean} 合法且兼容 ⇒ true；版本号非法也返回 false（由调用方映射成错误码）
 */
export function isApiVersionCompatible(kernelApiVersion, pluginApiVersion) {
  if (!isValidSemVer(kernelApiVersion) || !isValidSemVer(pluginApiVersion)) return false;
  // 只看 base（去掉 -prerelease / +build）—— 边界是数值位，不该被预发布后缀干扰
  const base = v => v.split('-')[0].split('+')[0];
  const k = base(kernelApiVersion).split('.');
  const p = base(pluginApiVersion).split('.');
  const boundary = p[0] !== '0' ? 1 : p[1] !== '0' ? 2 : 3;   // 最左非零位
  if (k.slice(0, boundary).join('.') !== p.slice(0, boundary).join('.')) return false;
  return compareSemVer(kernelApiVersion, pluginApiVersion) >= 0;
}

/** 插件 id 字符集（与插件层 runtime.mjs 的 ID_PATTERN 同一规则） */
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * 宿主（内核自身 / 外壳）的**调用方身份**。
 *
 * ★ 为什么需要它：`host.dispatchAction(callerPluginId, …)` 此前要求宿主**报一个插件 id**，
 *   而派发前会查 `isCallerLive(callerPluginId)` —— 宿主自己没有插件身份，于是**只能借一个
 *   正在跑的插件**。审计日志里记下的就是那个**被借的**身份，不是真实发起方。
 *   这是第一原则①的同形：**归属判据一旦取自调用方可控的输入，它就只是一句自述，不是事实**。
 *
 * ★ 为什么这个值**伪造不出来**：它含 `@`，而 `PLUGIN_ID_PATTERN` 的字符集**不含 `@`** ——
 *   任何合法插件 id 都不可能等于它。（插件也拿不到 `host` 对象：`ctx` 是闭包注入的。）
 *
 * ★ 语义：宿主是**信任根**，与 `getInternalService()` 同一口径 —— 不受 `requiredPermission`
 *   约束。宿主本就持有插件表、能装卸插件，多这一项检查不增加任何实际约束，只会让审计失真。
 */
export const HOST_CALLER = '@host';

/**
 * 内核运行时契约的**归一化 manifest 形状**（`validateManifest` 的产物）。
 *
 * ⚠️ 字段集 == `MANIFEST_FIELD_TABLE.kernel`；本 `@typedef` 是**类型层的描述**，
 *   运行时的唯一真相源仍是那张表（校验产出的键由既有门禁与表比对）。
 *   加字段时两处都要跟 —— 表驱动运行时的白名单重建，本处只让类型检查器认识产物形状。
 *
 * @typedef {object} PluginManifest
 * @property {string} id
 * @property {string} version
 * @property {string} apiVersion
 * @property {string} displayName
 * @property {string} description
 * @property {string[]} provides
 * @property {Record<string,string>} dependencies
 * @property {Record<string,string>} optionalDependencies
 * @property {string[]} permissions
 * @property {boolean} hotReload
 * @property {string} kind `'core'` | `'business'`
 * @property {string} activation `'eager'` | `'lazy'`
 */

/**
 * 校验 Manifest 合法性
 *
 * 入参是**调用方自报的原始 manifest**（形状未校验：可能是任意对象、带 getter 的对象或 Proxy），
 * 故参数类型是 `unknown` 而非具体形状 —— 本函数负责把它判成 `PluginManifest`。
 *
 * @param {unknown} manifest 调用方自报的 manifest，形状未校验
 * @returns {PluginManifest} 白名单重建后的归一化 manifest
 * @throws {CordiumError} 非法时抛 `invalid_manifest`；apiVersion 不兼容时抛 `incompatible_api_version`
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
  // ★★ `apiVersion` 的语义 = 「**至少需要**哪个 API 版本」= 该值的 caret 范围。
  //
  //   为什么不是「只比 major」（此前实现）：那样 `'1.99.0'` 在 1.0.0 的内核上**静默放行** ——
  //   插件要求一个还不存在的 API，作者以为前置要求被检查了，**其实没有**（实测）。
  //   为什么不是「完整 SemVer 范围」：本仓是**同仓分发、一并 bump**，不存在「旧内核 + 新插件」
  //   的组合矩阵 ⇒ 让作者写范围只会诱导他写**虚假上界**。
  //   为什么不是「新增 minKernelVersion 字段」：那要改全仓**真实** manifest（实测 33 处），
  //   而语义**已有一个函数能直接表达**。
  //
  //   ★ 依据（VS Code 官方逐字）：`1.8.0`（无 caret）表示「**只**兼容 1.8.0」；
  //     `^1.8.0` 表示「1.8.0 及以后」。我们的语义是后者。
  //
  //   ★★ 向后兼容：实测【真实 manifest】33 处（本仓 14 + 消费方仓 19）写的**全是** `'1.0.0'`
  //      ⇒ 在 1.0.0 内核上**照旧放行**，**零迁移**。被拒的只有「声明高于内核版本」这类
  //      **本就该拒**的（此前在静默放行）。
  //
  //   ★ 判据本体在 `isApiVersionCompatible`（本文件上方）—— 与描述符层**共用同一份**，
  //     不在这里再写一遍（两层各写一遍必漂）。
  if (!isApiVersionCompatible(KERNEL_API_VERSION, manifest.apiVersion)) {
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

  if (manifest.hotReload !== undefined && manifest.hotReload !== null && typeof manifest.hotReload !== 'boolean') {
    throw new CordiumError(ErrorCode.INVALID_MANIFEST,
      `Plugin ${manifest.id} hotReload must be a boolean, got ${Array.isArray(manifest.hotReload) ? 'array' : typeof manifest.hotReload}`);
  }

  // ★ 激活时机成员校验 —— 与 kind / access 同一口径（写表之前抛）。
  //   拼错值（如 'lazzy' / 'onDemand'）若静默落成 eager，表现是
  //   「**作者以为按需、实际启动即跑**」，而且零报错 —— 同一个坑。
  if (manifest.activation !== undefined && manifest.activation !== null
      && !isValidActivationPolicy(manifest.activation)) {
    throw new CordiumError(ErrorCode.INVALID_MANIFEST,
      `Plugin ${manifest.id} declares unknown activation '${String(manifest.activation)}' `
      + `(expected one of: ${ACTIVATION_POLICY_VALUES.join(', ')})`
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
    // ★ 插件自报「可在进程内热重载」（开发期重载器据此放行；内核的 replacePlugin 不看它）。
    //   只收 true / false：写成 'yes' / 1 这类值多半是误解了语义，静默转布尔会把意图吞掉。
    hotReload: manifest.hotReload === true,
    // ★ 缺省 ⇒ business（第三方插件不该因忘写字段就被锁死；内置插件的一致性由上层装配层检查）
    kind: manifest.kind || PluginKind.BUSINESS,
    // ★ 缺省 ⇒ eager（**现有行为逐字不变**：不写这个字段的插件照旧在 boot 时激活）
    activation: manifest.activation || ActivationPolicy.EAGER
  };
}
