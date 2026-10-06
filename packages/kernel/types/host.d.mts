/**
 * @file packages/kernel/src/host.mjs
 * @description 通用微内核宿主运行时 (CordiumHost) - 零业务逻辑
 *
 * 类内按「// ════ 区块名 ════」分段（按职责，不按公开 / 私有）：内部状态 → 构造 → 审计日志 → 宿主声明 →
 * 插件表 → 生命周期 → 插件 ctx → 服务提供 → 服务取用 → 通知 → 动作 / UI → 诊断。
 * 已抽出的独立职责：action-registry / ui-registry / scope-tree / service-handle / host-util（见各文件头）。
 */
import { UnresolvedReason } from './types.mjs';
export type PluginContext = {
    pluginId: string;
    /**
     * 冻结的 manifest 副本
     */
    manifest: import('./types.mjs').PluginManifest;
    /**
     * 本次激活的资源作用域
     */
    scope: import('./scope.mjs').EffectScope;
    provideService: (name: string, impl: object) => void;
    /**
     * 服务句柄（成员由服务契约声明，内核无从预知 ⇒ 任意）
     */
    getService: (name: string) => unknown;
    watchService: (name: string, listener: Function, options?: object) => void;
    watchPluginState: (listener: (change: {
        id: string;
        from: string | null;
        to: string | null;
    }) => void) => void;
    scoped: (label: string) => PluginContext;
    privateScope: () => PluginContext;
    on: (name: string, listener: Function, options?: object) => void;
    once: (name: string, listener: Function, options?: object) => void;
    emit: (name: string, ...args: unknown[]) => void;
    parallel: (name: string, ...args: unknown[]) => Promise<unknown>;
    serial: (name: string, ...args: unknown[]) => Promise<unknown>;
    waterfall: (name: string, ...args: unknown[]) => unknown;
    registerAction: (name: string, options?: object) => void;
    dispatchAction: (name: string, payload?: unknown) => Promise<unknown>;
    registerUIContribution: (contribution: object | string) => void;
    log: (level: string, message: unknown, details?: unknown) => void;
};
export declare class CordiumHost {
    #private;
    /** 宿主应用自身的版本（只读）
     * @returns {string}
     */
    get hostVersion(): string;
    /** 是否已成功 boot（只读；boot 失败回滚后为 false）
     * @returns {boolean}
     */
    get booted(): boolean;
    /** 审计日志环形缓冲上限（只读，构造时定）
     * @returns {number}
     */
    get maxLogSize(): number;
    /** 错误日志独立留存上限（只读，构造时定）
     * @returns {number}
     */
    get maxErrorLogSize(): number;
    /** Manifest 诊断留存上限（只读，构造时定）
     * @returns {number}
     */
    get maxManifestDiagnostics(): number;
    /** 动作默认执行上限毫秒数（只读，构造时定；0 或负数 = 不限）
     * @returns {number}
     */
    get defaultActionTimeoutMs(): number;
    /** 生命周期钩子（activate / deactivate + 清理回调）的默认执行上限毫秒数（只读，构造时定；0 或负数 = 不限）
     * @returns {number}
     */
    get lifecycleTimeoutMs(): number;
    /** 同时在途的动作派发数上限（只读，构造时定）
     * @returns {number}
     */
    get maxInFlightActions(): number;
    /**
     * @param {object} [options]
     * @param {string} [options.hostVersion='1.0.0']
     * @param {number} [options.maxLogSize=500]
     * @param {number} [options.maxErrorLogSize=100] 错误日志独立留存上限
     * @param {number} [options.actionTimeoutMs=30000] 动作默认执行上限（0 / 负数 = 不限）
     * @param {number} [options.lifecycleTimeoutMs=30000] 生命周期钩子默认上限（0 / 负数 = 不限）
     * @param {number} [options.maxInFlightActions=10000] 同时在途动作派发数上限
     * @param {number} [options.maxManifestDiagnostics=200] manifest 诊断留存上限
     */
    constructor(options?: {
        hostVersion?: string;
        maxLogSize?: number;
        maxErrorLogSize?: number;
        actionTimeoutMs?: number;
        lifecycleTimeoutMs?: number;
        maxInFlightActions?: number;
        maxManifestDiagnostics?: number;
    });
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
    log(level: any, message: any, details: any): void;
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
    recordManifestDiagnostic(diagnostic: {
        path: string;
        pluginId: string;
        fields: string[];
        severity?: string;
    }): void;
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
    declareServiceContract(serviceName: string, options?: {
        access?: string;
        requiredPermission?: string | null;
        optionalProvider?: string | null;
        methods?: string[];
    }): void;
    /**
     * 登记权限名（宿主装配阶段调用，须早于注册申请这些权限的插件）。
     * 幂等；名字须与插件 id 同一字符集（小写段以 . _ - 连接）。
     * @param {string[]} names
     */
    declarePermissions(names: string[]): void;
    /**
     * ★ 声明本应用用到的 UI 贡献 `type` 值集（UI 贡献 `type` 的成员校验）。
     *
     * 与 `declarePermissions` / `declareServiceContracts` **同一位置、同一口径**：
     * 由装配方在 boot 前一次性登记，插件不得自造。
     * ⚠️ 不调它 ⇒ 不校验（保持现有行为）；调了 ⇒ 登记之外的值在**注册 UI 贡献时**抛错。
     *
     * @param {string[]} types
     */
    declareUIContributionTypes(types: string[]): void;
    /**
     * 批量声明服务契约（宿主装配阶段调用：由上层应用在 boot 前一次性登记全部契约）
     * @param {Record<string, { access?: string, requiredPermission?: string | null, optionalProvider?: string | null, methods?: string[] }>} table
     */
    declareServiceContracts(table: Record<string, {
        access?: string;
        requiredPermission?: string | null;
        optionalProvider?: string | null;
        methods?: string[];
    }>): void;
    /**
     * 发现并注册插件。
     *
     * `rawManifest` 是**调用方自报的原始 manifest，形状未校验**（可能是任意对象 / 带 getter 的对象 / Proxy），
     * 故参数类型是 `unknown`；本方法经 `validateManifest` 把它判成并归一化为 `PluginManifest`。
     *
     * @param {unknown} rawManifest 调用方自报的 manifest，形状未校验
     * @param {{ activate?: Function, deactivate?: Function } | null} [entry] 插件执行入口 (可选对象，包含 activate/deactivate)
     * @param {{ lifecycleTimeoutMs?: number }} [options] 宿主侧对【这一个】插件的设置（装配方写，不是插件自己写）
     */
    registerPlugin(rawManifest: unknown, entry?: {
        activate?: Function;
        deactivate?: Function;
    } | null, options?: {
        lifecycleTimeoutMs?: number;
    }): void;
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
     * ⚠️ 错误通道同 unregisterPlugin：入口校验失败**同步抛出**；排队后失败是 Promise 拒绝。
     *   ★ 调用方用 `try { await … } catch` 可统一接住两者 —— 但 `assert.rejects(() => …)` **接不住同步抛**：
     *     Node 官方逐字「If `asyncFn` is a function and it throws an error synchronously, `assert.rejects()`
     *     will return a rejected `Promise` with that error. … **In both cases the error handler is skipped.**」
     *     ⇒ 匹配器**根本不会被求值**，测试以原始错误判失败（看不出本来想断言什么）。测试里包一层
     *     `async () => …` 把同步抛转成拒绝，才走正常断言路径。
     *
     * @param {object} rawManifest
     * @param {{ activate?: Function, deactivate?: Function } | null} [entry]
     * @param {{ lifecycleTimeoutMs?: number }} [options]
     */
    replacePlugin(rawManifest: object, entry?: {
        activate?: Function;
        deactivate?: Function;
    } | null, options?: {
        lifecycleTimeoutMs?: number;
    }): any;
    /**
     * 启动宿主运行时 (按依赖拓扑依次激活所有已注册插件)
     *
     * ★ `manifest.activation === 'lazy'` 的插件**不激活**：登记后停在 `ready`，等触发
     *   （显式 `activatePlugin`，或首次派发它登记的动作）。不写该字段的插件一律 `eager`
     *   ⇒ **现有行为逐字不变**。
     */
    boot(): Promise<void>;
    activatePlugin(pluginId: any): any;
    /**
     * 停用单个插件并彻底清理作用域
     * @param {string} pluginId
     */
    deactivatePlugin(pluginId: string): any;
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
     *   排队后在任务体内复验失败的是【Promise 拒绝】。
     *   ★ 调用方用 `try { await … } catch` 可统一接住两者；但**测试里**写 `assert.rejects(() => …)`
     *     **接不住同步抛** —— Node 官方逐字「In both cases the error handler is skipped」，
     *     匹配器不会被求值。包一层 `async () => …` 才走正常断言路径（同 replacePlugin 的注释）。
     *
     * @param {string} pluginId
     */
    unregisterPlugin(pluginId: string): any;
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
    getService(serviceName: string, callerPluginId: string, scopeKey?: string | null): any;
    /**
     * 内部装配入口 —— 不走插件门禁。
     *
     * 【不接受】调用方身份参数：边界由【方法所属对象】决定，而不是靠传参或开关。
     * 若两个入口是「同一个函数加 internal 开关」，那只是布尔豁免的马甲。
     *
     * @param {string} serviceName
     * @param {string | symbol | null} [scopeKey] 按哪个作用域解析；null = 全局
     */
    getInternalService(serviceName: string, scopeKey?: string | symbol | null): any;
    /**
     * 执行安全受控动作调度 (严格基于调用方权限声明鉴权)
     * @param {string} callerPluginId
     * @param {string} action
     * @param {any} payload
     */
    dispatchAction(callerPluginId: string, action: string, payload: any): Promise<any>;
    /**
     * ★ 宿主**以自身身份**派发一个动作 —— `callerPluginId === HOST_CALLER`。
     *
     * ── 为什么需要这个入口 ──────────────────────────────────────────────
     *   `dispatchAction(callerPluginId, …)` 要求宿主**报一个插件 id**，而派发前会查
     *   `isCallerLive` —— 宿主自己没有插件身份，于是**只能借一个正在跑的插件**，
     *   审计日志里记下的便是那个**被借的**身份。本入口让「宿主自己干的」有**一条诚实的路**。
     *   ★ 这与 `getService` / `getInternalService` 的分工**同构**，不再是不对称的一对。
     *
     * ── 什么时候**不要**用它 ────────────────────────────────────────────
     *   需要「**代表某个插件**」时，那是**委派**（delegation），语义不同 —— 审计要能同时看到
     *   「谁在做」与「代表谁」。用 `dispatchAction(pluginId, …)` 并**如实记录你在代表谁**。
     *   ⚠️ 别把「代表某插件」做成一个**调用方自由填的字符串**：那等于把归属判据交回调用方，
     *      正是本仓第一原则①与 CWE-441（confused deputy）的同一形态。
     *
     * @param {string} action
     * @param {any} [payload]
     * @returns {Promise<any>}
     */
    dispatchActionAsHost(action: string, payload?: any): Promise<any>;
    /**
     * 获取当前所有可见的 UI 贡献（副本）
     */
    getUIContributions(type: any): any[];
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
    getDiagnostics(): {
        schemaVersion: 1;
        hostVersion: string;
        booted: boolean;
        totalPlugins: number;
        plugins: {
            id: string;
            version: string;
            apiVersion: string;
            displayName: string;
            description: string;
            provides: string[];
            dependencies: Record<string, string>;
            optionalDependencies: Record<string, string>;
            permissions: string[];
            hotReload: boolean;
            kind: string;
            activation: string;
            state: any;
            error: string;
            activationMs: any;
            unresolvedDependencies: {
                id: string;
                reason: (typeof UnresolvedReason)[keyof typeof UnresolvedReason];
            }[];
        }[];
        services: {
            name: any;
            access: any;
            requiredPermission: any;
            methods: any[];
            activeProvider: any;
            providerCount: any;
            scopedProviderCount: any;
            scopedProviders: {
                scopeKey: string;
                providerId: any;
            }[];
        }[];
        actionsCount: number;
        permissions: any[];
        uiContributionsCount: number;
        recentLogs: any;
        recentErrors: any;
        errorLogCount: any;
        manifestDiagnostics: any;
        manifestDiagnosticsDropped: number;
        channel: {
            listeners: any;
            scopes: any;
        };
    };
}
