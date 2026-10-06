/**
 * @file packages/kernel/src/host.mjs
 * @description 通用微内核宿主运行时 (CordiumHost) - 零业务逻辑
 *
 * 类内按「// ════ 区块名 ════」分段（按职责，不按公开 / 私有）：内部状态 → 构造 → 审计日志 → 宿主声明 →
 * 插件表 → 生命周期 → 插件 ctx → 服务提供 → 服务取用 → 通知 → 动作 / UI → 诊断。
 * 已抽出的独立职责：action-registry / ui-registry / scope-tree / service-handle / host-util（见各文件头）。
 */

import {
  LifecycleState, ServiceAccess, validateManifest, diffManifestFields, PLUGIN_ID_PATTERN,
  // ★ 诊断快照的 manifest 投影由它派生（唯一真相源）—— 见 snapshotManifestForDiagnostics
  MANIFEST_FIELD_TABLE,
  // ★ 服务契约的「白名单重建丢字段」判定 —— 与 manifest 共用同一条知识
  diffServiceContractFields,
  // ★ access 成员校验（拼错值 ⇒ 静默 fail-open，必须挡在写表之前）
  SERVICE_ACCESS_VALUES, isValidServiceAccess,
  // ★ log 级别成员校验（同款坑：拼错的 error 级不进 recentErrors、不带栈、零报错）
  LOG_LEVEL_VALUES, isValidLogLevel,
  // ★ 激活时机（按需激活：boot 跳过 lazy 插件，置 ready 等触发）
  ActivationPolicy,
  // ★ 诊断快照的稳定性契约 —— schemaVersion 由它带出（唯一真相源，不另写一份字面量）
  DIAGNOSTICS_CONTRACT
} from './types.mjs';
import { CordiumError, ErrorCode } from './errors.mjs';
import { EffectScope } from './scope.mjs';
import { MessageChannel, DispatchMode } from './channel.mjs';
import { UIRegistry } from './ui-registry.mjs';
import { ActionRegistry } from './action-registry.mjs';
// ★ satisfiesSemVer 已抽到零依赖的【中立模块】——
//   原先是本地定义，导致插件层反向 import 本文件（1600+ 行）只为拿这一个纯函数。
//   现在内核与插件【都依赖 semver.mjs】，依赖方向回到稳定侧（SDP）。
import { satisfiesSemVer, isValidSemVer } from './semver.mjs';
// ★ 不读宿主状态的模块级函数已搬出（原样，零行为变化）
import {
  freezeManifestForPlugin, snapshotDetails, copyLogEntry, MAX_TIMER_MS, describeValue, describeError, errorDetails, readOptions, runWithTimeout
} from './host-util.mjs';
import {
  optionalUnavailable, isTerminated, wrapServiceHandle, normalizeContractMethods, missingMethods,
  // ★ 存活态判定（一处定义、五处共用）与「已跑完 activate」判定
  //   —— 按需激活引入 `ready` 后二者必须分开，见各自注释
  isLiveState, hasRunActivate
} from './service-handle.mjs';

/**
 * 服务变更通知的事件名。
 *
 * ★ 此前是字符串 `'internal/service'`：插件的 `ctx.emit('internal/service', {...})` 派发键为空，
 *   而 watchService 的订阅没有作用域标签 ⇒ 伪造的 registered / unregistered 会送到每个 watcher。
 *   改用模块私有 symbol：插件拿不到它，发不出也订不到；宿主经 broadcast 发、经 watchService 转交。
 */
const SERVICE_CHANGE = Symbol('cordium.service-change');

/**
 * 插件状态变更通知的事件名。**模块私有 symbol**，理由同 `SERVICE_CHANGE`：
 * 插件拿不到它 ⇒ 发不出伪造的「某插件已停用」，也订不到别人的状态流。
 */
const PLUGIN_STATE = Symbol('cordium.plugin-state');

/**
 * 统一的「没有配置」值 —— 冻结的空对象，`registerPlugin` 路径下 activate 的第二参。
 * ★ 冻结：插件改它无效（与 `loadPlugins` 路径交付的 config 同一口径）；
 *   共享单例：它是只读的，不需要每个插件各造一份。
 */
const EMPTY_CONFIG = Object.freeze({});

/** 超时类选项：不传 ⇒ 用默认；0 / 负数 = 不限；正数须 ≤ MAX_TIMER_MS（超出 Node 会改成 1ms ⇒ 立即超时） */
function assertTimeoutOption(label, value) {
  if (value !== undefined && (typeof value !== 'number' || Number.isNaN(value) || value > MAX_TIMER_MS)) {
    throw new CordiumError(ErrorCode.INVALID_OPTION,
      `${label} must be a number ≤ ${MAX_TIMER_MS} (0 or negative = unlimited), got ${describeValue(value)}`);
  }
}

/** 公开方法的字符串参数门：错类型在入口就给 invalid_argument，不让它流到报文拼接处炸成裸 TypeError */
function assertStringArg(method, name, value) {
  if (typeof value !== 'string') {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `CordiumHost.${method}: ${name} must be a string, got ${describeValue(value)}`);
  }
}

/**
 * 把 manifest 投影成诊断快照里的那一段 —— **字段集由契约表派生，不手列**。
 *
 * ── 为什么这样写 ────────────────────────────────────────────────────
 * 手列清单会漏，且**漏了不会有人发现**：本项目同形已踩 4 次
 * （`optionalDependencies` / `optionalProvider` / 契约未知键 / `kind`+`displayName`+`description`）。
 * 每次的形状都一样：字段加进了 manifest 与 `MANIFEST_FIELD_TABLE`，投影忘了跟。
 *
 * ⚠️ 更隐蔽的是：**门禁也救不了手工清单**。若门禁自己手列一份期望清单，
 *    新字段同时被实现与门禁忽略 ⇒ 照常全绿。
 *    ⇒ 唯一能自我维护的写法是**从真相源派生**（本函数 + 同名的门禁测试）。
 *
 * ── 拷贝策略（照 `freezeManifestForPlugin` 的既有口径）──────────────
 * 诊断是**只读快照**，不是宿主持有物的引用出口：数组 / 对象逐层拷贝，
 * 否则调用方 `diagnostics.plugins[0].provides.push(...)` 就能改到内核的登记表。
 * 标量（字符串 / 布尔 / null）按值传，无需特殊处理。
 *
 * @param {object} manifest 已由 validateManifest 归一化的 manifest
 * @returns {object} 只读快照片段（字段集 == MANIFEST_FIELD_TABLE.kernel）
 */
function manifestSnapshot(manifest) {
  const out = {};
  for (const field of MANIFEST_FIELD_TABLE.kernel) {
    const value = manifest[field];
    out[field] = Array.isArray(value) ? [...value]
      : (value !== null && typeof value === 'object') ? { ...value }
      : value;
  }
  return out;
}

export class CordiumHost {
  // ════════════════ 内部状态与只读属性 ════════════════

