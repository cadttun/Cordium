# Changelog

本文件记录 `@cordium/kernel` 与 `@cordium/plugins` 的有意变更（两包版本同步）。

格式基于 [Keep a Changelog 1.1](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer 2.0](https://semver.org/lang/zh-CN/)。
1.0 之前每次有意变更升 minor；`KERNEL_API_VERSION`（插件接口版本）独立演进，不随包版本走。

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

[Unreleased]: https://github.com/cadttun/cordium/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/cadttun/cordium/releases/tag/v0.2.0
[0.1.0]: https://github.com/cadttun/cordium/releases/tag/v0.1.0
