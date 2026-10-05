# Changelog

本文件记录 `@cordium/kernel` 与 `@cordium/plugins` 的有意变更（两包版本同步）。

格式基于 [Keep a Changelog 1.1](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer 2.0](https://semver.org/lang/zh-CN/)。
1.0 之前：有意的 API 变更升 minor，纯文档 / 注释 / 内部修正升 patch。
破坏兼容的改动必须走 minor —— 0.x 的 patch 位会被下游的 `^0.x.0` 自动纳入，承载不了破坏性变更。
`KERNEL_API_VERSION`（插件接口版本）独立演进，不随包版本走。

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

[Unreleased]: https://github.com/cadttun/cordium/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/cadttun/cordium/releases/tag/v0.2.2
[0.2.1]: https://github.com/cadttun/cordium/releases/tag/v0.2.1
[0.2.0]: https://github.com/cadttun/cordium/releases/tag/v0.2.0
[0.1.0]: https://github.com/cadttun/cordium/releases/tag/v0.1.0