  // ★ 私有字段防止插件绕过API直接访问内部状态
  #plugins = new Map();
  /** EffectScope 释放令牌：只有宿主能 dispose 插件的 scope / 登记宿主自有释放（见 scope.mjs #releaseKey）。须先于 #actionHandlers 初始化 */
  #scopeReleaseKey = Symbol('cordium.scope-release');
  #serviceContracts = new Map();
  // ★ 动作表抽成内部类 ActionRegistry；鉴权事实（插件状态 / 权限快照）仍留在宿主，只注入窄查询。
  #actionHandlers = new ActionRegistry({
    isCallerLive: (id) => {
      const caller = this.#plugins.get(id);
      // ★ 用共用判定，不手写 `=== ACTIVE || === ACTIVATING` —— 按需激活引入 `ready` 后
      //   手写版会漏（漏的表现是某一处不认 ready 的插件，见 isLiveState 的注释）
      return !!caller && isLiveState(caller.state);
    },
    hasPermission: (id, perm) => this.#pluginPermissions.get(id)?.has(perm) ?? false,
    assertPermissionDeclared: (name, where) => this.#assertPermissionDeclared(name, where),
    defaultTimeoutMs: () => this.#defaultActionTimeoutMs,
    maxInFlight: () => this.#maxInFlightActions,
    releaseKey: this.#scopeReleaseKey,
    log: (level, message, details) => this.log(level, message, details)
  });
  // 注入窄查询（同 ActionRegistry 的口径）：注册表只问「这个 type 算不算合法」，
  // 不拿宿主引用、读不到也改不了别的状态。闭包延迟求值 ⇒ 与 #uiTypes 的初始化顺序无关。
  #uiContributions = new UIRegistry({
    isKnownType: (type) => this.#uiTypes.has(type),
    knownTypes: () => [...this.#uiTypes]
  });
  /**
   * ★★ UI 贡献 `type` 的【合法值集】—— 由装配方登记，缺省空集（= 不校验）。
   *
   * ── 为什么走【注册制】而不是内核固定集 ────────────────────────────
   *   `type` 是**消费者侧的概念**：内核只存不解释（`getUIContributions(type)` 只按字符串过滤），
   *   真正按 type 分派的是上层 UI 宿主。实测消费方在按 `theme` / `command` / `panel` / `widget`
   *   `/ settings` 分派，**这些值集内核无从预知**。
   *   ⇒ 与「服务契约 / 权限名只能由装配方定义」**同一口径**。
   *   （对照 `log.level`：内核自己按级别分流 recentErrors 与抓栈 ⇒ 必须固定集。**分层不同，做法不同。**）
   *
   * ── 缺省为什么不校验 ──────────────────────────────────────────────
   *   不登记 ⇒ 空集 ⇒ 放行（保持现有行为逐字不变，装配方按需收紧）。
   *   ⚠️ 这是刻意的：内核**不得**替消费方猜它的值集。
   *
   * ── 实测的坑（为什么必须有这个口）─────────────────────────────────
   *   消费方 `syncFromKernel` 的分派是：
   *     `if type==='theme' … else if type==='command' … else if (item.slot) …`
   *   ⇒ **type 拼错但带 `slot` 的贡献会静默落进 panels**。这是「拼错值静默落成最宽松的那个」
   *   在本项目的**第三个实例**（前两个 ServiceAccess / PluginKind 均已修），且这次在消费方。
   *   ⚠️ 内核装不了那道闸（它不该知道 `slot` 是什么）⇒ 只能提供**登记口**让消费方自己守。
   */
  #uiTypes = new Set();
  #pluginPermissions = new Map();
  #pluginDependencies = new Map();
  #pluginOptionalDependencies = new Map();
  /**
   * ★ 权限词表（由宿主装配层登记）。
   *
   * 修的洞：权限名此前零校验。插件 B 用 `requiredPermission: '随便起的名字'` 守自己的 action，
   *   插件 A 在 manifest 里自报同一个名字 ⇒ 两个插件就「互相授权」了，宿主毫不知情；
   *   拼错的权限名（`perm.sen`）也静默生效成一道谁都过不去 / 谁都能自报的门。
   *   同文件里 `access`、`kind` 都有成员校验，唯独权限没有。
   *
   * 口径：**权限名是宿主定义的**。插件只能【申请】宿主登记过的权限（manifest.permissions），
   *   也只能拿宿主登记过的权限去【守】自己的 action（requiredPermission）。
   *   词表内容属于上层应用（内核不预设任何权限名）。
   *
   * ⚠️ 边界（如实标注）：这是「名字必须由宿主定义」，**不是**授予审批。
   *   插件申请一个已登记的权限，注册时即获得 —— 宿主若需逐个审批，应在装配层决定注册哪些插件。
   *   插件是同进程、无沙箱的代码，权限门守的是【声明一致性】，不是安全边界。
   */
  #permissions = new Set();
  /**
   * ★ 以下原为公开可写字段 —— 拿到 host 的代码可 `auditLogs.length = 0` 清空审计、
   *   可换掉 `channel` 的钩子、可把 `booted` 改回 false。现全部硬私有：
   *   日志 / 诊断经 getDiagnostics() 读副本；配置与状态经下方只读 getter。
   */
  #channel;
  #auditLogs;
  #errorLogs;
  #manifestDiagnostics;
  #manifestDiagnosticsDropped;
  #hostVersion;
  #maxLogSize;
  #maxErrorLogSize;
  #maxManifestDiagnostics;
  #defaultActionTimeoutMs;
  #lifecycleTimeoutMs;
  #maxInFlightActions;
  #booted;

  /** 宿主应用自身的版本（只读） */
  get hostVersion() { return this.#hostVersion; }
  /** 是否已成功 boot（只读；boot 失败回滚后为 false） */
  get booted() { return this.#booted; }
  /** 审计日志环形缓冲上限（只读，构造时定） */
  get maxLogSize() { return this.#maxLogSize; }
  /** 错误日志独立留存上限（只读，构造时定） */
  get maxErrorLogSize() { return this.#maxErrorLogSize; }
  /** Manifest 诊断留存上限（只读，构造时定） */
  get maxManifestDiagnostics() { return this.#maxManifestDiagnostics; }
  /** 动作默认执行上限毫秒数（只读，构造时定；0 或负数 = 不限） */
  get defaultActionTimeoutMs() { return this.#defaultActionTimeoutMs; }
  /** 生命周期钩子（activate / deactivate + 清理回调）的默认执行上限毫秒数（只读，构造时定；0 或负数 = 不限） */
  get lifecycleTimeoutMs() { return this.#lifecycleTimeoutMs; }
  /** 同时在途的动作派发数上限（只读，构造时定） */
  get maxInFlightActions() { return this.#maxInFlightActions; }

  // ════════════════ 构造 ════════════════

  /**
   * @param {object} [options]
   * @param {string} [options.hostVersion='1.0.0']
   * @param {number} [options.maxLogSize=500]
   */
  constructor(options) {
    // null / undefined 视同不传；字符串 / 数组 / 数字 ⇒ invalid_option（此前静默展开后全部落回默认值）
    options = readOptions(options, 'CordiumHost', ['hostVersion', 'maxLogSize', 'maxErrorLogSize', 'actionTimeoutMs', 'lifecycleTimeoutMs', 'maxInFlightActions', 'maxManifestDiagnostics'], ErrorCode.INVALID_OPTION);
    // ★ 构造参数校验 —— 此前 `maxLogSize: -1` 之类被原样收下，日志缓冲行为失常而无报错。
    //   缺省（undefined）仍取默认值；显式传入非法值 ⇒ 响亮失败。
    const positiveInt = (name, value, fallback) => {
      if (value === undefined) return fallback;
      if (!Number.isInteger(value) || value <= 0) {
        throw new CordiumError(ErrorCode.INVALID_OPTION, `CordiumHost option '${name}' must be a positive integer, got ${String(value)}`);
      }
      return value;
    };
    if (options.hostVersion !== undefined && !isValidSemVer(options.hostVersion)) {
      throw new CordiumError(ErrorCode.INVALID_OPTION, `CordiumHost option 'hostVersion' must be valid SemVer, got ${String(options.hostVersion)}`);
    }
    // 0 / 负数 = 不限；正数须 ≤ MAX_TIMER_MS（超出 Node 会改成 1ms ⇒ 每个动作立即超时）
    for (const name of ['actionTimeoutMs', 'lifecycleTimeoutMs']) {
      assertTimeoutOption(`CordiumHost option '${name}'`, options[name]);
    }
    /** 宿主应用自身的版本（诊断用；插件兼容性看 manifest.apiVersion 与 KERNEL_API_VERSION） */
    this.#hostVersion = options.hostVersion || '1.0.0';
    this.#maxLogSize = positiveInt('maxLogSize', options.maxLogSize, 500);
    /**
     * 错误日志的独立留存上限。
     * ★ 为什么要独立：审计缓冲是共享的 500 槽环形，一个话多的 info 插件就能把
     *   「出过事」冲掉。错误单独留一份，且这一份**只被错误挤掉**。
     */
    this.#maxErrorLogSize = positiveInt('maxErrorLogSize', options.maxErrorLogSize, 100);

    /**
     * 动作处理器默认执行上限（毫秒）。单条注册可用 timeoutMs 覆盖。
     * 设为 0 或负数表示不限制（不推荐：插件处理器挂起会连带卡住调用方）。
     * @type {number}
     */
    this.#defaultActionTimeoutMs = options.actionTimeoutMs ?? 30000;

    /**
     * 生命周期钩子上限（毫秒）：activate()、deactivate() 与插件清理回调（后两者共用一份预算）。
     * ★ 此前不限 ⇒ 一个永不结束的 activate 让 boot() 永久挂起、该插件的后续
     *   启停 / 卸载全部排队卡死；一个永不结束的清理回调让插件停在 stopping，且服务仍可取、动作仍可派发。
     * ★ 超时 ≠ 中断：钩子仍在跑（同进程拦不住），只是宿主不再等它 ——
     *   激活超时 ⇒ 判 FAILED 并释放作用域（此后它的一切登记被生命周期门拒绝），可再次 activatePlugin 重试；
     *   停用超时 ⇒ 照常收尾到 disabled。
     * 慢插件的放宽由【宿主侧】做：registerPlugin(manifest, entry, { lifecycleTimeoutMs })（loader 清单条目同名字段）。
     * ★ 不进 manifest：manifest 是插件自己写的，让被限制方给自己定上限等于没有上限。
     */
    this.#lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? 30000;

    /**
     * 同时在途的动作派发数上限。
     * ★ 处理器异步地派发自己（或两插件互相派发）此前无上限，堆线性上涨直至进程崩溃；
     *   动作超时拦不住它 —— 递归全在微任务里跑，期间计时器一次都没机会触发（实测）。只能按数量判。
     * ★ 为什么是「在途数」而不是 AsyncLocalStorage 记调用深度：ALS 在 Node 20 / 22 上让整个进程
     *   每次 await 慢约 3 倍（实测，含宿主应用自己的代码）；在途数只是一个计数器，
     *   且同一道闸也挡住「深度不大但每层扇出很多」的情形。插件改不了这个计数（宿主私有）。
     */
    this.#maxInFlightActions = positiveInt('maxInFlightActions', options.maxInFlightActions, 10000);

    /** @type {Map<string, { manifest: any, entry: any, state: string, scope: EffectScope | null, error?: Error }>} */
    this.#plugins = new Map();
    /**
     * ★ 信息中转层 —— 内核里【只负责搬运消息】的那一层。
     *
     * 它与服务是**两种不同的语义**（见 channel.mjs 文件头）：
     *   服务 = 点对点、调用方知道对方是谁、必须有回执；
     *   通道 = 一对多、发布方【不知道谁在听】、回执可有可无、**就是设计来被拦截的**。
     * 因此独立成层，宿主只做编排。
     *
     * @type {MessageChannel}
     */
    this.#channel = new MessageChannel();

    // 监听器异常与泄漏都进审计日志 —— 否则"一个坏插件静默吃掉所有人的通知"无从发现。
    this.#channel.onListenerError = (name, error, owner) => {
      this.#logFailure('warn', `Channel listener for '${String(name)}'${owner ? ` (plugin '${owner}')` : ''} threw`, error, owner);
    };
    this.#channel.onListenerOverflow = (name, count) => {
      this.log('warn', `Channel '${String(name)}' has ${count} listeners — possible listener leak (each plugin should unsubscribe on unload; scope disposal handles this automatically)`);
    };
    // ★ 作用域位置冲突也要留痕：作用域的位置在【首次创建时】定死，加入者不能改写。
    //   请求的层级与实际不符时照常返回实际那个（否则会误伤"只想引用一下"的合法用法），
    //   但必须写进审计 —— 否则调用方拿到的是"不是它以为的那个层级"而毫无线索。
    this.#channel.onScopeConflict = (key, actualParent, requestedParent) => {
      this.log(
        'warn',
        `Scope '${String(key)}' is already declared at `
        + `'${actualParent === null ? 'top-level' : String(actualParent)}'; the request to place it under `
        + `'${requestedParent === null ? 'top-level' : String(requestedParent)}' was ignored `
        + `(a scope position is fixed at first creation — later users can only join, never re-parent)`
      );
    };

    /** @type {Array<{ timestamp: number, level: string, message: string, details?: any, stack?: string }>} */
    this.#auditLogs = [];

    /** ★ 错误的独立留存（不被 info 冲掉，且带栈）。见 log() 的说明。 */
    /** @type {Array<{ timestamp: number, level: string, message: string, details?: any, stack?: string }>} */
    this.#errorLogs = [];

    /**
     * ★★ Manifest 字段诊断（结构化，带归属）。
     *
     * 为什么不是「一个全局 droppedFields 数组」：
     *   本项目有【两套】manifest schema（内核 / 插件），丢字段是【分层】问题；
     *   无归属的全局数组无法区分「是哪一层丢的」⇒ 排障时会指向错误的代码。
     *   ⇒ 每条诊断必须带 `path`（哪一层）+ `pluginId`（哪个插件）。
     *
     * ★ 有界：见 `maxManifestDiagnostics`。丢弃**不是静默的** —— 会累计到
     *   `manifestDiagnosticsDropped` 并在 `getDiagnostics()` 里暴露。
     * @type {Array<{ path: string, pluginId: string, fields: string[], severity: string, timestamp: number }>}
     */
    this.#manifestDiagnostics = [];

    /**
     * Manifest 诊断的留存上限。
     *
     * ★ 为什么必须有界：本数组曾是**唯一无上限**的诊断容器（审计 500 / 错误 100 都有环），
     *   而 `getDiagnostics()` 每次都 `.slice()` **全量拷贝** —— 无界增长 + 每次全量复制。
     *
     * ★ 为什么不直接照抄 `auditLogs` 的静默 `shift()`：
     *   本容器的设计意图恰恰是「**不被冲掉的证据**」（见上方注释）；
     *   静默丢弃会让「没有记录」等价于「没有发生」，与项目「宁可红也不给假绿」口径冲突。
     *   ⇒ 采用「有界 + **丢弃计数可见**」：截断照做，但**丢了多少必须能被看见**。
     *   （同款口径见 open-policy-agent/gatekeeper#4503 的 truncation marker、
     *     go-ethereum#33885 的「drop-oldest + 记一条日志」。）
     * @type {number}
     */
    this.#maxManifestDiagnostics = positiveInt('maxManifestDiagnostics', options.maxManifestDiagnostics, 200);

    /**
     * 因超限而被丢弃的 Manifest 诊断条数。
     * ★ 它存在本身就是一个信号：非 0 ⇒ 丢字段问题**规模异常**，
     *   此时「丢了多少」比「每条是什么」更有信息量。
     * @type {number}
     */
    this.#manifestDiagnosticsDropped = 0;

    /** @type {boolean} */
    this.#booted = false;
  }

  // ════════════════ 审计日志 / manifest 诊断 ════════════════

  /**
   * 记录运行时审计日志 (有上限，防止内存无限膨胀)
   *
   * ★ 级别【成员校验】（写表之前）—— 此前 `log('Error')` / `log('err')` / `log('fatal')`
   *   全部照收，实测后果：**不进 `recentErrors`、不带栈、零报错** ⇒
   *   「拼错值静默落成最宽松的那个」，与 `ServiceAccess` / `PluginKind` 同一个坑（本仓第三次）。
   *
   * ⚠️ 归属说明：`ctx.log` 的级别来自**插件**，但校验点在这里（宿主自己的日志入口）。
   *   宿主内部调用一律写 `ErrorCode.X` 之类的字面量，不受影响。
   */
  log(level, message, details) {
    if (!isValidLogLevel(level)) {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT,
        `Log level must be one of ${LOG_LEVEL_VALUES.join(', ')}, got ${describeValue(level)}`);
    }
    // ★ details 存【快照】不存引用：此前原样存入 ⇒ 调用方（插件经 ctx.log）
    //   记完日志后改自己手里的对象，就能回头改写审计记录。
    // message 一律转成字符串：非字符串（对象）此前原样存引用，调用方事后改它就改了审计记录；symbol 在 ctx.log 的模板里直接抛
    const entry = { timestamp: Date.now(), level, message: describeValue(message), details: snapshotDetails(details) };
    // ★ 错误自带栈：排查时「哪一行抛的」比「抛了什么」值钱得多，
    //   而栈抓取只在错误路径上付一次代价。
    // ★ 不构造错误对象 —— 这里没有「失败」，只要一份栈；借 captureStackTrace 挂到普通对象上，
    //   并把 log() 自身这一帧裁掉（栈顶就是调用方）。
    if (level === 'error') {
      const holder = { name: 'Log', message };
      Error.captureStackTrace(holder, this.log);
      entry.stack = holder.stack;
    }

    if (this.#auditLogs.length >= this.#maxLogSize) {
      this.#auditLogs.shift();
    }
    this.#auditLogs.push(entry);

    // ★★ 错误【单独留存】：500 槽的环形缓冲是共享的，一个话多的 info 插件
    //    就能把「出过事」这件事从诊断里冲掉 —— 而那可是一条永久的、不可再生的证据。
    //    （依据：本项目一贯口径「宁可红也不给假绿」，诊断同理：
    //      不能让"没有记录"等价于"没有发生」。）
    if (level === 'error') {
      if (this.#errorLogs.length >= this.#maxErrorLogSize) this.#errorLogs.shift();
      this.#errorLogs.push(entry);
    }
  }

  /**
   * ★ 兜底定位：后台失败（emit 监听器 / 清理回调 / 生命周期钩子 / 启动回滚）【没有调用方能 catch】，
   *   只能进日志 —— 所以日志必须自己能回答「哪个插件、什么码、哪一行」。
   *   · message 末尾附 `[码] at 文件:行:列`：扫一眼日志就能定位；
   *   · details = errorDetails(err)：码、插件、源头位置、各层栈、cause 链（有界）。
   *   ⚠️ entry.stack（error 级自动抓的）是【记日志的这一行】的栈 —— 在内核里；出错位置看 details.at / details.stack。
   * @param {'warn' | 'error'} level
   * @param {string} what 发生了什么（不含原因，原因由本函数拼）
   * @param {unknown} err
   * @param {string | null} [pluginId] 归属插件（宿主已知的真实身份）
   */
  #logFailure(level, what, err, pluginId = null) {
    const details = errorDetails(err);
    if (pluginId && details.pluginId === undefined) details.pluginId = pluginId;
    const tag = details.code ? ` [${details.code}]` : '';
    const at = details.at ? ` at ${details.at}` : '';
    this.log(level, `${what}: ${describeError(err)}${tag}${at}`, details);
  }

  /**
   * ★★ 记录一条 Manifest 字段诊断（结构化留存 + 即时日志）。
   *
   * 两个通道**互补**，都要走：
   *   · **诊断快照**（`getDiagnostics().manifestDiagnostics`）—— 随时可查、不被冲掉；
   *   · **宿主 log**（warn 级）—— 装插件那一刻即时可见。
   * 只做前者会「事后才发现」，只做后者会被环形缓冲冲掉。
   *
   * @param {{ path: string, pluginId: string, fields: string[], severity?: string }} diagnostic
   */
  recordManifestDiagnostic(diagnostic) {
    if (!diagnostic || !Array.isArray(diagnostic.fields) || diagnostic.fields.length === 0) return;
    const entry = {
      path: String(diagnostic.path || ''),
      pluginId: String(diagnostic.pluginId || ''),
      fields: [...diagnostic.fields],
      severity: String(diagnostic.severity || 'warn'),
      timestamp: Date.now()
    };
    this.#manifestDiagnostics.push(entry);
    // ★ 有界：满则丢【最旧】的一条，并**记账**。
    //   为什么丢最旧而不是最新：与审计/错误缓冲同款（新证据更有诊断价值）。
    //   为什么必须记账：静默丢弃 = 把「没有记录」变成「没有发生」——
    //   正是本项目在 log() 里明确反对的那种失效（见 maxManifestDiagnostics 的注释）。
    if (this.#manifestDiagnostics.length > this.#maxManifestDiagnostics) {
      this.#manifestDiagnostics.shift();
      this.#manifestDiagnosticsDropped += 1;
    }
    // ★ 措辞刻意【不写死 "Manifest"】：本方法现已被三个层次共用
    //   （`kernel` / `plugin` 两套 manifest schema + `service-contract` 契约字段）。
    //   `path` 就是「哪一层」，`pluginId` 是【归属槽】（manifest 填插件 ID、契约填服务名）。
    //   ★ 不改方法名：它是跨包契约（插件加载器的诊断 sink → 上层应用 → host），
    //     改名的成本远大于「名字略窄」的收益 —— 按最小精准原则只订正措辞。
    this.log(entry.severity, `字段被丢弃 [${entry.path}] ${entry.pluginId}: ${entry.fields.join(', ')}`, {
      path: entry.path,
      pluginId: entry.pluginId,
      fields: entry.fields
    });
  }

  // ════════════════ 宿主声明：服务契约 / 权限词表 ════════════════

  /**
   * 声明一个服务的契约（★ 只能由宿主装配代码调用）
   *
   * 插件无权决定自己提供的服务的安全级别 —— 否则它能把本该敏感的服务降级为
   * public，或把 requiredPermission 置空来取消权限门。
   * 安全级别的决定权必须与服务的提供者分离。
   *
   * @param {string} serviceName
   * @param {{ access?: string, requiredPermission?: string | null, optionalProvider?: string | null,
   *           methods?: string[] }} [options]
   *   `methods`：提供者实现必须具备的方法名；不写 ⇒ 不查形状。
   */
  declareServiceContract(serviceName, options) {
    // ★ 服务名是跨插件的公开标识符，与插件 id 同一级别 —— 此前只有插件 id 有格式校验
    //   （`declareServiceContract(null)` 会注册出名叫 'null' 的契约）。复用 PLUGIN_ID_PATTERN，不另造模式。
    if (typeof serviceName !== 'string' || !PLUGIN_ID_PATTERN.test(serviceName)) {
      throw new CordiumError(ErrorCode.INVALID_CONTRACT,
        `Service Violation: contract name '${describeValue(serviceName)}' is not a valid service identifier `
        + `(expected lowercase segments joined by . _ -)`);
    }
    // ★ null / 非对象 options 此前在下一行读 .access 时抛引擎 TypeError（无码）；
    //   数组此前被当成对象静默收下
    // ★★ 这里【刻意不传】允许键集 —— 与「选项袋」的硬拒是两种输入、两种口径：
    //   契约表是**声明式字段表**，未知键走【丢弃 + 诊断】（diffServiceContractFields ⇒
    //   manifestDiagnostics + 日志点名）。上层若比内核新、多带了字段，不该被内核打死，
    //   但也绝不能静默 —— 拼错的键会在诊断里被点名。见 service-contract.test.mjs 两处用例。
    options = readOptions(options, `Service Violation: contract '${serviceName}'`, null, ErrorCode.INVALID_CONTRACT);
    // ★★ 门禁必须在【写表之前】（同形已出现三次：registerAction / registerService /
    //    ctx.ui.registerContribution —— 都是「先写表后 addDisposer」留下的幽灵条目）。
    //
    // 为什么抛错，而不是「降级到 SENSITIVE + 记诊断」：
    //   写了 `public` 却实得 `sensitive` ⇒ 服务「注册成功但谁都取不到」，
    //   那是比报错**更隐蔽的静默失效**（与 service-contracts.mjs 既有口径同一理由）。
    //
    // 为什么只在【显式传值】时校验：既有契约是 `access` 缺省 ⇒ SENSITIVE（最严格），
    //   必须保留 —— 忘记声明不等于放行，但要允许「什么都不写」。
    if (options.access !== undefined && options.access !== null && !isValidServiceAccess(options.access)) {
      throw new CordiumError(ErrorCode.INVALID_CONTRACT,
        `Service Violation: contract '${serviceName}' declares unknown access level `
        + `'${String(options.access)}' (expected one of: ${SERVICE_ACCESS_VALUES.join(', ')})`
      );
    }
    // ★ 接口形状（可选）。同样只在显式传值时校验，且在写表之前 ——
    //   写错的方法表若静默落表，注册期校验会拿一张错表去拒绝正当实现（或放过错误实现）。
    const methods = normalizeContractMethods(serviceName, options.methods);
    // ★★ 契约记录同样是【白名单重建】—— `options` 里只列出的键会被保留，
    //    其余**静默丢弃且零报错**（实测：传 `{ futureField: 'X' }` ⇒ 记录里没有该字段，无任何提示）。
    //    本项目已因同类形状踩过两次（`optionalDependencies` / `optionalProvider`）。
    //
    //    ⇒ 复用 manifest 丢字段诊断的同一套判定（`diffWhitelistFields` 是这条知识的唯一落点），
    //      把「声明了却没生效」从静默变成可见。
    //
    //    ★ 位置：放在幂等短路【之前】—— 与 `registerPlugin` 的既有次序一致
    //      （那里也是先 diff、后查重复）。正常路径下 `diffServiceContractFields`
    //      返回 `null`，**零开销、零噪音**；只有真的传了未知键才会记录。
    const record = {
      // ★ 默认取最严格级别：忘记声明不等于放行
      access: options.access || ServiceAccess.SENSITIVE,
      requiredPermission: options.requiredPermission || null,
      // ★ 可选提供者：声明后，提供者未安装时取服务会返回 code='optional_unavailable'。
      //   ⚠️ 这里同样是【白名单重建】—— 新契约字段必须一并列出，否则会被静默丢弃。
      optionalProvider: options.optionalProvider || null,
      // ★ 接口形状 —— 提供者注册时必须具备这些方法（null = 不查）。冻结：诊断读出的是同一份。
      methods,
      declaredBy: 'host',
      providers: new Map(),
      // ★ 注册代次：每次注册从【契约级单调计数器】领一个新号，**永不复用** ⇒ 注销后重新注册必然换号，
      //   旧句柄不可能「复活」。句柄只比对「我那一格当前注册的号」是否仍是我拿到时的号，
      //   所以别人（别的提供者 / 别的作用域）注册不会误伤我的句柄。
      //   ★ 此前是两张【只增不删】的 providerId→代次表（为防号码复用），
      //     作用域键又是 symbol / 临时 label ⇒ 常驻插件反复 privateScope().provideService 内存无上限增长（实测 2 万次 +12MB）。
      //     改成「号码来自单调计数器」后不需要留历史，本表只存【当前在册】的注册，注销即删。
      epochSeq: 0,
      providerEpochs: new Map(),
      // ★ 所有权记录：providerId → 注册它的 EffectScope【对象身份】。
      //   注销时按"scope 是不是我"反查，而不是相信一个可被改写的字符串。
      //   这是「注册即记录」——把归属事实存在宿主自己这边，插件改不到。
      providerScopes: new Map(),
      // ★ 作用域实现表：scopeKey → Map<providerId, { impl, epoch, scope }>（epoch 即该次注册的号）
      //   —— 即「全局那三个 Map 的所有内容，按作用域各存一份」。
      //
      //   语义：全局槽（上面三个 Map）是**所有人可见的兜底**；
      //   本表里的实现只在【其作用域内】可见 —— 这正是「多 agent 各用各的实现」的落点。
      //
      //   ★ 为什么用【嵌套 Map】而不是把 scopeKey 拼进字符串键：
      //     manifest.id 的字符集虽已收紧（只允许小写段 + . _ -），
      //     但作用域 label 是任意字符串（如 `agent:x`）——
      //     只要键是靠拼接构造的，就依赖「两边字符集永不相交」这个脆弱前提。
      //     嵌套 Map 用【两个独立的名字空间】表达两维，从结构上不存在撞键的可能。
      //
      //   ★ 为什么全局槽不并进本表：全局路径是这个契约当前 100% 的生产用法，
      //     保持 providers / providerEpochs / providerScopes 原样，等于【零行为变更】；
      //     作用域是纯新增的一维。
      //
      //   ⚠️ 契约记录的字段都是【白名单重建】的高发位。
      //      新增契约字段时，必须同步确认它会经 declareServiceContract 落表，
      //      否则「声明了却没生效」且【没有任何报错】（本项目已踩过两次）。
      //      ★ 漏列会被 `diffServiceContractFields` 记成诊断 —— 不再静默。
      scopedProviders: new Map()
    };

    // ★ 契约由宿主声明 ⇒ 其 requiredPermission 本身就是宿主对这个权限名的定义，自动入词表。
    if (record.requiredPermission !== null) this.declarePermissions([record.requiredPermission]);

    const droppedContract = diffServiceContractFields(serviceName, options, record);
    if (droppedContract) this.recordManifestDiagnostic(droppedContract);

    if (this.#serviceContracts.has(serviceName)) return;
    this.#serviceContracts.set(serviceName, record);
  }

  /**
   * 登记权限名（宿主装配阶段调用，须早于注册申请这些权限的插件）。
   * 幂等；名字须与插件 id 同一字符集（小写段以 . _ - 连接）。
   * @param {string[]} names
   */
  declarePermissions(names) {
    if (!Array.isArray(names)) throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'declarePermissions requires an array of permission names');
    for (const name of names) {
      if (typeof name !== 'string' || !PLUGIN_ID_PATTERN.test(name)) {
        throw new CordiumError(ErrorCode.INVALID_PERMISSION, `Permission name '${String(name)}' is invalid (expected lowercase segments joined by . _ -)`);
      }
    }
    for (const name of names) this.#permissions.add(name);
  }

  /**
   * ★ 声明本应用用到的 UI 贡献 `type` 值集（UI 贡献 `type` 的成员校验）。
   *
   * 与 `declarePermissions` / `declareServiceContracts` **同一位置、同一口径**：
   * 由装配方在 boot 前一次性登记，插件不得自造。
   * ⚠️ 不调它 ⇒ 不校验（保持现有行为）；调了 ⇒ 登记之外的值在**注册 UI 贡献时**抛错。
   *
   * @param {string[]} types
   */
  declareUIContributionTypes(types) {
    if (!Array.isArray(types)) {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'declareUIContributionTypes requires an array of type names');
    }
    for (const type of types) {
      if (typeof type !== 'string' || !type.trim()) {
        throw new CordiumError(ErrorCode.INVALID_ARGUMENT,
          `UI contribution type must be a non-empty string, got ${describeValue(type)}`);
      }
    }
    for (const type of types) this.#uiTypes.add(type);
  }

  /** 断言权限名已由宿主登记 —— 未登记即抛错（禁止插件自造权限名） */
  #assertPermissionDeclared(name, where) {
    if (!this.#permissions.has(name)) {
      throw new CordiumError(ErrorCode.UNDECLARED_PERMISSION,
        `${where} uses undeclared permission '${name}' — permissions must be declared by the host via host.declarePermissions()`
      );
    }
  }

  /**
   * 批量声明服务契约（宿主装配阶段调用：由上层应用在 boot 前一次性登记全部契约）
   * @param {Record<string, { access?: string, requiredPermission?: string | null, optionalProvider?: string | null, methods?: string[] }>} table
   */
  declareServiceContracts(table) {
    // ★ 先判类型 —— Object.entries('ab') / Object.entries(['a']) 都产出下标键，
    //   此前会静默注册 '0' / '1' 这类假契约。null / undefined 仍按「没有契约」处理（与原 `table || {}` 一致）。
    if (table === null || table === undefined) return;
    if (typeof table !== 'object' || Array.isArray(table)) {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT,
        `declareServiceContracts expects an object table { [serviceName]: contract }, got ${Array.isArray(table) ? 'array' : typeof table}`);
    }
    for (const [serviceName, spec] of Object.entries(table)) {
      this.declareServiceContract(serviceName, spec);
    }
  }

  // ════════════════ 插件表：注册 / 拓扑 ════════════════

  /**
   * 发现并注册插件
   * @param {any} rawManifest
   * @param {any} [entry] 插件执行入口 (可选对象，包含 activate/deactivate)
   */
  /**
   * @param {object} rawManifest
   * @param {{ activate?: Function, deactivate?: Function } | null} [entry]
   * @param {{ lifecycleTimeoutMs?: number }} [options] 宿主侧对【这一个】插件的设置（装配方写，不是插件自己写）
   */
  registerPlugin(rawManifest, entry = null, options) {
    const { lifecycleTimeoutMs } = readOptions(options, 'CordiumHost.registerPlugin', ['lifecycleTimeoutMs'], ErrorCode.INVALID_OPTION);
    assertTimeoutOption("registerPlugin option 'lifecycleTimeoutMs'", lifecycleTimeoutMs);
    const manifest = validateManifest(rawManifest);
    // ★★ 白名单重建会【静默丢弃】未列出的字段 —— 本项目已因此踩过两次坑。
    //   此处把「输入有、输出没有」的字段显式记入结构化诊断（宿主 log + 诊断快照）。
    const droppedDiagnostic = diffManifestFields('kernel', rawManifest, manifest, manifest.id);
    if (droppedDiagnostic) {
      this.recordManifestDiagnostic(droppedDiagnostic);
    }
    if (this.#plugins.has(manifest.id)) {
      throw new CordiumError(ErrorCode.DUPLICATE_PLUGIN, `Plugin '${manifest.id}' is already registered`);
    }
    for (const perm of manifest.permissions) {
      this.#assertPermissionDeclared(perm, `Plugin '${manifest.id}'`);
    }

    this.#plugins.set(manifest.id, {
      manifest,
      entry,
      state: LifecycleState.DISCOVERED,
      scope: null,
      // 生命周期钩子上限：null ⇒ 用宿主默认 lifecycleTimeoutMs
      lifecycleTimeoutMs: lifecycleTimeoutMs ?? null,
      // 最近一次激活耗时（毫秒；诊断用，供装配方判断该放宽谁）
      activationMs: null,
      // ★ 生命周期迁移队列（见 #serializeLifecycle）：
      //   pending = 在途 + 排队的调用数；0 表示空闲。
      //   transition = 队列尾 promise（初始已解决 ⇒ 空闲）。
      pending: 0,
      transition: Promise.resolve(),
      // ★ 停用来源 —— 用户显式停用（boot 跳过） vs 因依赖被停而级联停用（提供者回来时恢复）
      disabledByUser: false,
      stoppedByCascade: false,
      // ★ 级联停用时它是否**正停在「等触发」**（`ready`）—— 只对懒插件有意义。
      //   恢复动作取决于被连累时在哪个状态，而 ready / active 级联后都变成 `disabled`，
      //   所以必须在级联那一刻记下来（见 #stopDependents / #resumeCascaded）。
      stoppedWhileReady: false
    });

    this.#snapshotAuthority(manifest);

    // ★ 名单变更也是一次「注册表变更」—— 订阅方（例如按注册表渲染界面的装配层）
    //   需要知道**有了一个新插件**，而不是只关心已有插件的状态迁移。
    //   `from` = null 表示「之前不在表里」。
    this.#announcePresence(manifest.id, null, LifecycleState.DISCOVERED);
    this.log('info', `Plugin registered: ${manifest.id} v${manifest.version}`);
  }

  /**
   * ★ 鉴权依据必须快照到宿主自己的记录里（注册 / 替换时各做一次）。
   *   不能每次鉴权去读 record.manifest —— 那个对象会被交给插件（ctx.manifest），
   *   插件往里 push 一个权限字符串就能给自己提权。
   */
  #snapshotAuthority(manifest) {
    this.#pluginPermissions.set(manifest.id, new Set(manifest.permissions));
    this.#pluginDependencies.set(manifest.id, new Set([
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.optionalDependencies)
    ]));
    this.#pluginOptionalDependencies.set(
      manifest.id,
      new Map(Object.entries(manifest.optionalDependencies))
    );
  }

  /**
   * 替换后的必需依赖不得绕回自己（A 依赖 B 时把 B 换成依赖 A）。
   * 注册时不查环（boot 的拓扑排序会报）；替换发生在运行期，等到下次 boot 才报就晚了。
   */
  #assertNoNewCycle(id, manifest) {
    const seen = new Set();
    const stack = Object.keys(manifest.dependencies);
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === id) {
        throw new CordiumError(ErrorCode.CYCLIC_DEPENDENCY, `Cannot replace plugin '${id}': its new dependencies lead back to itself`, { pluginId: id });
      }
      if (seen.has(cur)) continue;
      seen.add(cur);
      const rec = this.#plugins.get(cur);
      if (rec) stack.push(...Object.keys(rec.manifest.dependencies));
    }
  }

  /** 换掉记录里的代码与 manifest（含鉴权快照），返回换下来的那份（回滚用） */
  #swapPlugin(record, next) {
    const previous = { manifest: record.manifest, entry: record.entry, lifecycleTimeoutMs: record.lifecycleTimeoutMs };
    record.manifest = next.manifest;
    record.entry = next.entry;
    record.lifecycleTimeoutMs = next.lifecycleTimeoutMs;
    this.#snapshotAuthority(next.manifest);
    return previous;
  }

  /**
   * 原地替换一个已注册插件的 manifest 与代码（同 id）—— 升级插件、开发期热重载都走这里。
   *
   * ★ 为什么不是 unregister + register：插件有必需依赖方时 unregisterPlugin 拒绝（见其注释）；
   *   而替换不改变「谁依赖谁」，只换实现 ⇒ 依赖方先级联停下，换完再按依赖顺序拉回来（同 deactivate / activate）。
   * 流程（与其他生命周期迁移同一队列串行）：
   *   ① 入口同步校验：manifest 合法、id 已注册、权限已登记、新版本仍满足每个必需依赖方的范围（零副作用，失败同步抛出）；
   *   ② 原来 ACTIVE ⇒ 级联停依赖方 → 停自己；
   *   ③ 换 manifest / entry / 时限（未传 lifecycleTimeoutMs ⇒ 回到宿主默认）与鉴权快照；
   *   ④ 原来 ACTIVE ⇒ 用新代码激活；失败 ⇒ **换回旧代码并重新激活**，再抛出新代码的原始错误；
   *   ⑤ 恢复被级联停下的依赖方（它们拿到的是新实例：旧服务句柄已失效，须重新 getService）。
   * ★ 原来不是 ACTIVE（未启动 / 已停用 / 失败）⇒ 只换不启，状态与「用户停用」标记原样保留。
   * ⚠️ 错误通道同 unregisterPlugin：入口校验失败同步抛出；排队后失败是 Promise 拒绝（`await` 即可统一）。
   *
   * @param {object} rawManifest
   * @param {{ activate?: Function, deactivate?: Function } | null} [entry]
   * @param {{ lifecycleTimeoutMs?: number }} [options]
   */
  replacePlugin(rawManifest, entry = null, options) {
    const { lifecycleTimeoutMs } = readOptions(options, 'CordiumHost.replacePlugin', ['lifecycleTimeoutMs'], ErrorCode.INVALID_OPTION);
    assertTimeoutOption("replacePlugin option 'lifecycleTimeoutMs'", lifecycleTimeoutMs);
    const manifest = validateManifest(rawManifest);
    const id = manifest.id;
    const record = this.#plugins.get(id);
    if (!record) throw new CordiumError(ErrorCode.PLUGIN_NOT_FOUND, `Plugin '${id}' not found (replacePlugin only replaces a registered plugin)`);
    for (const perm of manifest.permissions) this.#assertPermissionDeclared(perm, `Plugin '${id}'`);
    const assertDependentsSatisfied = () => {
      for (const depId of this.#dependentsOf(id)) {
        const range = this.#plugins.get(depId).manifest.dependencies[id];
        if (!satisfiesSemVer(manifest.version, range)) {
          throw new CordiumError(ErrorCode.DEPENDENCY_VERSION_MISMATCH,
            `Cannot replace plugin '${id}' with v${manifest.version}: '${depId}' requires ${range}`, { pluginId: id });
        }
      }
    };
    assertDependentsSatisfied();
    this.#assertNoNewCycle(id, manifest);
    const droppedDiagnostic = diffManifestFields('kernel', rawManifest, manifest, id);
    if (droppedDiagnostic) this.recordManifestDiagnostic(droppedDiagnostic);

    const run = this.#serializeLifecycle(id, async () => {
      // ★ 排队期间可能已被移除 / 重新注册，或有新依赖方注册 ⇒ 任务体内重新校验
      if (this.#plugins.get(id) !== record) throw new CordiumError(ErrorCode.PLUGIN_NOT_FOUND, `Plugin '${id}' not found`);
      assertDependentsSatisfied();
      const wasActive = record.state === LifecycleState.ACTIVE;
      if (wasActive) {
        await this.#stopDependents(id);
        await this.#deactivatePluginNow(id);
      }
      const previous = this.#swapPlugin(record, { manifest, entry, lifecycleTimeoutMs: lifecycleTimeoutMs ?? null });
      this.log('info', `Plugin replaced: ${id} v${previous.manifest.version} -> v${manifest.version}`);
      if (!wasActive) return;
      try {
        await this.#activatePluginNow(id);
      } catch (err) {
        // ★ 新代码起不来 ⇒ 换回旧代码重新激活：宿主回到替换前的样子，而不是留下一个 failed 的空位
        this.#swapPlugin(record, previous);
        try {
          await this.#activatePluginNow(id);
          this.log('warn', `Plugin '${id}' rolled back to v${previous.manifest.version} after the replacement failed to activate`);
        } catch (rollbackError) {
          this.#logFailure('error', `Rollback of plugin '${id}' failed`, rollbackError, id);
        }
        throw err;
      }
    });
    // 成功或回滚成功后，提供者都已 ACTIVE ⇒ 把级联停下的依赖方拉回来（提供者没起来时 #resumeCascaded 什么都不做）
    return run.then(() => this.#resumeCascaded(id), err => this.#resumeCascaded(id).then(() => { throw err; }));
  }

  /**
   * 拓扑排序解析插件加载顺序，并检查循环/缺失依赖
   * @returns {string[]} 拓扑排序后的插件 ID 列表
   */
  #resolveTopologicalOrder() {
    const allIds = Array.from(this.#plugins.keys());
    const inDegree = new Map(allIds.map(id => [id, 0]));
    const adj = new Map(allIds.map(id => [id, []]));
    for (const [id, record] of this.#plugins.entries()) {
      for (const depId of this.#orderingEdges(id, record.manifest)) {
        adj.get(depId).push(id);
        inDegree.set(id, inDegree.get(id) + 1);
      }
    }

    // Kahn
    const queue = allIds.filter(id => inDegree.get(id) === 0);
    const result = [];
    while (queue.length > 0) {
      const u = queue.shift();
      result.push(u);
      for (const v of adj.get(u)) {
        inDegree.set(v, inDegree.get(v) - 1);
        if (inDegree.get(v) === 0) queue.push(v);
      }
    }

    if (result.length !== allIds.length) {
      const remaining = allIds.filter(id => !result.includes(id));
      throw new CordiumError(ErrorCode.CYCLIC_DEPENDENCY, `Cyclic dependency detected among plugins: ${remaining.join(', ')}`);
    }
    return result;
  }

  /**
   * 一个插件参与排序的依赖边（被依赖方 id 列表）。必选依赖缺失 / 版本不符 ⇒ 抛错。
   * ★ 纯查询：只抛错，不改任何记录的 state（此前这里会把插件标成 FAILED ——
   *   一个看起来只读的公开方法带副作用，诊断里会凭空出现 failed）。
   */
  #orderingEdges(id, manifest) {
    const edges = [];
    for (const [depId, expectedRange] of Object.entries(manifest.dependencies || {})) {
      const target = this.#plugins.get(depId);
      if (!target) {
        throw new CordiumError(ErrorCode.MISSING_DEPENDENCY, `Missing dependency '${depId}' required by '${id}'`);
      }
      const actualVersion = target.manifest.version;
      if (!satisfiesSemVer(actualVersion, expectedRange)) {
        throw new CordiumError(ErrorCode.DEPENDENCY_VERSION_MISMATCH, `Version mismatch for dependency '${depId}': expected ${expectedRange}, got ${actualVersion}`);
      }
      edges.push(depId);
    }
    // ★ 可选依赖：缺失 ⇒ 跳过，不报错；版本不符 ⇒ 跳过拓扑依赖（运行期视为不可用，
    //   取服务时返回 optional_unavailable）；存在且版本匹配 ⇒ 参与拓扑排序，
    //   保证「提供者先激活」的顺序仍然成立。
    for (const [depId, expectedRange] of Object.entries(manifest.optionalDependencies || {})) {
      const target = this.#plugins.get(depId);
      if (target && satisfiesSemVer(target.manifest.version, expectedRange)) edges.push(depId);
    }
    return edges;
  }

  // ════════════════ 生命周期：boot / 激活 / 停用 / 移除 ════════════════

  /**
   * ★★ 按需激活的**依赖收拢**：把 `pluginId` 的必需依赖里仍在等触发的懒插件
   *  （含它们自己的依赖，递归）先拉起来。
   *
   * 为什么必须有：懒插件 B 依赖懒插件 A。触发 B 时 A 还没跑过 `activate()`，
   * `#assertDependenciesActive` 会以 `dependency_inactive` 拒绝 —— 于是「按需激活」
   * 在最常见的「提供者也是懒的」场景下**直接不可用**。
   * （OSGi 的懒激活由类加载**隐式级联**；这里是同一条语义的显式版。）
   *
   * ★ 只收拢 `ready` 的：`disabled`（用户停过）与 `failed`（激活失败过）**不擅自拉起**——
   *   前者是用户意图，后者会重演一次已知失败。让依赖检查照常报错，报的才是真原因。
   * ★ 用 `#serializeLifecycle` 走正规激活路径 ⇒ 天然幂等（已是 ACTIVE 会短路）。
   *
   * @param {string} pluginId
   */
  /**
   * ★ 同步预检：`pluginId` 是否有**直接**依赖仍停在 `ready`（= 是否需要走异步收拢）。
   *
   * ★★ 为什么必须存在（这条是被测试逼出来的，两个用例同时变红）：
   *   `#activateReadyDependencies` 是 `async`，**只要 await 它就会让出一跳微任务** ——
   *   即使它一个依赖都不用收拢。而 `#serializeLifecycle` 有一条硬契约：
   *   「空闲时必须**同步**进入任务体」（见其注释，`state = ACTIVATING` 必须同步生效）。
   *   多这一跳的后果实测是：
   *     · 「排在移除之后的旧 deactivate」用例读到 `discovered` 而不是 `active`；
   *     · 级联停用用例里依赖的状态被别的迁移推进到 `stopping`，
   *       于是报 `dependency_inactive (state=stopping)` —— 一个**由调度顺序制造的假错**。
   *   ⇒ 非懒路径（绝大多数）必须**零额外 await**：先同步判断，没有才不 await。
   */
  #hasReadyDependency(pluginId) {
    const record = this.#plugins.get(pluginId);
    if (!record) return false;
    return Object.keys(record.manifest.dependencies)
      .some(depId => this.#plugins.get(depId)?.state === LifecycleState.READY);
  }

  async #activateReadyDependencies(pluginId) {
    const record = this.#plugins.get(pluginId);
    if (!record) return;
    for (const depId of Object.keys(record.manifest.dependencies)) {
      const dep = this.#plugins.get(depId);
      if (!dep || dep.state !== LifecycleState.READY) continue;
      await this.#activateReadyDependencies(depId);   // 先收拢它自己的依赖（递归，先深后己）
      await this.#serializeLifecycle(depId, async () => {
        if (this.#plugins.get(depId) !== dep || dep.state !== LifecycleState.READY) return;
        await this.#activatePluginNow(depId);
        this.log('info', `Lazy plugin '${depId}' activated as a dependency of '${pluginId}'`);
      });
    }
  }

  /**
   * 启动宿主运行时 (按依赖拓扑依次激活所有已注册插件)
   *
   * ★ `manifest.activation === 'lazy'` 的插件**不激活**：登记后停在 `ready`，等触发
   *   （显式 `activatePlugin`，或首次派发它登记的动作）。不写该字段的插件一律 `eager`
   *   ⇒ **现有行为逐字不变**。
   */
  async boot() {
    this.log('info', 'CordiumHost booting...');
    const order = this.#resolveTopologicalOrder();

    // 部分失败必须回滚：否则某个插件激活失败时，先前已激活的插件会停留在 ACTIVE，
    // 宿主处于半启动状态，调用方重试 boot() 还会因重复注册再次抛错，无法自愈。
    const activated = [];
    // ★ 级联停用配套：被【显式停用】的插件不得被 boot 顺手拉起（此前 deactivate a → 注册 b → boot ⇒ a 复活）。
    //   依赖它的插件同样跳过 —— 否则会因「依赖未激活」让整次 boot 失败回滚。
    //
    // ★★ 两个集合必须分开（`unavailable` / `deferred`）—— 这是被对抗性核验逼出来的修正。
    //   只用一个集合时「依赖被跳过」把两件不同的事混成一件：
    //     · 依赖**永远起不来**（被停用 / 失败）⇒ 依赖方也不该起（`unavailable`）
    //     · 依赖**等触发**（懒、已就绪）⇒ 依赖方只是【还不能跑】，它自己也该进 `ready`（`deferred`）
    //   混用的实测后果：**lazy 依赖 lazy 时，被依赖方进了 skipped，依赖方就永久停在
    //   `discovered`**，而 `#activateAllReady` 只扫 `READY` ⇒ 它永远不会被触发，
    //   连注册的动作都派发不到（`action_not_found`）——「按需激活」在最常见的形态下失效。
    const unavailable = new Set();
    const deferred = new Set();
    try {
      for (const id of order) {
        const rec = this.#plugins.get(id);
        // ★ 拓扑序是开跑前的快照：途中被 unregisterPlugin 移除的插件直接跳过。
        if (!rec) continue;
        const deps = Object.keys(rec.manifest.dependencies);
        if (rec.disabledByUser || deps.some(d => unavailable.has(d))) {
          unavailable.add(id);
          continue;
        }
        const isLazy = rec.manifest.activation === ActivationPolicy.LAZY;
        // ★ 已经是活的（重复 boot 到已激活的懒插件）⇒ **不得**改写成 ready，
        //   否则会把一个正在运行、已提供服务与动作的插件"假停用"掉
        //   （scope 没释放、服务还在表里，再触发会重跑 activate ⇒ 动作注册撞名抛 duplicate_action）。
        //   ⇒ 走下面的正常路径（`activatePlugin` 对 ACTIVE 短路），依赖方也照常可上线。
        if (isLazy && !isLiveState(rec.state)) {
          // 依赖里若有【永远起不来】的，它连"等触发"都算不上 —— 不置 ready，等条件具备的自然会被拉起
          if (deps.some(d => deferred.has(d) && this.#plugins.get(d)?.manifest.activation !== ActivationPolicy.LAZY)) {
            deferred.add(id);
            continue;
          }
          this.#setState(rec, LifecycleState.READY);
          deferred.add(id);
          this.log('info', `Plugin '${id}' is ready (lazy: waiting to be triggered)`);
          continue;
        }
        // ★ 急切插件：必需依赖只要还没【跑过 activate】（等触发的懒依赖也算）就不能上线。
        //   否则会以 dependency_inactive 让整次 boot 失败回滚 —— 而那不是错误，只是"还没到时候"。
        if (deps.some(d => deferred.has(d) || !hasRunActivate(this.#plugins.get(d)?.state))) {
          deferred.add(id);
          continue;
        }
        // ★ 只把【本次调用真正启动的】记进回滚清单。
        //   旧实现无条件 push，于是「重复 boot 且新插件失败」会把本来已经 ACTIVE、
        //   本次只是在 activatePlugin 里被短路 return 的健康插件也一起拆掉 ——
        //   调用方以为只是「新插件没起来、重试一下」，结果整个宿主被拆空。
        const before = rec.state;
        await this.activatePlugin(id);
        if (before !== LifecycleState.ACTIVE) activated.push([id, rec]);
      }
    } catch (error) {
      for (const [id, rec] of activated.reverse()) {
        try {
          // ★ 走内部路径：回滚不是「用户停用」，不得打上 disabledByUser（否则修好后重试 boot 起不来）。
          // ★ 按【本次启动的那条记录】回滚：途中被移除后同 id 重新注册的是另一个插件，不归本次 boot 管。
          await this.#serializeLifecycle(id, async () => {
            if (this.#plugins.get(id) === rec) await this.#deactivatePluginNow(id);
          });
        } catch (rollbackError) {
          this.#logFailure('warn', `Rollback of plugin '${id}' failed`, rollbackError, id);
        }
      }
      this.#booted = false;
      this.#logFailure('error', 'CordiumHost boot failed and rolled back', error);
      throw error;
    }

    this.#booted = true;
    this.log('info', 'CordiumHost booted successfully');
  }

  /**
   * 激活单个插件及其生命周期
   * @param {string} pluginId
   */
  /**
   * 把同一个插件的生命周期迁移【串行化】。
   *
   * 为什么需要：activatePlugin / deactivatePlugin 都是「同步改状态 → await 钩子 → 再改状态」，
   * 中间那段 await 就是竞争窗口。旧实现下两个调用交错会：
   *   · 第二次 activate 看到 state=ACTIVATING（≠ ACTIVE）⇒ 放行 ⇒ **activate 钩子跑两遍**；
   *   · `record.scope` 槽被后来者覆盖 ⇒ 前一个 scope 无人 dispose
   *     ⇒ 它的监听器与定时器【永久泄漏】。
   * 生产可达：上层 UI 对这两个方法不 await 时，快速点两次插件开关即可复现（实测）。
   *
   * ★ 语义选择：串行化而不是抛错 —— 用户连点两次开关是正常操作，
   *   抛错会把日常操作变成报错弹窗。串行化让两次请求按顺序各自完整执行。
   *
   * @param {string} pluginId
   * @param {() => Promise<any>} task
   */
  #serializeLifecycle(pluginId, task) {
    const record = this.#plugins.get(pluginId);
    if (!record) return task();   // 交给内层抛出「未注册」的原始错误

    const idle = record.pending === 0;
    record.pending += 1;
    const clear = () => { record.pending -= 1; };

    let run;
    if (idle) {
      // ★★ 空闲时必须【同步】进入任务体 —— 这一条是被测试逼出来的。
      //   第一版无条件写成 `record.transition.then(task)`，那会把整个方法体
      //   推迟到下一个微任务，于是 `record.state = ACTIVATING` 不再是同步生效的。
      //   后果：调用方在「装配插件」之后紧跟的同步代码读到的是**旧状态**，
      //   据此判断「该停用的停用」—— 会误判插件启停。
      //   ⇒ 改造必须是「只在真的有重叠时才排队」，而不是「给每次调用都加一跳」。
      // ★ 这里的 promise 不被 await 是【有意】的：try/catch 抓的是 task() 的【同步抛出】，
      //   而 run 要交出去 —— 拒绝的接收者是本方法末尾 return 出去的那个调用方，
      //   队列尾另有 .then(clear, clear) 兜底。改成 await 会把「同步进入任务体」变成异步，
      //   正好破坏上面那条设计。（静态检查看不见「promise 被交出去」，报的是误报。）
      try {
        run = Promise.resolve(task());
      } catch (err) {
        run = Promise.reject(err);
      }
    } else {
      // 真的有在途迁移 ⇒ 排到它后面。前一次失败不得阻断后一次（两种回调都接 task）。
      run = record.transition.then(task, task);
    }
    // 队列尾吞掉结果：既避免未处理拒绝告警，也不让失败污染后续调用方
    record.transition = run.then(clear, clear);
    return run;
  }

  activatePlugin(pluginId) {
    assertStringArg('activatePlugin', 'pluginId', pluginId);
    // ★ 捕获【调用时刻】的记录：排队期间该 id 可能被移除、甚至重新注册，
    //   旧调用不得作用到新记录上（按 id 重查会拿到另一个插件）。
    const record = this.#plugins.get(pluginId);
    const run = this.#serializeLifecycle(pluginId, async () => {
      if (this.#plugins.get(pluginId) !== record) throw new CordiumError(ErrorCode.PLUGIN_NOT_FOUND, `Plugin '${pluginId}' not found`);
      // ★ 按需激活：显式激活一个懒插件时，它自己的懒依赖也要跟着起来
      //   —— 否则 `#assertDependenciesActive` 会以 dependency_inactive 拒绝，
      //   而真因是「提供者也是懒的、还没被触发」。
      // ⚠️ 先【同步】判断，没有 ready 依赖就不 await —— 保住「空闲时同步进入任务体」的契约
      //   （多一跳微任务会让别的迁移插队，实测两个用例变红，见 #hasReadyDependency 的注释）。
      if (this.#hasReadyDependency(pluginId)) await this.#activateReadyDependencies(pluginId);
      await this.#activatePluginNow(pluginId);
      record.disabledByUser = false;
    });
    // ★ 提供者回来了 ⇒ 把当初被【级联】停掉的依赖方按依赖顺序拉回来。
    return run.then(() => this.#resumeCascaded(pluginId));
  }

  /**
   * 依赖检查：插件的每个【必需】依赖都必须已注册、版本满足、且处于 ACTIVE。
   *
   * ★ 此前只有 boot() 走拓扑与版本校验，直接 activatePlugin 两样都不查 ——
   *   实测：依赖 `ghost@^9` 根本不存在，插件照样 active；父插件 discovered 而子插件已 active。
   * ★ 不自动拉起依赖：激活顺序是调用方（或 boot）的职责；这里只拒绝「在依赖缺席时上线」。
   */
  #assertDependenciesActive(pluginId, record) {
    for (const [depId, range] of Object.entries(record.manifest.dependencies)) {
      const dep = this.#plugins.get(depId);
      if (!dep) {
        throw new CordiumError(ErrorCode.MISSING_DEPENDENCY, `Missing dependency '${depId}' required by '${pluginId}'`);
      }
      if (!satisfiesSemVer(dep.manifest.version, range)) {
        throw new CordiumError(ErrorCode.DEPENDENCY_VERSION_MISMATCH, `Version mismatch for dependency '${depId}': expected ${range}, got ${dep.manifest.version}`);
      }
      if (dep.state !== LifecycleState.ACTIVE) {
        throw new CordiumError(ErrorCode.DEPENDENCY_INACTIVE,
          `Dependency '${depId}' required by '${pluginId}' is not active (state=${dep.state}); activate it first`
        );
      }
    }
  }

  /** 直接依赖 pluginId（必需依赖）的插件 ID 列表 */
  #dependentsOf(pluginId) {
    const out = [];
    for (const [id, rec] of this.#plugins) {
      if (Object.prototype.hasOwnProperty.call(rec.manifest.dependencies, pluginId)) out.push(id);
    }
    return out;
  }

  /**
   * ★ 级联停用 —— 先停依赖方（递归），再停提供者。
   *   被级联停掉的插件打上 stoppedByCascade，提供者重新激活时会被拉回来。
   */
  async #stopDependents(pluginId) {
    const isLive = (rec) => !!rec && isLiveState(rec.state);
    // ★ 一轮停完要重新取名单，直到没有活的依赖方：停用途中提供者仍是 ACTIVE，
    //   期间新注册 / 新激活的依赖方不在上一轮名单里 ⇒ 只跑一轮会留下依赖已下线却仍 ACTIVE 的插件。
    for (let live = this.#dependentsOf(pluginId); live.some(id => isLive(this.#plugins.get(id)));
      live = this.#dependentsOf(pluginId)) {
      for (const depId of live) {
        const dep = this.#plugins.get(depId);
        // ★ 循环里有 await：后面的依赖方可能已被移除（dep 为空），或排队期间被移除后同 id 重新注册。
        if (!isLive(dep)) continue;
        await this.#serializeLifecycle(depId, async () => {
          if (this.#plugins.get(depId) !== dep) return;
          await this.#stopDependents(depId);
          // ★ `ready` 的依赖方没有东西可拆，但要记住「它被级联停过」：
          //   提供者回来时才能把它放回 `ready`（否则它会永远留在 `disabled`，
          //   而它本来只是「还没触发」而已）。
          if (!isLiveState(dep.state)) return;
          if (dep.state === LifecycleState.READY) {
            this.#setState(dep, LifecycleState.DISABLED);
            dep.stoppedByCascade = true;
            // ★ 记住「它是在【等触发】的状态下被连累的」——否则恢复时无从分辨
            //   它原本是 ready 还是 active（两者都会变成 disabled），
            //   而这两种情况的正确恢复动作**不同**（回 ready vs 重新激活）。
            dep.stoppedWhileReady = true;
            this.log('info', `Lazy plugin '${depId}' was moved back to disabled because its dependency '${pluginId}' was deactivated`);
            return;
          }
          await this.#deactivatePluginNow(depId);
          dep.stoppedByCascade = true;
          dep.stoppedWhileReady = false;
          this.log('info', `Plugin '${depId}' stopped because its dependency '${pluginId}' was deactivated`);
        });
      }
    }
  }

  /** 提供者重新上线后，恢复被级联停用的依赖方（依赖仍不齐的留在原地，不报错） */
  async #resumeCascaded(pluginId) {
    for (const depId of this.#dependentsOf(pluginId)) {
      const dep = this.#plugins.get(depId);
      // ★ 同 #stopDependents：循环里有 await，后面的依赖方可能已被移除。
      if (!dep || !dep.stoppedByCascade || dep.disabledByUser) continue;
      // ★ 依赖必须【真的跑过 activate】才算就绪 —— `hasRunActivate` 而非 `isLiveState`：
      //   一个 `ready` 的提供者被当成已上线，消费者取服务时才炸（见 hasRunActivate 的注释）。
      const ready = Object.keys(dep.manifest.dependencies)
        .every(d => hasRunActivate(this.#plugins.get(d)?.state));
      if (!ready) continue;
      // ★★ `stoppedByCascade` 的语义是「**它只是被连累，该恢复原样**」——
      //   所以这里对懒插件**不能**一律退回 `ready`。
      //
      //   缺陷（由独立对抗性核验发现，本机复现）：
      //     一个**已经被触发过**（跑过 `activate`）的懒插件，在依赖被停用时走的是
      //     **正常级联停用**（`state → disabled`）；依赖回来时若一律把它重写成 `ready`，
      //     就抹掉了「它其实已经激活过」这个事实 —— 下次触发会**重跑 `activate`**，
      //     带 `registerAction` 的插件直接撞名抛 `duplicate_action`（实测）。
      //
      //   ⇒ 恢复动作取决于它**被连累时在哪个状态**，而两者都会变成 `disabled`，
      //     所以那件事必须当场记下来（`stoppedWhileReady`），不能事后猜。
      const wasWaiting = dep.stoppedWhileReady === true;
      dep.stoppedByCascade = false;
      dep.stoppedWhileReady = false;
      if (dep.manifest.activation === ActivationPolicy.LAZY && wasWaiting) {
        this.#setState(dep, LifecycleState.READY);
        this.log('info', `Lazy plugin '${depId}' is ready again after its dependency '${pluginId}' came back`);
        continue;
      }
      // 已激活过的懒插件走下面的正常激活路径 ⇒ 恢复激活（不是「退回等触发」）
      try {
        await this.activatePlugin(depId);   // 递归恢复它自己的级联依赖方
      } catch (err) {
        this.#logFailure('warn', `Failed to resume plugin '${depId}' after '${pluginId}' came back`, err, depId);
      }
    }
  }

  async #activatePluginNow(pluginId) {
    const record = this.#plugins.get(pluginId);
    if (!record) {
      throw new CordiumError(ErrorCode.PLUGIN_NOT_FOUND, `Plugin '${pluginId}' not found`);
    }
    if (record.state === LifecycleState.ACTIVE) return;

    try {
      this.#assertDependenciesActive(pluginId, record);
    } catch (err) {
      this.#setState(record, LifecycleState.FAILED);
      record.error = err;
      this.#logFailure('error', `Plugin '${pluginId}' failed to activate`, err, pluginId);
      throw err;
    }

    this.#setState(record, LifecycleState.ACTIVATING);
    const scope = new EffectScope(pluginId, {
      // ★ 注入释放回调而不是交出宿主引用：scope 会作为 ctx.scope 交给插件，
      //   它只需要「按 scope 身份释放」这两个能力，不需要认识宿主的形状。
      releaseService: (name, owner) => this.#releaseRegistration(name, owner),
      releaseUIContribution: (id, ownerId) => this.#unregisterUIContribution(id, ownerId),
      // 清理回调抛错进宿主日志（与 channel 的 onListenerError 同一口径），不再只到 console
      onDisposeError: (ownerId, err) => this.#logFailure('error', `Dispose hook of plugin '${ownerId}' threw`, err, ownerId)
    }, this.#scopeReleaseKey);
    record.scope = scope;

    const budget = record.lifecycleTimeoutMs ?? this.#lifecycleTimeoutMs;
    const started = Date.now();
    try {
      if (record.entry && typeof record.entry.activate === 'function') {
        const ctx = this.#buildPluginCtx(pluginId, scope, null);
        // ★★ 第二参【一律】传 —— 没有配置时传 `{}`，不传 `undefined`。
        //
        //   此前 `registerPlugin` 路径完全不传第二参（`loadPlugins` 路径则传一个已冻结的对象）⇒
        //   同一个接口**两种形状**，其中一种是 `undefined`。实测后果：
        //   照抄插件指南 §1 的 `activate(ctx, config) { let n = config.start ?? 0 }` 会抛
        //   **裸 TypeError**（`instanceof CordiumError === false`、`code === undefined`），
        //   而指南 §9 承诺「宿主抛出的一律是 CordiumError」⇒ 作者按文档写的 catch 分支接不住。
        //
        //   ★ 为什么统一成 `{}` 是安全的（依据是**语言规范**，不是我的偏好）：
        //     `function activate(ctx, config = {})` 的默认参数在【调用方传 undefined】时同样生效，
        //     故 `activate(ctx, undefined)` 与 `activate(ctx, {})` 对任何遵循语言约定的插件**逐字等价**。
        //     受影响的只有「假定第二参一定存在」的写法 —— 而那正是会崩的写法。
        //   ⚠️ 不选「只改文档」：文档只能覆盖照着文档写的人，而这是内核的**结构问题**。
        const config = record.entry.config ?? EMPTY_CONFIG;
        await runWithTimeout(() => record.entry.activate(ctx, config), budget, () => new CordiumError(ErrorCode.LIFECYCLE_TIMEOUT,
          `Plugin '${pluginId}' activate() did not finish within ${budget}ms (it may still be running; its scope is released, so later registrations are rejected)`,
          { pluginId }));
        // ★ 防御纵深 —— **本检查在当前代码路径上不可达**，保留是刻意的。按本仓既有口径，
        //   纵深防御要标清【防什么 / 代价 / 不可达的证据】三者（见 design/ 与测试目录里另外四处同形记录）：
        //
        //   ① 防什么：将来出现**宿主侧**的新路径，在 activate() 在途时把 scope 关掉
        //      （例如某种「取消启动」或并发 teardown）。**不是**防插件 ——
        //      插件根本关不掉：`EffectScope.dispose()` 要求出示 `#scopeReleaseKey`，
        //      那是宿主私有 symbol（见本文件 #scopeReleaseKey 与 scope.mjs 的令牌门）。
        //   ② 代价：每次成功激活多一次布尔读，**代价为零**。
        //   ③ 不可达的证据（实测，非推断）：
        //      · 五条伪造令牌路径（无参 / 伪 symbol / undefined / null / 字符串）全部被
        //        `scope_owned_by_host` 挡在 dispose 之前，scope 仍 active；
        //      · 宿主侧唯一的 scope.dispose 调用点 `#deactivatePluginNow` 先要求
        //        `state === ACTIVE`，而此刻是 ACTIVATING ⇒ 被 `#serializeLifecycle` 串行化挡住；
        //      · 删除本段的变异体：全量测试仍然全绿 —— 即**没有任何测试能判别它**。
        //   ⇒ 前身是「事后检测 scope.active」，令牌机制落地后它被**取代**；此处保留为新防线，
        //     而非旧防线残留。若将来 ① 那类路径确实出现，本检查会自动生效。
        if (!scope.active) {
          throw new CordiumError(ErrorCode.SCOPE_OWNED_BY_HOST,
            `Plugin '${pluginId}' disposed its own scope during activate() — `
            + `a plugin must not release the scope the host owns`
          );
        }
      }
      record.activationMs = Date.now() - started;
      this.#setState(record, LifecycleState.ACTIVE);
      // ★ 成功后必须清掉上一次的失败痕迹，否则 getDiagnostics() 会出现
      //   「state=active 却还挂着旧 error」的自相矛盾输出，误导排障。
      record.error = undefined;
      this.log('info', `Plugin activated: ${pluginId}`);
    } catch (err) {
      record.activationMs = Date.now() - started;
      this.#setState(record, LifecycleState.FAILED);
      record.error = err;
      await scope.dispose(this.#scopeReleaseKey, { timeoutMs: budget });
      record.scope = null;
      this.#logFailure('error', `Plugin '${pluginId}' failed to activate`, err, pluginId);
      throw err;
    }
  }

  /**
   * 停用单个插件并彻底清理作用域
   * @param {string} pluginId
   */
  deactivatePlugin(pluginId) {
    assertStringArg('deactivatePlugin', 'pluginId', pluginId);
    // ★ 同 activatePlugin：捕获调用时刻的记录；排队期间被移除 / 重新注册 ⇒ 旧调用作废（空操作）。
    const record = this.#plugins.get(pluginId);
    return this.#serializeLifecycle(pluginId, () => {
      if (!record || this.#plugins.get(pluginId) !== record) return undefined;
      // ★ 显式停用 = 用户意图：boot() 不得再顺手拉起它；级联恢复也不碰它。
      record.disabledByUser = true;
      record.stoppedByCascade = false;
      // ★ 没有活着的依赖方时【同步】进入停用（不多加一跳微任务）——
      //   保持「调用返回那一刻 state 已是 stopping」这条既有契约（见 #serializeLifecycle 注释）。
      const live = this.#dependentsOf(pluginId).some(id => isLiveState(this.#plugins.get(id).state));
      if (!live) return this.#deactivatePluginNow(pluginId);
      return this.#stopDependents(pluginId).then(() => this.#deactivatePluginNow(pluginId));
    });
  }

  async #deactivatePluginNow(pluginId) {
    const record = this.#plugins.get(pluginId);
    if (!record) return;
    // ★★ `ready` 的插件也要能停 —— 它什么都没跑过（没有 scope、没有挂钩子），
    //   直接落 `disabled` 即可，**不能**走下面的 STOPPING 流程去 dispose 一个 null scope。
    //
    //   ★ 这是一处真实缺口（被判别性测试逼出来的）：`ready` 算「活着」（见 isLiveState），
    //     但此前这里只认 ACTIVE ⇒ `deactivatePlugin` 对一个等触发的懒插件**完全无效**
    //     —— 显式停用后状态仍是 `ready`，用户根本停不掉一个懒插件。
    if (record.state === LifecycleState.READY) {
      this.#setState(record, LifecycleState.DISABLED);
      this.log('info', `Plugin deactivated while waiting to be triggered: ${pluginId}`);
      return;
    }
    if (record.state !== LifecycleState.ACTIVE) return;

    this.#setState(record, LifecycleState.STOPPING);
    this.log('info', `Deactivating plugin: ${pluginId}`);

    // deactivate() 与清理回调共用一份预算 ⇒ 停用在预算内【一定】走到 disabled
    const budget = record.lifecycleTimeoutMs ?? this.#lifecycleTimeoutMs;
    const deadline = budget > 0 ? Date.now() + budget : Infinity;
    try {
      if (record.entry && typeof record.entry.deactivate === 'function') {
        await runWithTimeout(() => record.entry.deactivate(), budget, () => new CordiumError(ErrorCode.LIFECYCLE_TIMEOUT,
          `Plugin '${pluginId}' deactivate() did not finish within ${budget}ms (it may still be running)`, { pluginId }));
      }
    } catch (err) {
      this.#logFailure('warn', `Error during plugin deactivate hook for ${pluginId}`, err, pluginId);
    } finally {
      if (record.scope) {
        // 预算用尽也给清理回调一个最小窗口（1ms）；宿主自有释放不受预算影响，一定执行
        const left = deadline === Infinity ? 0 : Math.max(1, deadline - Date.now());
        await record.scope.dispose(this.#scopeReleaseKey, { timeoutMs: left });
        record.scope = null;
      }
      this.#setState(record, LifecycleState.DISABLED);
      this.log('info', `Plugin deactivated and scope released: ${pluginId}`);
    }
  }

  /**
   * 移除插件：停用（若 ACTIVE）→ 从宿主删除全部记录；之后同 id 可重新注册。
   *
   * ★ 有【必需】依赖方时拒绝，报出名单 —— 不级联移除（同 VS Code 卸载不级联，#12957）。
   *   cordis 守的是同一不变式（提供者卸载时不得留有活的依赖方），但做法是先把依赖方卸回待定态；
   *   本内核没有「待定」态，依赖缺席即 boot 报 `Missing dependency` ⇒ 只能拒绝，不能代删。
   * ★ 可选依赖方不阻断：它们按「缺席」设计，移除后取服务得 `optional_unavailable`。
   * ★ 刻意保留：manifest 诊断（历史事实，不随插件消失）。注册代次来自契约级单调计数器，
   *   重新注册必然换号，旧句柄不会「复活」。
   * ★ 停用钩子期间若注册了新的必需依赖方 ⇒ 拒绝删除，插件保持【已停用】（不回滚激活）。
   * ⚠️ 错误通道有两种：入口处的 not found / 有依赖方是【同步抛出】（零副作用）；
   *   排队后在任务体内复验失败的是【Promise 拒绝】。调用方应同时处理两者（`await` 即可统一）。
   *
   * @param {string} pluginId
   */
  unregisterPlugin(pluginId) {
    assertStringArg('unregisterPlugin', 'pluginId', pluginId);
    const record = this.#plugins.get(pluginId);
    if (!record) throw new CordiumError(ErrorCode.PLUGIN_NOT_FOUND, `Plugin '${pluginId}' not found`);
    const assertNoDependents = () => {
      const dependents = this.#dependentsOf(pluginId);
      if (dependents.length > 0) {
        throw new CordiumError(ErrorCode.PLUGIN_HAS_DEPENDENTS,
          `Cannot unregister plugin '${pluginId}': required by ${dependents.map(id => `'${id}'`).join(', ')}`
        );
      }
    };
    assertNoDependents();

    return this.#serializeLifecycle(pluginId, async () => {
      // ★ 排队期间可能已被移除，或有新依赖方注册 ⇒ 任务体内重新校验
      if (this.#plugins.get(pluginId) !== record) throw new CordiumError(ErrorCode.PLUGIN_NOT_FOUND, `Plugin '${pluginId}' not found`);
      assertNoDependents();

      await this.#deactivatePluginNow(pluginId);
      // ★ 停用钩子是插件代码，可能在期间注册新的依赖方 ⇒ 删除前再验一次（失败则保持已停用、不删除）。
      assertNoDependents();
      this.#plugins.delete(pluginId);
      this.#pluginPermissions.delete(pluginId);
      this.#pluginDependencies.delete(pluginId);
      this.#pluginOptionalDependencies.delete(pluginId);
      // ★ `to` = null 表示「已不在表里」。★ 位置在删除【之后】—— 通知必须晚于事实，
      //   否则监听器回调里去查 `getDiagnostics()` 还会看到这个插件。
      this.#announcePresence(pluginId, LifecycleState.DISABLED, null);
      this.log('info', `Plugin unregistered: ${pluginId}`);
    });
  }

  // ════════════════ 插件 ctx（插件能拿到的全部能力都从这里出） ════════════════

  /**
   * 构造插件 ctx。
   *
   * ★ 为什么抽成方法：`ctx.scoped(label)` 要产出【同一种 ctx】，只是换了作用域键。
   *   若 scoped 返回一个手写的近似副本，两份定义迟早会漂移 ——
   *   新增的 ctx 能力只加在一边，另一边静默缺失（本项目已多次踩到「白名单重建」类缺陷）。
   *   ⇒ 唯一的 ctx 定义就在这里，scoped 只是换个 scopeKey 再调一次。
   *
   * ★ 作用域键走【闭包】而不是 ctx 上的字段：
   *   字段是插件可写的。若解析依据读的是 `ctx.scopeKey`，插件改一个字符串就能
   *   把自己的服务请求指向别人的作用域（与 ownerId 那次是同一类缺陷）。
   *
   * @param {string} pluginId
   * @param {import('./scope.mjs').EffectScope} scope
   * @param {string | null} scopeKey
   */
  #buildPluginCtx(pluginId, scope, scopeKey) {
    const record = this.#plugins.get(pluginId);

    const publish = (mode, name, args) => {
      if (!scope.active) {
        throw new CordiumError(ErrorCode.SCOPE_DISPOSED, `Plugin '${pluginId}' cannot publish '${name}': its scope is already disposed`);
      }
      return this.#channel.dispatch(mode, name, scopeKey ?? undefined, args);
    };
    // ★ 取用侧同样要过【这个 ctx 自己的】生命周期门：宿主侧的鉴权只按 id 查状态，
    //   同 id 重新激活后旧 ctx 会被当成新插件放行（旧 ctx 属于已结束的那一次激活）。
    const assertLive = (what) => {
      if (!scope.active) {
        throw new CordiumError(ErrorCode.SCOPE_DISPOSED, `Plugin '${pluginId}' cannot ${what}: its scope is already disposed`);
      }
    };

    // ★ 本 ctx 已加入过的子作用域（label → 作用域键）。同一激活里重复 `scoped(label)` 只在第一次登记 ——
    //   此前每调一次都给作用域引用计数 +1、往 scope 挂一个 disposer，常驻插件在热路径上写
    //   `ctx.scoped('agent').getService(...)` 会让两者随调用次数无上限增长（实测 5 万次 +11MB）。
    //   只记键、不缓存 ctx 对象：ctx 每次现造（廉价、用完即回收），不因缓存把它们攒在内存里。
    const joined = new Map();

    // ★ ctx 本身浅冻结 —— 与 manifest 同一口径（内核交给插件的一切都不可变）。
    //   只冻 ctx 这一层：scope 内部有活的 disposer 表，冻它会打断生命周期；其余值都是函数 / 已冻结的 manifest。
    //   插件改 ctx 本就提不了权（身份、作用域键都走闭包），这里防的是「把 ctx 当储物柜 / 替换方法」的自伤与不一致。
    return Object.freeze({
      pluginId,
      // ★ 交付【冻结副本】。宿主鉴权读的是 pluginPermissions / pluginDependencies，
      //   与此对象无关 —— 插件改它既提不了权，也不会污染宿主的诊断输出。
      manifest: freezeManifestForPlugin(record.manifest),
      scope,
      // ★ 第三参 selectAsActive 已随「选主」一并移除：一个名字一个提供者，注册者即活动提供者。
      //   作用域实现由 scoped(ctx) 提供，注册进的是【该作用域自己那一格】。
      provideService: (name, impl) => this.#registerService(name, pluginId, impl, scope, scopeKey),
      // ★ 身份由【闭包】注入，插件无法自证为别人（与 dispatch 的既有模式一致）
      getService: (name) => { assertLive(`get service '${name}'`); return this.#getService(name, pluginId, scopeKey, scope); },
      /**
       * 订阅一个服务名的生命周期变化。
       *
       * 这是 `internal/service` 的窄接口：插件只声明自己关心的服务名，
       * 宿主负责注入作用域并托管退订。回调收到的是冻结的轻量元数据，
       * 不会拿到提供者实现；需要重新使用服务时，必须重新调用 getService。
       */
      watchService: (name, listener) => this.#watchServiceForPlugin(pluginId, scope, name, listener, scopeKey),
      /**
       * 订阅**任意插件**的状态变更（启用 / 停用 / 激活失败 / 进入等触发…）。
       *
       * 适合的场景：某个装配层按内核注册表渲染界面，需要在「注册表刚变了」时重投影。
       * 此前没有这个时机，装配层只能**包装宿主的注册方法**来制造它 —— 而包装是在改别人的对象，
       * 内核把方法改成不可写或私有后它会**静默失效**（表现是「停用的插件面板还留在屏幕上」）。
       *
       * @param {(change: {id: string, from: string, to: string}) => void} listener 收到冻结的轻量元数据
       * @returns {() => void} 退订函数（作用域会托管它，插件停用后自动摘除）
       */
      watchPluginState: (listener) => this.#watchPluginStateForPlugin(pluginId, scope, listener, scopeKey),

      // ───────── 作用域 ─────────
      /**
       * 派生一个绑定了作用域的 ctx。
       *
       * 得到的新 ctx 有三件事变了：
       *   ① `getService` 按该作用域解析（就近优先，找不到回退全局）；
       *   ② `provideService` 注册进该作用域（同名服务可与全局实现共存）；
       *   ③ `on/once` 打上该作用域的标签，`emit/parallel/serial/bail/waterfall`
       *      以该作用域为派发键 —— 于是事件只在【本作用域及其祖先】之间流动。
       *
       * ★ 可以继续 `.scoped()` 派生子作用域，形成祖先链；
       *   事件放行是【向上延伸】的：父作用域的监听器收得到子作用域的事件，反之不行。
       *
       * ⚠️ label 是【隔离键】，不是权限凭证：两个插件用同一个 label 就共享同一个作用域。
       *   这是刻意的 —— 多 agent 协作正需要「agent 循环 / 记忆 / 工具」几个插件
       *   落在同一个 agent 作用域里。作用域划定的是【默认可见范围】，
       *   插件依然是同进程内不受沙箱约束的代码（与 OpenClaw 的自我定位一致）。
       *
       * @param {string} label
       * @returns {object} 新的 ctx
       */
      scoped: (label) => {
        if (typeof label !== 'string' || !label) {
          throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `ctx.scoped(label) requires a non-empty string label`);
        }
        // ★★ 用 ensureScope 而不是 declareScope：**加入不改写**。
        //   旧实现只在【有父作用域】时才登记，顶层键是"无记录"状态，
        //   于是第三方可以 `scoped(x).scoped(别人的顶层键)` 把它【追溯】挂到自己底下 ——
        //   实测后果：一个零声明插件就能让别人的 writer 作用域解析到 team 的私有实现。
        //   现在的位置在**首次创建时**定死，后来者只能加入、不能改写。
        const joinedKey = joined.get(label);
        if (joinedKey !== undefined) {
          assertLive(`derive scope '${label}'`);
          return this.#buildPluginCtx(pluginId, scope, joinedKey);
        }
        const requested = scopeKey ?? null;
        const binding = this.#channel.ensureScope(label, requested);
        // 请求的层级与实际不符 ⇒ 照常返回实际那个，但留痕（不改写、也不打红）
        if (!binding.created && binding.parent !== requested) {
          this.#channel.onScopeConflict(label, binding.parent, requested);
        }
        // ★ 加入/新建都是【效果】：随插件停用自动释放（引用计数 -1，归零才真正回收）。
        //   失败必须回滚计数 —— 否则计数虚高，这个键就永远回收不掉了。
        try {
          // ★ 一次性：同一次声明只能归还一次（插件即使拿到这个闭包反复调用也无效）
          let released = false;
          scope.addHostDisposer(() => {
            if (released) return;
            released = true;
            this.#channel.releaseScope(binding.key);
          }, this.#scopeReleaseKey);
        } catch (error) {
          this.#channel.releaseScope(binding.key);
          throw error;
        }
        joined.set(label, binding.key);
        return this.#buildPluginCtx(pluginId, scope, binding.key);
      },

      /**
       * ★ 派生一个【私有】作用域 —— 每次调用都是全新的一格，别的【作用域】蹭不到。
       *
       * ⚠️ 边界：放行规则里【无标签监听器全局可见】——
       *   在根 ctx 上 `ctx.on(...)`（不经 scoped）的监听器能收到私有作用域 emit 的事件。
       *   这是放行表的既定语义，不是漏洞；需要保密的数据不要走事件广播。
       *
       * 与 `ctx.scoped(label)` 的区别，一句话：
       *   `scoped('x')` 是【按名字共享】（同名即同域，刻意的 —— 多 agent 协作靠它），
       *   `privateScope()` 是【按身份独占】（连自己下一次调用都拿不到同一格）。
       *
       * 实现上就是给一个**新 symbol** 当作用域键：symbol 天然唯一，
       * 既不可能与字符串标签撞键，也不可能被别的插件"按名字"猜到。
       *
       * ★ 什么时候该用它：一个插件需要一块**只属于自己的**注册/事件空间，
       *   且明确不想和任何"碰巧同名"的插件混在一起。
       * ⚠️ 反过来说：**私有作用域无法被共享** —— 要跨插件共享，请用 `scoped(label)`。
       *
       * @returns {object} 绑定到新私有作用域的新 ctx
       */
      privateScope: () => {
        // ★ 生命周期门禁：与 `scoped()` 对齐。
        //   `scoped()` 不需要显式检查 —— 它要走 addDisposer，已释放的 scope 会当场拒绝。
        //   但 `privateScope()` 既不登记声明、也不挂 disposer，若不加这道门就会**静默放行**，
        //   插件能拿到一个"看起来能用"的 ctx（实测：`scoped()` 抛错而 `privateScope()` 返回对象）。
        //   已停用的插件不得再改世界、也不得再观察世界 —— 这条铁律对两个入口必须一致。
        if (!scope.active) {
          throw new CordiumError(ErrorCode.SCOPE_DISPOSED, `Scope for ${pluginId} is already disposed (privateScope rejected)`);
        }
        return this.#buildPluginCtx(pluginId, scope, Symbol('cordium.private-scope'));
      },

      // ───────── 信息中转层入口 ─────────
      // ★ 订阅即【效果】：监听器的生命周期跟随注册它的插件 ——
      //   插件卸载时 scope.dispose() 逆序执行 disposer，监听器自动摘除，
      //   插件作者不需要写任何清理代码。
      //   （依据 Cordis 官方文档："Event listener: removed automatically on unload"；
      //     其源码 events.ts 的 ctx.on → register → ctx.effect 即此模式（cordis f8ea3cd 下为 :134-141 / :154）。）
      on: (name, listener, options) => this.#subscribeForPlugin(pluginId, scope, name, listener, options, scopeKey),
      once: (name, listener, options) => {
        let off = null;
        let fired = false;
        off = this.#subscribeForPlugin(pluginId, scope, name, (...args) => {
          if (fired) return undefined;
          fired = true;
          if (off) off();
          return listener(...args);
        }, options, scopeKey);
        return off;
      },
      // 发布侧不需要 disposer（它不持有任何东西），但【派发键】必须带上 ——
      // 否则作用域监听器收不到自己作用域的事件，而无关监听器反而全都能收到。
      // ⚠️ 用 dispatch 而不是 channel.emit(...)：公开方法的签名已被可变参数占满，
      //    塞不下作用域键（见 channel.dispatch 的说明）。
      // ★ 发布侧同样过生命周期门 —— 已停用插件手里的旧 ctx 不得再「改世界」
      //   （此前 on/provide/register 都拒绝了，唯独 emit 系列照发）。
      //   getService / dispatch 也过同一道门（见上方 assertLive）。
      emit: (name, ...args) => publish(DispatchMode.EMIT, name, args),
      parallel: (name, ...args) => publish(DispatchMode.PARALLEL, name, args),
      serial: (name, ...args) => publish(DispatchMode.SERIAL, name, args),
      bail: (name, ...args) => publish(DispatchMode.BAIL, name, args),
      waterfall: (name, ...args) => publish(DispatchMode.WATERFALL, name, args),
      registerAction: (action, options) => this.#registerAction(action, pluginId, options, scope),
      // 插件内部发起 Action 调度时，强制绑定该插件的实际真实身份，严禁外部字符串伪造
      dispatchAction: async (action, payload) => { assertLive(`dispatch '${action}'`); return this.dispatchAction(pluginId, action, payload); },
      registerUIContribution: (contribution) => this.#registerUIContribution(contribution, pluginId, scope),
      // 已删除 `ctx.ui` / `bindUIHost()`：UI 能力走普通服务契约，理由见 design/removed-apis.md §2
      log: (level, msg, data) => this.log(level, `[${pluginId}] ${describeValue(msg)}`, data)
    });
  }

  // ════════════════ 服务：提供 / 撤销 ════════════════

  /**
   * 注册服务实现
   *
   * @param {string} serviceName
   * @param {string} providerId 提供者插件 ID
   * @param {any} implementation
   * @param {import('./scope.mjs').EffectScope | null} scope
   * @param {string | null} [scopeKey] 该实现服务的逻辑作用域；null = 全局（兜底）。
   *   来源是 ctx.scoped(label) 的【闭包注入】，不是插件能改的字段。
   */
  #registerService(serviceName, providerId, implementation, scope, scopeKey = null) {
    const contract = this.#serviceContracts.get(serviceName);
    // ★ 禁止「先注册先得」自动建契约：未由宿主登记的服务一律拒绝注册。
    //   否则插件能靠抢先注册，替宿主决定该服务的安全级别。
    if (!contract) {
      throw new CordiumError(ErrorCode.UNDECLARED_SERVICE,
        `Service '${serviceName}' has no host-declared contract `
        // ★ 只指向【公开 API 角色名】，不写产品装配层的物理路径。
        //   为什么：内核不该知道产品层把契约表放在哪个文件 ——
        //   那既是分层泄漏，也会在上层重构时变成一句
        //   「指向不存在文件」的过时提示，而它【没有任何测试守护】。
        //   API 名永不失效；物理路径会随每次重构漂移。
        + `(declare it in the host assembly layer via host.declareServiceContracts)`
      );
    }

    // ★ 生命周期门禁（放在最前）：已停用的 scope 不得再登记任何实现。
    //
    //   为什么必须有：registerService 全程不看 provider 状态、也不看 scope 是否已释放。
    //   插件只要保留着 ctx（很常见），停用后再调一次 provideService 就会【静默成功】——
    //   于是这个服务名被一条幽灵永久占死：
    //     · 消费者拿到的句柄每次调用都抛 service_unavailable；
    //     · 宿主装配路径（getInternalService 返回裸实现）会直接执行已停用插件的代码；
    //     · 正当的提供者想注册同名服务会被"已被 X 提供"拒绝 → 它 activate 抛错
    //       → boot() 整体回滚 → 整个应用起不来。
    //   ⇒ 一条注册噪音能把整机拖死，所以这里是硬门。
    if (scope && !scope.active) {
      throw new CordiumError(ErrorCode.SCOPE_DISPOSED,
        `Service Violation: plugin '${providerId}' cannot provide '${serviceName}' — `
        + `its scope is already disposed (a disposed plugin must not register anything)`
      );
    }

    // ★ 注册端校验：提供者必须在自己 manifest 的 provides 里声明过这个服务名。
    //   没有这一条，任何插件都能拿别人的服务名注册实现，把既有提供者挤掉。
    const provider = this.#plugins.get(providerId);
    if (!provider) {
      throw new CordiumError(ErrorCode.PLUGIN_NOT_FOUND, `Provider plugin '${providerId}' is not registered`);
    }
    if (!provider.manifest.provides.includes(serviceName)) {
      throw new CordiumError(ErrorCode.PROVIDE_NOT_DECLARED,
        `Service Violation: plugin '${providerId}' is not allowed to provide '${serviceName}' `
        + `(not declared in its manifest.provides)`
      );
    }
    // ★ 接口形状门（写表之前）—— 契约声明了 methods，实现就必须全都具备。
    //   此前拼错方法名的实现照样注册成功，消费者调用时才拿到不带 code、不指向提供者的引擎级 TypeError。
    //   全局槽与作用域实现走同一判定（两者都经本函数）。
    if (contract.methods) {
      // 实现可以是 Proxy：查方法时它的陷阱抛错 ⇒ 同样算「不合契约」，不让裸错误漏出（实测）
      let missing;
      try { missing = missingMethods(implementation, contract.methods); } catch (err) {
        throw new CordiumError(ErrorCode.INVALID_IMPLEMENTATION,
          `Service Violation: plugin '${providerId}' cannot provide '${serviceName}' — inspecting the implementation threw: ${describeError(err)}`,
          { pluginId: providerId, cause: err });
      }
      if (missing.length > 0) {
        throw new CordiumError(ErrorCode.INVALID_IMPLEMENTATION,
          `Service Violation: plugin '${providerId}' cannot provide '${serviceName}' — `
          + `implementation lacks method(s) ${missing.map(n => `'${n}'`).join(', ')}`,
          { pluginId: providerId }
        );
      }
    }
    // ★ 一个名字一个提供者：撞名即拒绝（同一个 providerId 重新注册放行）。
    //   为什么不静默覆盖、也不"选主"：静默行为会把「两个插件都想提供同一服务」
    //   这种逻辑错误掩盖成"看起来正常"，等某个 agent 的句柄莫名失效时才暴露。
    //   对照 Cordis `reflect.ts:189`（同名 provide 直接抛错）。
    //
    //   ★ 冲突判定的范围是【同一个作用域】：
    //     同名服务在【不同】作用域各有实现是合法且必要的（多 agent 各用各的），
    //     但同一个作用域内仍只允许一个 owner ——「一个名字一个提供者」没有被放松。
    //     ⚠️ 注意不能拿 providers.keys() 来判：那只是全局槽，
    //        作用域实现根本不在里面，用它判定等于对作用域【完全不做冲突检查】。
    let bucket;
    if (scopeKey === null) {
      bucket = contract.providers;
    } else {
      bucket = contract.scopedProviders.get(scopeKey);
      if (!bucket) {
        bucket = new Map();
        contract.scopedProviders.set(scopeKey, bucket);
      }
    }

    const existingProvider = Array.from(bucket.keys()).find(pid => pid !== providerId);
    if (existingProvider) {
      throw new CordiumError(ErrorCode.PROVIDER_CONFLICT,
        `Service Violation: service '${serviceName}' is already provided by plugin `
        // ★ String(scopeKey) 不可省：私有作用域的 scopeKey 是 **Symbol**，
        //   而 Symbol 进模板字面量会抛 `TypeError: Cannot convert a Symbol value to a string`
        //   （语言刻意设计，防「symbol 被悄悄变成字符串属性名」）。
        //   ⇒ 不包 String() 的话，撞名时抛的是**引擎级 TypeError**，
        //     而不是这条精心写的「one owner per service」提示 —— 排障拿到的是噪音。
        //   （同款正解已在本文件 onScopeConflict 处与 channel.mjs declareScope / #assertNoCycle 使用。）
        //   注意 `=== null` 判断要保留：全局槽的语义就是 null，不能显示成 'null'。
        + `'${existingProvider}'${scopeKey === null ? '' : ` in scope '${String(scopeKey)}'`} — plugin `
        + `'${providerId}' cannot provide it too `
        + `(one owner per service; use a registry service for multi-contribution)`
      );
    }

    // ★ 本次注册的代次：契约级单调计数器领新号（见 declareServiceContract 的 epochSeq 说明）。
    //   「同 ID 重新激活后注册的新实现」与「旧实现」靠号码区分 —— 只看「在不在册 + 是否 active」做不到。
    const nextEpoch = ++contract.epochSeq;

    if (scopeKey === null) {
      contract.providers.set(providerId, implementation);
      contract.providerEpochs.set(providerId, nextEpoch);
    } else {
      bucket.set(providerId, { impl: implementation, epoch: nextEpoch, scope });
    }

    if (scope) {
      scope.trackService(serviceName);
      // ★ 归属事实记在【宿主自己这边】，记的是 scope 对象身份而非它的名字。
      //   插件能改 scope 上的字符串，但改不了宿主手里的这张表。
      if (scopeKey === null) contract.providerScopes.set(providerId, scope);
    }

    // ★ 服务变更本身也是一条【信息】—— 通过通道广播出去。
    //
    //   为什么需要：消费者若在 activate() 里按当时的情况做了决定（缓存、连接、
    //   订阅），提供者变了它无从知晓。广播让它有机会重新适配。
    //   注意本层【不自动重启消费者】—— 只通知。是否重新适配由订阅者自己决定，
    //   因为"自动重载"意味着随时可能打断正在跑的工作（那正是选主被删掉的原因）。
    //
    //   载荷刻意保持【轻】：只带"够判断要不要关心"的信息，要完整实现自己去取服务
    //   （依据 Jenkins pubsub-light 的轻事件口径 —— 也让事件天然不撑上下文、零 token）。
    this.#channel.broadcast(SERVICE_CHANGE, Object.freeze({
      name: serviceName,
      providerId,
      scopeKey,
      action: 'registered',
      epoch: nextEpoch
    }));
  }

  /**
   * 注销服务实现
   *
   * @param {string} serviceName
   * @param {string} providerId
   * @param {string | null} [scopeKey] 该实现所属的作用域；null = 全局槽。
   */
  #unregisterService(serviceName, providerId, scopeKey = null) {
    const contract = this.#serviceContracts.get(serviceName);
    if (!contract) return;

    let had;
    let epoch = null;
    if (scopeKey === null) {
      had = contract.providers.has(providerId);
      epoch = contract.providerEpochs.get(providerId) ?? null;
      contract.providers.delete(providerId);
      // ★ 所有权记录与代次同步清理（代次来自单调计数器，删了也不会被复用）。
      contract.providerScopes.delete(providerId);
      contract.providerEpochs.delete(providerId);
    } else {
      const scoped = contract.scopedProviders.get(scopeKey);
      had = scoped ? scoped.has(providerId) : false;
      if (scoped) {
        epoch = scoped.get(providerId)?.epoch ?? null;
        scoped.delete(providerId);
        // 空桶要收掉，否则 scopedProviders 会长期残留一堆空作用域，
        // 而 #resolveProvider 每解析一次都要在这些空桶上走一遍。
        if (scoped.size === 0) contract.scopedProviders.delete(scopeKey);
      }
    }

    // 只在实际摘掉了一个提供者时才广播 —— 避免"注销根本不存在的服务"也发通知，
    // 那会让订阅者做无谓的重建。
    if (had) {
      this.#channel.broadcast(SERVICE_CHANGE, Object.freeze({
        name: serviceName,
        providerId,
        scopeKey,
        action: 'unregistered',
        epoch
      }));
    }
  }

  /**
   * 按 scope【对象身份】反查并注销该 scope 注册过的服务。
   *
   * 为什么不能像旧实现那样传一个 ownerId 字符串：
   *   Scope 会作为 ctx.scope 交给插件，若注销依据是一个插件可写的字符串，
   *   插件就能把自己伪装成别的插件去注销【别人的】实现，同时把自己的实现留成幽灵。
   * ★ 同族借鉴：**Kubernetes CVE-2025-5187**（节点给自己打 OwnerReference 删掉自己）。
   *   ⚠️ 只是**同族、不是同一机制**：K8s 的修法是「加检查阻止节点修改自己的 OwnerReference」，
   *   这里是「注销根本不看那个字段」—— 后者**拿掉了能力本身**，而不是去拦截它。
   *
   * 本方法只读宿主自己持有的 providerScopes，插件无法改写；
   * 且因为是"按 scope 摘除"，自己的实现也必然被摘干净。
   *
   * @param {string} serviceName
   * @param {import('./scope.mjs').EffectScope | null} scope
   */
  #releaseRegistration(serviceName, scope) {
    const contract = this.#serviceContracts.get(serviceName);
    if (!contract || !scope) return;

    // 先收集再删除：避免边遍历 Map 边改它。
    // ★ 两个槽都要扫：只扫全局槽的话，作用域实现会在插件停用时【残留成幽灵】——
    //   插件已经卸载，它的实现却还在服务表里对同作用域的其他调用方可见。
    const owned = [];
    for (const [pid, owner] of contract.providerScopes) {
      if (owner === scope) owned.push([pid, null]);
    }
    for (const [scopeKey, bucket] of contract.scopedProviders) {
      for (const [pid, entry] of bucket) {
        if (entry.scope === scope) owned.push([pid, scopeKey]);
      }
    }
    for (const [pid, scopeKey] of owned) {
      this.#unregisterService(serviceName, pid, scopeKey);
    }
  }

  // ════════════════ 服务：取用 / 解析 / 鉴权 ════════════════

  /**
   * 插件取服务入口 —— 带访问门禁，调用方身份【必须显式传入】。
   *
   * 身份由 ctx.getService 的闭包注入（见 activatePlugin），插件无法伪造成别的插件；
   * 宿主装配代码请改用 getInternalService()，不要从这里走。
   *
   * @param {string} serviceName
   * @param {string} callerPluginId 调用方插件 ID（缺省即拒绝，不得默认放行）
   * @param {string | null} [scopeKey] 调用方的作用域；null = 全局。
   *   来源是 ctx.scoped(label) 的【闭包注入】，不是插件能传的参数。
   */
  getService(serviceName, callerPluginId, scopeKey = null) {
    assertStringArg('getService', 'serviceName', serviceName);
    return this.#getService(serviceName, callerPluginId, scopeKey, null);
  }

  /**
   * @param {import('./scope.mjs').EffectScope | null} consumerScope 经 ctx 取用时为【这一次激活】的 scope。
   *   ★ 句柄失效判定此前只按 id 查消费者状态 ⇒ 同 id 重新激活后，上一次激活拿到的
   *   旧句柄复活（与 ctx 的 assertLive「旧 ctx 不得当成新激活」口径矛盾）。带上 scope 后按对象身份判。
   *   宿主直接调公开 getService 时为 null（没有 ctx 可言），退回按 id 判。
   */
  #getService(serviceName, callerPluginId, scopeKey, consumerScope) {
    const contract = this.#serviceContracts.get(serviceName);
    if (!contract) {
      throw new CordiumError(ErrorCode.UNDECLARED_SERVICE, `Service '${serviceName}' is not declared by host`);
    }
    // ★ 身份缺失不得放行：否则「不传身份」就成了布尔豁免的马甲。
    if (!callerPluginId) {
      throw new CordiumError(ErrorCode.IDENTITY_REQUIRED,
        `Service '${serviceName}' requires an explicit caller identity; `
        + `host assembly code must use getInternalService() instead of getService()`
      );
    }
    // ★ 可选依赖的提供者【不可用】⇒ 统一返回 optional_unavailable。
    //
    //   「不可用」有两种，必须都覆盖：
    //     ① 提供者插件根本没安装；
    //     ② 装了，但版本不满足调用方声明的可选范围 —— 约定是
    //        「版本不符时跳过拓扑依赖，**运行期视为不可用**」（见 resolveTopologicalOrder），不能让它伪装成可用服务；
    //     ③ 装了但未激活（见下方 resolved 为空的分支）。
    //
    //   且必须放在门禁【之前】：此时契约可能没有 activeProvider，
    //   declared/sensitive 校验无从谈起，先走门禁会把它误报成「未声明依赖」，
    //   调用方就拿不到那个稳定错误码了。
    if (contract.optionalProvider) {
      const providerId = contract.optionalProvider;
      const providerPlugin = this.#plugins.get(providerId);
      if (!providerPlugin) {
        throw optionalUnavailable(serviceName, `provider '${providerId}' is not installed`);
      }
      // 版本兼容性由【调用方自己声明的可选范围】决定；读宿主快照，不读插件可改的对象
      const expectedRange = this.#pluginOptionalDependencies.get(callerPluginId)?.get(providerId);
      if (expectedRange && !satisfiesSemVer(providerPlugin.manifest.version, expectedRange)) {
        throw optionalUnavailable(
          serviceName,
          `provider '${providerId}' v${providerPlugin.manifest.version} does not satisfy `
          + `the declared optional range '${expectedRange}'`
        );
      }
    }

    // 走到这里说明它不是「可选依赖不可用」，那就是真异常：根本没有提供者。
    // 必须放在门禁【之前】—— 否则「没有提供者」会被误报成「未声明依赖」，掩盖真问题。
    //
    // ★ 判据是【解析结果】，不是 providers.size：
    //   providers 只是全局槽，作用域实现的消费者在这里会拿到 size=0 而被误判成"没有提供者"。
    const resolved = this.#resolveProvider(contract, scopeKey);
    if (!resolved) {
      // ★ 可选提供者【已安装但未激活】（例如被用户停用）同样是「可选依赖不可用」——
      //   此前这里报通用错误，调用方拿不到约定的 optional_unavailable，无法按设计降级。
      //   ⚠️ 只看「未激活」：已 ACTIVE 却没注册服务仍是【真异常】，不得被降级吞掉
      //   （service-access「版本兼容且已安装」用例守护）。
      const optional = contract.optionalProvider && this.#plugins.get(contract.optionalProvider);
      if (optional && optional.state !== LifecycleState.ACTIVE) {
        throw optionalUnavailable(serviceName, `provider '${contract.optionalProvider}' is not active`);
      }
      throw new CordiumError(ErrorCode.NO_PROVIDER, `Service '${serviceName}' has no active providers`);
    }

    // ★ 门禁用【解析出来的那个提供者】判依赖声明，与下面拿到的是同一个。
    this.#assertServiceAccess(serviceName, contract, callerPluginId, resolved.providerId);

    // ★ 位置 3：捕获【该提供者】的代次，以及它落在哪个槽 —— 两者共同构成"我拿到的是哪一份注册"。
    const { providerId, impl, epoch, slotKey } = resolved;

    // ★ 返回【包装句柄】而非裸实现：提供者注销 / 重新注册 / 提供者或消费者停用后，
    //   之前发出去的句柄都必须失效 —— 否则停用的插件仍能拿着旧引用继续操作世界。
    return wrapServiceHandle(serviceName, impl, () => {
      const current = this.#serviceContracts.get(serviceName);
      if (!current) return `service '${serviceName}' is gone`;
      // ★ 顺序要紧：先判"还在不在"，再判"是不是同一代"。
      //   反过来的话，「已注销」会被误报成「重新注册」，诊断信息与真因不符。
      // ★ 按【我实际所在的那个槽】查，不是按调用方的作用域查：
      //   调用方在 agent:other 里拿到的可能是【全局兜底】的实现，
      //   拿 agent:other 去 scopedProviders 里找当然找不到 —— 那会把"兜底到全局"误报成"已注销"。
      const slotAlive = slotKey === null
        ? current.providers.has(providerId)
        : (current.scopedProviders.get(slotKey)?.has(providerId) ?? false);
      if (!slotAlive) {
        return `provider '${providerId}' was unregistered`;
      }
      // 纵深防御：我这一格还在，不代表解析还会落到我头上 ——
      // 作用域链上的拓扑变了（比如旁边新开了个更近的作用域注册了同服务的实现）也会把我挤掉。
      const still = this.#resolveProvider(current, scopeKey);
      if (!still || still.providerId !== providerId || still.slotKey !== slotKey) {
        return `provider '${providerId}' is no longer the active provider`;
      }
      if (still.epoch !== epoch) {
        return `provider '${providerId}' was re-registered (epoch ${epoch} → ${still.epoch})`;
      }
      // 只拒绝【已停用】状态：ACTIVATING / ACTIVE / STOPPING 都允许 ——
      // 插件在 activate() 里取用自己的服务是合法用法，停用过程中的清理调用也不该被拦。
      const provider = this.#plugins.get(providerId);
      if (!provider || isTerminated(provider.state)) {
        return `provider '${providerId}' is no longer active`;
      }
      const consumer = this.#plugins.get(callerPluginId);
      if (!consumer || isTerminated(consumer.state)) {
        return `consumer '${callerPluginId}' is no longer active`;
      }
      if (consumerScope && !consumerScope.active) {
        return `consumer '${callerPluginId}' obtained this handle in an earlier activation`;
      }
      return null;
    }, providerId);
  }

  /**
   * 内部装配入口 —— 不走插件门禁。
   *
   * 【不接受】调用方身份参数：边界由【方法所属对象】决定，而不是靠传参或开关。
   * 若两个入口是「同一个函数加 internal 开关」，那只是布尔豁免的马甲。
   *
   * @param {string} serviceName
   * @param {string | symbol | null} [scopeKey] 按哪个作用域解析；null = 全局
   */
  getInternalService(serviceName, scopeKey = null) {
    assertStringArg('getInternalService', 'serviceName', serviceName);
    const contract = this.#serviceContracts.get(serviceName);
    if (!contract) {
      throw new CordiumError(ErrorCode.UNDECLARED_SERVICE, `Service '${serviceName}' is not declared by host`);
    }
    // ★ 装配代码也可以按作用域取实现（例如宿主为某个 agent 组装专属工作流时）；
    //   不传即全局，与原行为一致。
    //   ★ 第二参是【作用域键】不是身份：传一个插件 ID 进来只会被当成作用域名解析，不做鉴权（有行为门禁）。
    const resolved = this.#resolveProvider(contract, scopeKey);
    if (!resolved) {
      throw new CordiumError(ErrorCode.NO_PROVIDER, `Service '${serviceName}' has no active providers`);
    }
    return resolved.impl;
  }

  /**
   * 解析服务的活动实现（两个入口共用）
   *
   * ★ 一个服务名只可能有一个提供者（registerService 撞名即拒），
   *   所以【同一个作用域内】只可能有一个提供者（registerService 撞名即拒）；
   *   需要多实现请改用【注册表服务】。
   *
   * ★ 作用域解析规则（注册视图向下继承）：
   *   从调用方的作用域出发沿【祖先链】向上找，**最近的先赢**；
   *   链上都找不到才回退【全局】实现。⇒ 全局实现永远是兜底，不会被作用域实现挤掉，
   *   而作用域实现也绝不会泄漏给链外的调用方。
   *
   * @param {{ providers: Map<string, any>, providerEpochs: Map<string, number>, scopedProviders: Map<string, Map<string, any>> }} contract
   * @param {string | null} scopeKey 调用方的作用域；null = 全局
   * @returns {{ providerId: string, impl: any, epoch: number, slotKey: string | null } | null}
   *   没有实现时返回 null（由调用方决定报什么错）。
   *   ★ `slotKey` 是这个实现【实际所在的槽】，它未必等于调用方的 scopeKey ——
   *     兜底到全局时 slotKey 是 null，沿祖先链命中时 slotKey 是那个祖先。
   *     句柄的"还在不在"必须按 slotKey 查，按调用方 scopeKey 查会在兜底路径上误报「已注销」。
   */
  #resolveProvider(contract, scopeKey = null) {
    // ★ 祖先遍历只有一份实现（ScopeTree#ancestors），经 MessageChannel#scopeAncestors 取
    for (const cursor of this.#channel.scopeAncestors(scopeKey)) {
      const hit = this.#providerInScope(contract, cursor);
      if (hit) return hit;
    }
    return this.#providerInScope(contract, null);
  }

  /**
   * 取【单个作用域】里的实现（不含祖先查找、不含全局回退）。
   *
   * @param {object} contract
   * @param {string | null} scopeKey 要查的槽
   * @returns {{ providerId: string, impl: any, epoch: number, slotKey: string | null } | null}
   */
  #providerInScope(contract, scopeKey) {
    if (scopeKey === null) {
      // 同一作用域最多一个提供者；Map 的唯一项就是当前注册。
      const [pid, impl] = contract.providers.entries().next().value || [];
      if (!pid) return null;
      return {
        providerId: pid,
        impl,
        epoch: contract.providerEpochs.get(pid) || 0,
        slotKey: null
      };
    }
    const bucket = contract.scopedProviders.get(scopeKey);
    if (!bucket) return null;
    // 桶内最多一条（撞名即拒）⇒ 直接取首元素，与上方全局槽同一个取法。
    // ★ 此前写成 `for (const [pid, entry] of bucket) return ...` —— 单次迭代的循环，
    //   语义正确但读起来像「漏了 break」（静态检查报的正是这一条）。
    //   这里守卫退化为「非空判断」而非全局槽的 `!pid`：pid 由 PLUGIN_ID_PATTERN 强制非空，
    //   两种守卫在本仓不可区分（若将来放开空 pid，需回来对齐）。
    const first = bucket.entries().next().value;
    if (!first) return null;
    const [pid, entry] = first;
    return { providerId: pid, impl: entry.impl, epoch: entry.epoch, slotKey: scopeKey };
  }

  /**
   * 按契约声明的 access 级别校验调用方是否有权取用该服务。
   *
   * 全部读【宿主持有的记录】（pluginDependencies / pluginPermissions），
   * 不读插件能改的对象 —— 这是鉴权依据隔离的落点。
   */
  #assertServiceAccess(serviceName, contract, callerPluginId, providerId) {
    const caller = this.#plugins.get(callerPluginId);
    if (!caller) {
      throw new CordiumError(ErrorCode.ACCESS_DENIED, `Security Violation: caller plugin '${callerPluginId}' is not registered`);
    }
    // ★ ACTIVATING 期同样允许取依赖：插件在 activate() 里取服务是合法用法，
    //   限制成「仅 ACTIVE」会逼着人把代码从 activate() 里搬走。
    if (caller.state !== LifecycleState.ACTIVE && caller.state !== LifecycleState.ACTIVATING) {
      throw new CordiumError(ErrorCode.ACCESS_DENIED,
        `Security Violation: caller plugin '${callerPluginId}' is not active (state=${caller.state})`
      );
    }

    if (contract.access === ServiceAccess.INTERNAL) {
      throw new CordiumError(ErrorCode.ACCESS_DENIED,
        `Security Violation: service '${serviceName}' is internal and cannot be accessed by plugins`
      );
    }

    // declared 与 sensitive 都要求：调用方声明过【提供者插件】的依赖
    if (contract.access === ServiceAccess.DECLARED || contract.access === ServiceAccess.SENSITIVE) {
      // ★ 必须查【真正会服务你的那个提供者】，而不是只看全局槽：
      //   调用方在自己作用域里拿到的是作用域实现，让它去声明全局提供者的依赖是查错了对象。
      const declared = this.#pluginDependencies.get(callerPluginId);
      if (!providerId || !declared || !declared.has(providerId)) {
        throw new CordiumError(ErrorCode.ACCESS_DENIED,
          `Security Violation: plugin '${callerPluginId}' did not declare a dependency on provider `
          + `'${providerId || '(none)'}' for service '${serviceName}'`
        );
      }
    }

    if (contract.access === ServiceAccess.SENSITIVE) {
      const granted = this.#pluginPermissions.get(callerPluginId);
      if (!contract.requiredPermission || !granted || !granted.has(contract.requiredPermission)) {
        throw new CordiumError(ErrorCode.ACCESS_DENIED,
          `Security Violation: plugin '${callerPluginId}' lacks required permission `
          + `'${contract.requiredPermission}' for service '${serviceName}'`
        );
      }
    }
  }

  // 已删除 `selectActiveProvider`（全局可变单点），理由与替代方案见 design/removed-apis.md §3

  // ════════════════ 通知：订阅 / 服务变更 ════════════════

  /**
   * 插件侧订阅事件 —— 把 disposer 登记进【调用方自己的 scope】（注册即效果）。
   *
   * 为什么不直接调 channel.subscribe：
   *   ① 必须把监听器的生命周期绑定到【注册它的那个插件】，否则插件卸载后监听器残留；
   *   ② scope 已 dispose 时必须【拒绝】—— 否则「已卸载的插件还能挂监听器」，
   *      这正是 ownerId 那类缺陷的同类（生命周期边界被击穿）。
   *
   * @param {string} pluginId 订阅者（ctx 闭包注入，出错时报归属用）
   * @param {import('./scope.mjs').EffectScope} scope
   * @param {string} name
   * @param {Function} listener
   * @param {{ prepend?: boolean, global?: boolean }} [options]
   * @param {string | null} scopeKey 调用方作用域，由 ctx 闭包提供
   */
  #subscribeForPlugin(pluginId, scope, name, listener, options, scopeKey) {
    // ★ scopeLabel 由【闭包】决定，并放在展开之后覆盖插件传的值 ——
    //   否则插件只要写 { scopeLabel: 'agent:别人' } 就能把自己打成别人的标签，
    //   从而【旁听】那份本不该看见的事件流。这与 getService 的身份注入是同一模式：
    //   身份/归属这类判据只能由宿主注入，绝不可作为参数接受。
    //
    // ★★ `global` 必须与 `scopeLabel` 一样【由宿主覆盖】。
    //
    //   缺陷：`global` 此前【原样透传】插件传的值，而 `#admit` 的第一行就是
    //     `if (record.global) return true;`  —— **一律放行**。
    //   ⇒ 插件只要写一句 `ctx.on('任意事件', fn, { global: true })`，
    //     就能收到**任意作用域**（含 `ctx.privateScope()`）的事件 —— **作用域隔离被整条绕过**。
    //   ★ 实测复现：带 `global:true` 收到 `["VICTIM-DATA"]`；不传则为 `[]`。
    //
    //   为什么这是【接收侧】的洞：`lifecycle-gates.test.mjs` 早已断言
    //     `ctx.broadcast` / `ctx.channel` / `ctx.emitGlobal` 均 `undefined`
    //     —— **发送侧堵了，接收侧没堵**。同一个「发给所有人」的能力换了个方向又开了一次。
    //
    //   ★ 项目自己的三条内证都指向该修：
    //     ① 本文件下方已把同类攻击写在纸面（「身份/归属判据只能由宿主注入」）；
    //     ② `lifecycle-gates.test.mjs` 堵了发送侧却没堵接收侧；
    //     ③ 本文件另一处自陈「**门开着，只是当前那位走对了**」。
    //
    //   ★ 口径同项目一贯做法：**不是靠拦截，而是让这个操作没有那个能力** ——
    //     插件 ctx 上**不存在**「全局订阅」这个选项。
    //   ⚠️ 宿主内部若确需全局订阅，走 `channel.broadcast`（独立出口，**不挂 ctx**，与既有口径一致）。
    //
    //   ★ 零误伤（实测）：全仓生产代码与测试对 `global: true` **均零命中**；
    //     且 `broadcast` 的实现**不看 `global` 标志**（它遍历全部监听器）——
    //     ⇒ 覆盖它不会影响任何既有路径。
    const off = this.#channel.subscribe(name, listener, {
      ...options,
      global: false,
      scopeLabel: scopeKey ?? null,
      owner: pluginId   // ★ 同理由宿主注入（ctx 闭包里的身份）：监听器出错时报的是真实归属，插件冒充不了别人
    });
    let undo;
    try {
      undo = scope.addHostDisposer(off, this.#scopeReleaseKey);   // ★ 已 dispose 的 scope 会在这里抛错
    } catch (error) {
      // ★ 登记失败必须【回滚订阅】—— 否则监听器就成了没人回收的孤儿，
      //   而这类泄漏恰恰是最难查的（功能看着正常，只是慢慢涨）。
      off();
      throw error;
    }
    // ★ 插件主动退订（或 once 触发）时，一并归还 scope 里的 disposer。
    //   此前只摘了通道里的记录，disposer 闭包留在 scope ⇒ 常驻插件反复 on/off 内存无上限增长
    //   （实测 1000 次 on/off 后 scope 里残留 1000 个 disposer）。
    return () => {
      undo();
      return off();
    };
  }

  /**
   * 插件侧的窄服务变更订阅。
   *
   * 服务变更通知走模块私有的 `SERVICE_CHANGE` symbol —— 插件拿不到它，
   * 既发不出伪造通知，也不能绕过本入口直接订阅。这个入口把服务名过滤、身份/作用域注入和生命周期
   * 托管合并成一个不可绕过的操作。
   *
   * @param {import('./scope.mjs').EffectScope} scope
   * @param {string} serviceName
   * @param {(change: { name: string, providerId: string, scopeKey: string | symbol | null, action: string, epoch: number | null }) => void} listener
   * @param {string | symbol | null} scopeKey
   * @returns {() => boolean}
   */
  /**
   * ★★ 插件状态变更的窄接口 —— 插件用它订阅任意插件的启停。
   *
   * ── 为什么必须有（这是下游实测出来的需求，不是我推测的）──────
   *   一个按内核注册表渲染界面的装配层，需要「内核注册表刚变了」这个时机来重投影。
   *   它此前**明确记录过这条缺口**，并因此放弃了自动同步：
   *     「内核**没有**「插件启停」事件 …… 本类若靠包装 `kernel.registerPlugin` 来实现自动同步，
   *      就是在**改别人的对象**：一旦内核把这些方法改成不可写（或换成 class 私有），
   *      包装会静默失效，而失效的表现是「停用的插件面板还留在屏幕上」」
   *   ⇒ 那条注释描述的做法（包装宿主方法）**正是本事件要取代的东西**。
   *
   * ── 形状与 `watchService` 完全一致 ──────────────────────────────
   *   · 事件名是**模块私有 symbol**：插件发不出也订不到（防伪造 registered / unregistered）；
   *   · 宿主经 `channel.broadcast` 发（绕开作用域放行规则，见其注释）；
   *   · 调用方只声明「我关心」，作用域注入与退订托管由宿主负责。
   *
   * ⚠️ 收到的是**冻结的轻量元数据**，不含插件记录本身：
   *   要拿别人的能力，仍必须走 `getService`（那条路才有鉴权）。
   *
   * @param {string} pluginId 订阅方（闭包注入，不可伪造）
   * @param {import('./scope.mjs').EffectScope} scope
   * @param {(change: {id: string, from: string, to: string}) => void} listener
   * @param {string | null} scopeKey
   */
  #watchPluginStateForPlugin(pluginId, scope, listener, scopeKey) {
    if (typeof listener !== 'function') {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'watchPluginState requires a function listener');
    }
    return this.#subscribeForPlugin(pluginId, scope, PLUGIN_STATE, listener, {}, scopeKey);
  }

  /**
   * ★★ 状态迁移的**唯一写入口**：改状态 + 广播。
   *
   * 为什么必须是一处：状态赋值此前散落在 **10 处**。要广播「插件状态变了」时，
   *   逐处插桩必然漏 —— 而漏的表现是「界面偶尔不刷新」这种最难查的 bug
   *   （与 `isLiveState` 抽出来的理由同源：一处判定，多处共用）。
   *
   * ★ 广播时机必须是【事实落定之后】：先写 `record.state`，再广播 ——
   *   否则监听器回调里读到的还是旧状态，它据此做的判断全是错的。
   *
   * ⚠️ 中间态（`activating` / `stopping`）也照实广播，不合并、不节流：
   *   「正在起」与「起来了」对界面是两件事（前者该显示加载态）。
   *
   * @param {object} record 插件记录
   * @param {string} next 新状态
   */
  #setState(record, next) {
    const from = record.state;
    if (from === next) return;
    record.state = next;
    this.#channel.broadcast(PLUGIN_STATE, Object.freeze({ id: record.manifest.id, from, to: next }));
  }

  /** 插件表**增删**同样是一次「注册表变更」—— 订阅方需要知道名单变了（from / to 为 null） */
  #announcePresence(id, from, to) {
    this.#channel.broadcast(PLUGIN_STATE, Object.freeze({ id, from, to }));
  }

  #watchServiceForPlugin(pluginId, scope, serviceName, listener, scopeKey) {
    if (!this.#serviceContracts.has(serviceName)) {
      throw new CordiumError(ErrorCode.UNDECLARED_SERVICE, `Service '${serviceName}' is not declared by host`);
    }
    if (typeof listener !== 'function') {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `watchService('${serviceName}') requires a function listener`);
    }
    return this.#subscribeForPlugin(
      pluginId,
      scope,
      SERVICE_CHANGE,
      change => {
        if (change.name === serviceName) listener(change);
      },
      {},
      scopeKey
    );
  }

  // ════════════════ 动作 / UI 贡献（委托 ActionRegistry / UIRegistry） ════════════════

  // ★ 动作表已抽成内部类 ActionRegistry（action-registry.mjs），这里只委托。
  #registerAction(action, ownerId, options, scope) {
    this.#actionHandlers.register(action, ownerId, options, scope);
  }

  /**
   * 执行安全受控动作调度 (严格基于调用方权限声明鉴权)
   * @param {string} callerPluginId
   * @param {string} action
   * @param {any} payload
   */
  async dispatchAction(callerPluginId, action, payload) {
    // ★★ 按需激活的触发点：**首次派发一个还没有处理器的动作**时，
    //   先把所有仍在等触发的懒插件拉起来，再重试一次。
    //
    //   ── 为什么这是本内核唯一可行的触发点（不是设计取舍，是契约约束）──
    //   `getService` 与 `emit` / `bail` / `waterfall` 都**同步返回**，而激活是异步的
    //   （`activate` 可以是 async、有超时）。把激活挂到服务取用或事件派发上，
    //   就得把这些 API 改成 async —— 那等于换一个框架。
    //   `dispatchAction` 本来就是 `async`，所以只有它能承载激活。
    //
    //   ── 为什么【只在未命中时】尝试 ──
    //   正常的 action 派发（热路径）不为此付出任何代价：查表命中就直接走。
    //   未命中才值得付一次「拉起懒插件」的代价 —— 而且只付一次（下面的 while 不循环）。
    let result;
    try {
      result = await this.#actionHandlers.dispatch(callerPluginId, action, payload);
    } catch (err) {
      if (err?.code !== ErrorCode.ACTION_NOT_FOUND) throw err;
      const woken = await this.#activateAllReady(`action '${action}' was dispatched`);
      if (woken === 0) throw err;        // 没有懒插件可拉 ⇒ 保持原来的 action_not_found 语义
      result = await this.#actionHandlers.dispatch(callerPluginId, action, payload);
    }
    return result;
  }

  /**
   * ★ 把所有仍在等触发的懒插件拉起来（依赖按递归收拢），返回真正启动了几个。
   *
   * ⚠️ 一次派发里**只调用一次**（调用方保证）：懒插件激活后自己注册动作是常见形态，
   *   所以「拉起 → 重试」是一对；若重试仍未命中，说明确实没有这个动作，
   *   再拉一轮不会有新东西，只会变成递归触发。
   *
   * ★ 单个懒插件激活失败【不阻断其它】—— 一个坏插件不该让所有按需插件都起不来；
   *   失败者已成 `failed` 并进了日志与诊断（`getDiagnostics().plugins[].state`）。
   *
   * @param {string} reason 记日志用（说明是什么触发的）
   * @returns {Promise<number>} 成功激活的个数
   */
  async #activateAllReady(reason) {
    let woken = 0;
    // ★ 直接迭代插件表：这一路只改 `state`，不增删条目（激活钩子拿到的是 ctx，注册不了插件），
    //   故无需为「迭代中改表」做快照。
    for (const [id, rec] of this.#plugins) {
      if (rec.state !== LifecycleState.READY) continue;
      try {
        await this.#activateReadyDependencies(id);
        await this.activatePlugin(id);
        woken += 1;
        this.log('info', `Lazy plugin '${id}' activated because ${reason}`);
      } catch (err) {
        // 不吞：失败的懒插件进 failed，原因进日志；其它懒插件继续尝试
        this.#logFailure('warn', `Failed to activate lazy plugin '${id}' (${reason})`, err, id);
      }
    }
    return woken;
  }

  // ★ UI 贡献表已抽成内部类 UIRegistry（ui-registry.mjs），这里只委托。
  #registerUIContribution(contribution, ownerId, scope) {
    this.#uiContributions.register(contribution, ownerId, scope);
  }

  #unregisterUIContribution(contributionId, ownerId) {
    this.#uiContributions.unregister(contributionId, ownerId);
  }

  /**
   * 获取当前所有可见的 UI 贡献（副本）
   */
  getUIContributions(type) {
    return this.#uiContributions.list(type);
  }

  // ════════════════ 诊断快照 ════════════════

  /**
   * 获取当前运行时完整诊断拓扑 (可用于空内核自检或可视化呈现)
   *
   * ★★ **稳定性契约**（allowlist 形态，与 k6 的措辞同一口径：
   *   「Only APIs **specifically mentioned within this document** are covered by our
   *     stability guarantees. Any API not explicitly included… may be subject to breaking changes.」）
   *
   *   本快照**分成两档**，点名的那部分才承诺兼容 —— 详见 `DIAGNOSTICS_CONTRACT`：
   *     · **稳定面**（`DIAGNOSTICS_CONTRACT.stable`，按**路径**逐层给）：
   *       点名的路径与键不删、不改名、不改类型；**枚举值可增不可改**
   *       （与 OTel / K8s 一致：加一个 `state` 取值不算破坏，改掉既有字面量才是）。
   *     · **不稳定面**（`DIAGNOSTICS_CONTRACT.unstable`）：随时可改，**不承诺**。
   *       人类可读文本与条数都在这一档 —— 与 K8s 同判：官方的**人类可读输出**不是稳定的
   *       机器契约（机器读走 `-o json`）。⚠️ 本文件此前引过一句声称是 K8s 原文的英文，
   *       联网复核在**一手页面查无**（只见于第三方转述），已删 —— 不拿二手转述冒充满一手引文。
   *   ★ 未点名的路径/键**一律不承诺** —— 不是「大概稳定」，是**明确不承诺**。
   *
   * ★★ **消费方契约**：只读稳定面点名的路径，**忽略未知字段**（Tolerant Reader）。
   *   内核加字段不改契约、也不该打到消费方；反过来消费方读了不稳定面，后果自负。
   *
   * ★ `schemaVersion` 随快照交出，供消费方判「这份快照按哪版契约读」；
   *   它本身**不在稳定面**（承诺它等于承诺「版本号不会变」，自相矛盾）。
   *   ★ 稳定面发生**不兼容**改动时才递增；**增字段不算**（增字段对守约的消费方无感）。
   */
  getDiagnostics() {
    return {
      // ★★ 契约版本随快照一起交出 —— 「这份快照按哪版契约读」是**消费方**需要的，
      //   不能只写在文档里（文档不会跟着 API 调用走）。取值来自契约表，不另写字面量。
      //   ⚠️ 它本身**不在稳定面**：稳定面发生不兼容改动时它才递增，承诺它等于承诺它不变。
      schemaVersion: DIAGNOSTICS_CONTRACT.schemaVersion,
      hostVersion: this.#hostVersion,
      booted: this.#booted,
      totalPlugins: this.#plugins.size,
      // ⚠️ 不再解构 `id`：它已在 MANIFEST_FIELD_TABLE.kernel 里，由下面的投影带出。
      //    留着会成为一个「与 id 同值但来源不同」的第二真相源。
      plugins: Array.from(this.#plugins.values()).map((p) => ({
        // ★★ manifest 字段由【契约表】派生，不手列。
        //
        //   为什么：手列会漏。本项目已同形踩了 4 次（optionalDependencies /
        //   optionalProvider / 契约未知键 / 本处的 kind+displayName+description）——
        //   每次都是「字段加进了 manifest 与 MANIFEST_FIELD_TABLE，投影忘了跟」。
        //   而手工清单的门禁救不了它：门禁也只检查它自己列的那几个，新字段
        //   **同时被实现和门禁忽略**，照常全绿。
        //
        //   ⇒ 判据取自唯一真相源：往契约表加字段 ⇒ 这里自动带出、门禁自动要求。
        //      **不需要任何人记得改两处。**
        ...manifestSnapshot(p.manifest),
        state: p.state,
        error: p.state === LifecycleState.FAILED ? describeError(p.error) : null,
        activationMs: p.activationMs
      })),
      services: Array.from(this.#serviceContracts.entries()).map(([name, s]) => ({
        name,
        access: s.access,
        requiredPermission: s.requiredPermission,
        // 接口形状（未声明 = null）；拷贝一份，诊断是只读快照
        methods: s.methods ? [...s.methods] : null,
        // 单提供者语义下，诊断值是当前全局槽的派生快照，
        // 不是可写的「活动主」状态。
        activeProvider: s.providers.keys().next().value || null,
        providerCount: s.providers.size,
        // ★ 上面两项只看【全局槽】—— 只注册了作用域实现的服务此前显示「0 个提供者」，
        //   与「确实没人提供」不可区分。作用域实现单独计数（各作用域桶之和），不混进全局口径。
        scopedProviderCount: Array.from(s.scopedProviders.values()).reduce((n, bucket) => n + bucket.size, 0),
        // ★ 计数是聚合口径，明细是排障口径（「哪个作用域由谁提供」）—— 两者分立，互不替代。
        //   与数据源同构：scopedProviders 是 Map<scopeKey, Map<providerId, entry>>，
        //   桶内单提供者（#registerService 撞名即拒）⇒ 每桶恰出一条；空桶注销即收，这里不会看到空桶。
        //   ★ scopeKey 可能是 Symbol（privateScope）⇒ 一律 String() 渲染，只供观察、不可回用
        //     （同 channel.scopes 的既定口径，见下方）。
        scopedProviders: Array.from(s.scopedProviders, ([scopeKey, bucket]) => ({
          scopeKey: String(scopeKey),
          providerId: bucket.keys().next().value ?? null
        }))
      })),
      actionsCount: this.#actionHandlers.size,
      permissions: [...this.#permissions].sort(),
      uiContributionsCount: this.#uiContributions.size,
      // ★ 条目逐个浅拷贝：此前交出的是审计日志条目本身，外部改 message 即篡改审计记录。
      //   details 是嵌套对象，浅拷贝仍共享它 ⇒ 再克隆一层。
      recentLogs: this.#auditLogs.slice(-20).map(copyLogEntry),
      // ★ 错误单独给一份（带栈）：recentLogs 是共享环形，可能已被 info 冲掉
      recentErrors: this.#errorLogs.slice(-20).map(copyLogEntry),
      errorLogCount: this.#errorLogs.length,
      // ★★ Manifest 字段诊断：带 path/pluginId 归属。
      //    它【不与审计/错误日志共享环形】—— 话多的 info 插件冲不掉它；
      //    但它【有自己的上限】（maxManifestDiagnostics），超出部分丢最旧并计入 dropped。
      manifestDiagnostics: this.#manifestDiagnostics.map(d => ({ ...d, fields: [...d.fields] })),
      // ★ 超限丢弃计数：非 0 即「丢字段问题规模异常」的信号。
      //   暴露它是为了让「有界」不变成「静默」。
      manifestDiagnosticsDropped: this.#manifestDiagnosticsDropped,
      // ★ channel 私有化后的只读摘要 —— 此前外部（含测试）直读 host.channel，
      //   同时也就能改它的钩子 / 上限 / 作用域表。这里只交计数与层级，不交通道本身。
      //   作用域键可能是 symbol（私有作用域）⇒ 一律 String() 渲染，只供观察、不可回用。
      channel: {
        listeners: this.#channel.eventNames().map(name => ({ name: String(name), count: this.#channel.listenerCount(name) })),
        scopes: this.#channel.scopeKeys().map(key => {
          const parent = this.#channel.scopeParentOf(key);
          return { key: String(key), parent: parent === null ? null : String(parent) };
        })
      }
    };
  }

  // 不设测试专用访问器（见 design/removed-apis.md §4）；测试观察工具在 test/fixtures/inspect.mjs
}
