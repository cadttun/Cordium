# Changelog

本文件记录 `@cordium/kernel` 与 `@cordium/plugins` 的有意变更（两包版本同步）。

格式基于 [Keep a Changelog 1.1](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer 2.0](https://semver.org/lang/zh-CN/)。
1.0 之前：有意的 API 变更升 minor，纯文档 / 注释 / 内部修正升 patch。
破坏兼容的改动必须走 minor —— 0.x 的 patch 位会被下游的 `^0.x.0` 自动纳入，承载不了破坏性变更。
`KERNEL_API_VERSION`（插件接口版本）独立演进，不随包版本走。

## [0.3.0] - 2026-10-06

### Added

- **按需激活**：manifest 新字段 `activation`（`'eager'` 缺省 / `'lazy'`）。`lazy` 的插件在 `boot()` 时不激活，停在新的 `ready` 状态，等**被显式激活**或**首次派发一个未命中动作**时激活（后者会先递归拉起它自己的懒依赖）。`eager` 是缺省 ⇒ 不写这个字段的插件行为逐字不变。
  （触发点只有两个，这是**契约约束**而非取舍：`getService` 与 `emit` / `bail` / `waterfall` 都同步返回，把激活挂上去就得把它们改成 async。只有本就 async 的 `dispatchAction` 能承载激活。）
- `ctx.watchPluginState(listener)`：订阅任意插件的状态变更（含注册与移出、中间态与终态）。此前装配层要拿到这个时机只能包装宿主的注册方法 —— 那是在改别人的对象，内核把方法改成不可写后会静默失效。
- `@cordium/plugins` / `@cordium/kernel` 新导出：`ActivationPolicy` / `ACTIVATION_POLICY_VALUES` / `LogLevel` / `LOG_LEVEL_VALUES`。
- `host.declareUIContributionTypes(types)`：声明 UI 贡献 `type` 的合法值集（与 `declarePermissions` 同口径）。不调 ⇒ 不校验。
- 诊断快照的插件条目新增 `unresolvedDependencies: [{ id, reason }]`（`reason` 为 `'missing'` 或 `'version_mismatch'`）：**必需**依赖没满足时，此前快照只剩 `state: 'discovered'` + `error: null` —— 运维者**事后完全看不出「这个插件为什么没起来」**（`boot()` 当时会抛 `missing_dependency`，但回滚之后线索就没了）。只报 `{ id, reason }`、不带版本号：期望范围在 `dependencies` 里、实际版本在对方的 `version` 里，快照里都已经有了。可选依赖缺席按设计放行，不进这一项。
- `DIAGNOSTICS_CONTRACT`：诊断快照的**稳定性契约**（`@cordium/kernel` 的导出）。按**路径**逐层分区 —— `stable` 点名「不删 / 不改名 / 不改类型」的字段（枚举值可增不可改），`unstable` 显式列出**不承诺**的那些。快照随附 `schemaVersion`（结构版本；发生**不兼容**改动时递增，增字段不算）。
  （**未点名的路径/键一律不承诺** —— 不是「大概稳定」，是明确不承诺。消费方契约：**只读稳定面、忽略未知字段**。依据：allowlist 形态，与 k6 的措辞同一口径；分两档的形态取自 Kubernetes 指标（Alpha「no stability guarantees」/ Stable）与 OpenTelemetry（`/incubating` 子入口）。）

- **`boot()` 的失败半径**写进指南（`PLUGIN_GUIDE` §10）：静态装配期是**原子**的 —— 任一插件的必需依赖不满足，`boot()` 在**激活任何插件之前**就抛错，**整份清单都不启动**（含依赖齐备的插件），宿主停在 `booted === false`，不存在「半启动」；`boot()` **之后**加载的插件则是**隔离**的 —— 只有它自己进 `failed`，宿主照常运行。两个世界不同是有意的：静态清单由装配方自己写，依赖写错启动时就暴露最省事；动态插件来自外部，不该拖垮已经跑起来的宿主。同时给出「装配方要隔离谁」的做法（`boot` 之前读 `unresolvedDependencies` 纯查询一次拿全 —— `boot()` 自身一次只报碰到的第一个 —— 再 `unregisterPlugin`，有必需依赖方时从叶子往上摘）。`boot-failure-radius.test.mjs` 把两侧**一起**钉住：只测一侧的话，把任一侧改成另一侧的语义都照样全绿。

- 诊断字段 `unresolvedDependencies` 的 `reason` 从 2 类扩到 4 类：新增 `'cycle'`（与这个依赖**互相**可达 ⇒ 拓扑排序必然失败）与 `'not_running'`（依赖在、版本也对，但**此刻它跑不起来**：等触发的懒插件 / 被停用 / 已失败 / 它自己也被上游的环挡住）。
  （此前只有 `'missing'` / `'version_mismatch'` ⇒ **环依赖**与**依赖没跑起来**这两种情况下，插件同样停在 `discovered`、`error: null`，而这一项是**空数组** —— 与当初立这个字段要修的症状一模一样，换了个成因又回来了。★ 前两类与 `boot()` 的拒绝同源；后两类**不会**让 `boot()` 抛错，它们回答的是「它为什么没起来」。⚠️ `'not_running'` 只在宿主启动过之后才可能出现 —— `boot()` 之前人人都是 `discovered`，那不是「跑不起来」，否则 boot 前那份纯查询会误报。）

### Changed

- ★ `apiVersion` 判据的**破坏边界**改为「版本号里**最左的非零位**」（node-semver 对 caret 的定义原话）：
  major ≥ 1 比 major、`0.x`（x ≥ 1）比 minor、`0.0.x` 比 patch。此前 `0.x` 一律按 major 比，
  **比业界更宽松**（node-semver 与 VS Code 运行时都把 0.x 的 minor 当破坏边界，VS Code 甚至强制作者写出 minor）。
  ⚠️ 当前 `KERNEL_API_VERSION = '1.0.0'` 下两种写法**判定结果完全相同**，差异只在 0.x —— 但 0.x 是**可测的**
  （`isApiVersionCompatible` 是通用判据，描述符层还带 `options.apiVersion` 入口）。
- ★ 上述判据从「两层各写一遍」改为**一份实现共用**（内核 `types.mjs` 的 `isApiVersionCompatible`，经 `internal.mjs` 交给插件包）。
  此前两层各写一遍、靠测试逐值比对兜住；现在这条不变量是**结构上**成立的。
- `activate(ctx, config)` 的第二参**只有一种形状**：`host.registerPlugin` 路径此前完全不传（`undefined`），与 `loadPlugins` 路径（已冻结对象）不一致。现在没配置时传冻结的 `{}`。
  （依据是语言规范：`function activate(ctx, config = {})` 的默认参数在传 `undefined` 时同样生效 ⇒ 两种形状对遵循语言约定的插件逐字等价。）
- `log.level` 改为**成员校验**：只收 `debug` / `info` / `warn` / `error`，其余（含 `'Error'` / `'err'` 这类拼法）在写表之前抛 `invalid_argument`。此前拼错的值照收，后果是**不进专用错误缓冲、不带栈、零报错** —— 出错证据就这么消失了。
- `boot()` 中 `lazy` 插件被标记为「已跳过」：依赖它的急切插件同样不激活（依赖没跑过 `activate`，不能上线）。
- ★ `apiVersion` 的判定从「只比主版本」收紧为「**至少需要哪个 API 版本**」（**两层同步**：内核运行时契约与插件描述符契约）。
  此前内核 `KERNEL_API_VERSION = '1.0.0'` 时，插件写 `'1.99.0'` 会被**静默放行** —— 作者以为前置要求被检查了，其实没有。
  ★ **零迁移（实测）**：真实 manifest 的 `apiVersion` 声明共 **33 处**（本仓 14 + 消费方仓 19），取值**全部**是 `'1.0.0'` —— 逐处过两层校验全数放行，行为逐字不变。
  ⚠️ **行为变更**：插件若声明一个**高于内核**的版本（如 `'1.0.1'`），从此会被拒 —— 这正是修的目的。
- ★ `ctx.registerAction(name, options)` 的 `options` 改为**白名单**（`requiredPermission` / `handler` / `timeoutMs`），未知键在注册时抛 `invalid_option`。
  此前是裸解构 ⇒ 未知键被**静默丢弃**：`requiredPermission` 拼错会让**权限门直接消失**，`timeoutMs` 拼成 `timeout` 会静默回退宿主默认值。
  （口径取自本仓自己的分界线：**选项袋硬拒、声明式字段表才丢弃+诊断** —— 与 `CordiumHost` 构造 / `registerPlugin` / `replacePlugin` 同族。）
  ★ **零迁移（实测）**：消费方 4 处 `registerAction` 全部只传 `requiredPermission` + `handler`。
  ⚠️ **行为变更**：插件若传了未知键（含拼错的键），从此会在 `activate` 期被拒 —— 这正是修的目的。

### Removed

- **manifest 的 `config` 字段**：它此前被校验、被深克隆，却**没有任何读取路径**（内核字段表也不认它）—— 插件作者写了默认配置，运行时永远拿到 `{}`。现在写它会被告知为未知字段（`warn` 级诊断）。
  （**加载清单的 `config`（`loadPlugins` 的 `config:`）不受影响** —— 那才是真正生效的配置来源。）
- `LifecycleState` 的 `VALIDATED` / `WAITING_DEPENDENCIES`：**死枚举**（零赋值点、零断言、零下游，随首次提交带进来的残留）。

### Fixed

- ★★ **诊断契约门禁只验「键存在」，不验「类型」** —— 而契约文本明写承诺稳定面「不删、不改名、**不改类型**」。实测把 `totalPlugins` 从 number 改成 string，契约门禁**六条全绿**（全量里那几条红是别的测试偶然兜住的，不是门禁）。现补**类型签名锁**：稳定面每个键的类型逐字钉住，改类型必须显式改锁与契约文本。
  同处补上**枚举取值锁**：契约承诺 `LifecycleState` 取值「可增不可改」，而守它的**不是** `Object.freeze`（冻结只挡运行时改对象，挡不住改源码里的字面量）—— 现在既有取值逐字钉住、允许新增。
- ★★ **拓扑预检不认「被显式停用」的插件** ⇒ 外壳最顺手的隔离原语形同虚设：`deactivatePlugin` 停用一个依赖缺失的插件后再 `boot()`，**仍会因它抛 `missing_dependency`**，整个宿主起不来。而 `boot()` 的激活循环**是**认 `disabledByUser` 的 —— 同一件事两处判定不一致。
  现在拓扑预检同样跳过被显式停用的插件 ⇒ 「boot 前读 `unresolvedDependencies` → `deactivatePlugin` → `boot`」成为一条**非破坏性**的隔离路径（不必用会移除登记的 `unregisterPlugin`）。
- ★ `deactivatePlugin` 对一个**从未启动过**（`discovered`）的插件只打 `disabledByUser` 标记、**不改状态** ⇒ 装配方用加载清单的 `disabled: true` 登记后，快照里它显示 `discovered`，与「等着启动」**长得一模一样**。现在这类插件落 `disabled`（`LifecycleState.DISABLED` 本就是为这个存在的）。⚠️ 只挂**用户显式停用**这条路径：回滚与级联停用复用内部路径，在那里落 `disabled` 会把「本次没启动它」说成「用户停用了它」。
- `deactivatePlugin` 对一个等待触发的懒插件**完全无效**（内部路径只认 `ACTIVE`）⇒ 用户根本停不掉它。现在 `ready` 的插件可直接停为 `disabled`。
- 存活态判定此前以 `state === ACTIVE || state === ACTIVATING` 的形状散落在 5 处；引入第三种存活态后逐处修改必漏，现抽为共用的单一判定。
- ★★ **`registerAction` 的 `requiredPermission` 是假值 fail-open**：`if (requiredPermission)` 让 `''` / `0` / `false` 直接跳过声明校验，而落表时 `requiredPermission || null` 又把它变成「无门」—— **一个变量传了空串，权限门就悄悄没了**。
  现在与同函数 `timeoutMs` 的口径对齐（它早已是「不写 = 缺省，写了就全校验」）：只有**不写**才是「无门」，写了就必须是**非空字符串**，否则抛 `invalid_argument`；落表改用 `??`，派发侧改用 `!== null`，本文件里不再有 fail-open 形态。
  ★ **不另加 pattern**：权限名的形状已由 `declarePermissions` 的 `PLUGIN_ID_PATTERN` 保证（一处定义、插件 id / 服务名 / 权限名三处复用），再加一遍是冗余且必漂。
  ★ **零迁移（实测）**：消费方 4 处 `requiredPermission` 全是非空字符串。
- `@cordium/plugins` 六个入口的**导出面此前零门禁**（只钉了子路径键名，没钉每个入口里导出什么）：加一个 `export` ⇒ **全量测试全绿、无人拦**；而改名会红（既有测试在调它）—— 即**改名有人管、加导出无人管**，导出面可以无声膨胀。现补 `packages/plugins/test/public-surface.test.mjs` 逐字钉死（与内核侧 `public-surface.test.mjs` 同一口径）。

## 契约演进约定（服务契约的 `methods`）

服务契约由**装配方**声明，`methods` 是提供者必须实现的方法名清单。判定的依据是**改动落在哪一侧**，不是「改了什么」：

| 契约改动 | 谁被破坏 | 表现（实测） |
|---|---|---|
| **加** 一个方法 | **提供者** | 已在跑的提供者实现里没有这个方法 ⇒ 注册服务实现时即以 `invalid_implementation` 响亮失败。装配方需同步改实现 |
| **删** 一个方法 | **消费者** | 契约不再要求提供者实现它 ⇒ **提供者可以把它删掉**。此时仍在调用它的消费者拿到的是**引擎级 `TypeError`（`code` 为 `undefined`）**，不是 `CordiumError` —— 装配方须自己确认没有消费者在用，机器替不了 |
| 改 `access` / `requiredPermission` | 两侧都可能 | 门禁在**取服务**那一刻判，改严 ⇒ 既有消费者拿 `access_denied` |

两条推论：

- **提供者的破坏在注册期可见，消费者的破坏要到运行期才可见**（且如上表第二行，连错误码都没有）—— 所以删方法前必须自己确认消费方。
- 契约**不带版本号**：同一服务名同时存在两个不兼容版本，本内核不支持。真出现这种需求时，做法是拆成两个服务名，而不是给契约加 `version`。

## [0.2.2] - 2026-10-05

### Fixed

- 释放回调抛错不再**短路其余释放**：`EffectScope` 拆卸时「注销服务」与「注销 UI 贡献」两段循环此前是裸调，任一条回调抛错都会中断其后**所有**释放，并让 `dispose()` 拒绝。宿主是在 `await dispose()` **之后**才把插件状态置为 `disabled` 的，所以一条释放回调抛错就足以让插件**永久停在 `stopping`**（既不再 `active`，也到不了 `disabled`）。现在两段各自隔离、抛错经既有上报口记录，`dispose()` 必定走完 —— 该状态不再有产生路径。
  （依据是 JS 显式资源管理的既定语义：处置期的异常不得短路其余资源的处置，而应汇总上报。当前代码并无真实抛出路径，属防御纵深；此处按「消除唯一可失败的路径」处理，而非另加一层兜底。）
- README 安装说明里的版本号与 pack 产物名此前停在 `0.2.0`：照抄示例会指向**不存在的 tarball**。现随版本同步，并新增门禁防止再次漂移。
- 测试：`assert.rejects` 补上遗漏的 `await`（全仓同类断言中唯一一处裸调用，裸调用时断言失败会归因到文件、该用例仍显示通过）。

### Changed

- `SECURITY.md` 的支持版本口径写准：只列当前版本线与「更早的版本线」，并明确「不接收修复」的含义是**不做回移植**，不是「那个版本存在已知漏洞」；补「拿不准就直接报」。
- 静态检查工具 `oxlint` 改由 `devDependencies` 提供（版本精确，摘要进 lockfile），CI 与本地跑同一份二进制，不再 `npx` 现拉 —— 版本号钉死挡不住注册表投毒，摘要才能。**运行时零依赖不变**，并新增门禁钉住（两包 `dependencies` 不得含第三方）。
- 内部修正：CI 的 `npm ci` / `npx` 补 `--ignore-scripts`（对当前依赖链拦截不到任何东西，为将来引入依赖预留）；诊断快照的权限列表与权限集合比对写出显式比较器（行为逐位不变）；`#providerInScope` 的作用域分支改为与全局槽同一取法（逐字等价）。
- 版本同步门禁扩展到根 `package.json`（此前只覆盖两个包，根曾静默停在旧版本）。

## [0.2.1] - 2026-10-04

### Changed

- `configureIsolation` 拒绝原型链上的键名：`Object.prototype` 继承来的名字（`toString` 等）不再被当作合法的隔离配置键（此前 `in` 会放行它们）。全仓生产代码与测试对此零命中，无既有路径受影响。
- manifest 校验改为**聚合诊断**：manifest 多处出错时一次报出全部问题，不再逐条抛。单条问题的报文措辞与旧版逐字相同（既有契约不变），严格性门（空串 / 重复元素）不放松；真正不可克隆的 `config` 仍被拦下，TypedArray 不再被误报。
- manifest 校验把「归因」拆开：入口校验失败与 manifest 校验失败是两种报文，不再都算在加载头上。
- 插件 `activate` 中途失败时，回滚按依赖拓扑**逆序**撤销本次已启动的插件，且失败必须可见，不再静默留半装状态。

### Added

- 诊断快照的插件条目补出 `kind` / `displayName` / `description`（装配层此前读不到只能猜）。
- 诊断快照的服务条目新增 `scopedProviders` 明细：`[{ scopeKey, providerId }]` 配对可见「哪个作用域由谁提供」——此前 `scopedProviderCount` 只有聚合数字。`scopeKey` 一律按字符串渲染（私有作用域的 Symbol 键亦是），只供观察、不可回用；计数口径不变，两者分立。
- 诊断快照的插件条目与 manifest 字段投影改为**从契约表派生**：往字段表新增字段，投影自动带出，不再依赖手工子集同步。

### Fixed

- 8 处「判据形状」缺陷修复（判据取自不可靠来源或时效过期）：manifest 深冻结改为按类型泛化的递归冻结（不查字段名）；manifest 校验入口先快照后全程只读快照（TOCTOU）；`loader` 回滚兑现事务语义。

## [0.2.0] - 2026-10-02

### Changed

- manifest 移除 `restartRequired`（内核从未据此做任何事），由语义明确的 `hotReload` 取代；仍写 `restartRequired` 的 manifest 照常登记，该字段被丢弃并记一条诊断。
- **最低 Node 版本升到 22.13**（`engines: >=22.13.0`）：Node 20 已于 2026-04-30 停止维护；22.13 起权限模型 `--permission` 为稳定开关，`/isolation` 的 process 档不再回退 `--experimental-permission`。CI 矩阵改为 Node 22 / 24 / 26。

### Added

- `@cordium/plugins/reload`（开发期热重载）：`reloadPlugin(host, entry)` 重新加载插件模块并经 `replacePlugin` 换上；`watchPlugins(host, entries)` 监视插件文件，保存即重载，失败交给 `onError` 且监视继续。只重载 manifest 声明了 `hotReload: true` 的插件（可用 `force` 跳过）。ESM 无法卸载模块，每次重载都会留下一份旧模块，且只重载入口文件，仅供开发使用。
- manifest 新字段 `hotReload`（布尔，默认 `false`）：插件自报可在进程内热重载（只经 `ctx` 登记，或自己持有的资源都在停用时释放干净）；诊断快照的插件条目带出该值。
- `examples/`：可运行的示例（基础装配、开发期热重载），由测试实际运行。
- `host.replacePlugin(manifest, entry, options)`：原地替换已注册插件的 manifest 与代码（同 id）。依赖方先级联停下，换完按依赖顺序拉回；新版本须仍满足依赖方的版本范围；新代码激活失败则换回旧代码重新激活，再抛出原始错误。插件有必需依赖方时 `unregisterPlugin` 拒绝，升级 / 热重载走这里。
- 发版 workflow：发布 GitHub Release 时自动打包两个包，把 `.tgz` 与 `SHA256SUMS` 附到 Release 上；也可手动运行，给已有的 Release 补附件。

## [0.1.0] - 2026-09-30

首个公开版本。

### Added

- `@cordium/kernel`
  - `CordiumHost`：插件登记与卸载、按依赖拓扑启动（失败回滚）、级联停用与自动恢复、诊断快照。
  - 服务契约：访问级别（`public` / `declared` / `sensitive` / `internal`）、权限、可选提供者、`methods` 接口形状校验；服务句柄在提供者停用或替换后失效，且只读。
  - 动作：权限守门、超时、调用方身份由宿主注入；同时在途派发数上限（`maxInFlightActions`），防递归派发耗尽内存。
  - 消息通道 `MessageChannel`：`emit` / `parallel` / `serial` / `bail` / `waterfall`，支持作用域隔离。
  - 作用域：`ctx.scoped(label)` / `ctx.privateScope()`，服务就近解析、事件只在作用域链内流动。
  - `EffectScope`：插件注册的服务、动作、监听器、UI 贡献、定时器随停用统一回收；宿主自有释放先于插件清理回调执行。
  - 生命周期时限（`lifecycleTimeoutMs`，默认 30 秒），可由装配方按插件放宽。
  - 统一错误模型：`CordiumError` + 冻结码表 `ErrorCode`（48 码）；插件抛出的任意值包成 `action_failed` / `service_failed` / `listener_failed` 送达，原值在 `cause`。
  - 审计日志与错误日志（有界；`ctx.log` 的 `details` 超出节点 / 字节预算时换成截断标记，二进制按底层整块 buffer 计），manifest 丢字段诊断。
  - SemVer 工具：`isValidSemVer` / `compareSemVer` / `satisfiesSemVer`（语义对齐 node-semver 7.7.4）。
- `@cordium/plugins`
  - `/loader`：`loadPlugins` 按清单加载插件模块（`config` / `disabled` / `group` / `lifecycleTimeoutMs`），全有或全无。
  - `/isolation`：`callIsolated` 在 worker 线程或子进程（Node 权限模型）中执行函数，超时即终止；内存上限、并发与排队上限、ArrayBuffer 零拷贝移交；`configureIsolation` 调整上限。
  - `/runtime`：描述符层的 manifest 校验，列表与字段形状比内核更严格（`validatePluginManifest` / `validatePluginManifestDetailed`）；`name` 必须是非空字符串，不做类型转换（`/catalog`、`/ecosystem` 同）。
  - `/catalog`：插件元数据索引，支持导入导出与降级保护。
  - `/ecosystem`：`resolvePluginDependencies`（依赖拓扑排序、版本与环检测）、`callWithTimeout`。
- 错误定位：
  - 后台失败（`emit` 监听器、清理回调、生命周期钩子、启动回滚）的日志报文附 `[错误码] at 文件:行:列`；`details` 带 `pluginId`、`at`（源头位置）、各层栈与有界 cause 链。
  - 监听器错误（含 `serial` / `bail` / `waterfall`）标明所属插件，归属由宿主注入。
  - `loadPlugins` 遇到语法错误时报出文件、行号、源码行（含依赖文件、不存在的导入名）。
  - 隔离调用失败时报出插件内的出错位置，并保留隔离端栈。
- 打包：两个包的 tarball 附带 `LICENSE`；`npm test` 由 `scripts/run-tests.mjs` 列出测试文件，不依赖 shell 展开 glob。
- 文档：README、插件开发指南（PLUGIN_GUIDE.md）、贡献指南（CONTRIBUTING.md）。
- CI：Ubuntu 与 Windows × Node 20 / 22 / 24 测试与打包，oxlint 静态检查（含模块环检测 `import/no-cycle`）；workflow 只读权限、action 锁提交 SHA，dependabot 每月提升级 PR。
- 安全策略（SECURITY.md）：私密漏洞报告渠道与范围说明。

[Unreleased]: https://github.com/cadttun/cordium/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/cadttun/cordium/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/cadttun/cordium/releases/tag/v0.2.2
[0.2.1]: https://github.com/cadttun/cordium/releases/tag/v0.2.1
[0.2.0]: https://github.com/cadttun/cordium/releases/tag/v0.2.0
[0.1.0]: https://github.com/cadttun/cordium/releases/tag/v0.1.0
