# 设计决策：已删除的接口（勿加回）

> 原是散在源码里的「这里曾有 X，已删除」注释块，**原文**迁到这里；
> 源码处只留一行指针。加回任何一项之前先读对应小节 —— 每一项都是实测出缺陷或形状错误才删的。

## 1. channel：`bindScopeParent`

原位置：`packages/kernel/src/channel.mjs`

```text
⚠️ 这里曾有一个 `bindScopeParent(childKey, parentKey)`，**已删除**。

  它只是 `declareScope` 的薄包装（校验两个非空键后原样转发），
  **生产调用点为零，只剩测试在用** —— 正是本项目反感的「为测试而存在的接口」。
  两个名字表达同一件事，还会让人犹豫该用哪个。
  ⇒ 按项目一贯口径「无向后兼容负担」，直接删掉；测试改用 `declareScope`。
```

## 2. host：`ctx.ui` / `bindUIHost()`

原位置：`packages/kernel/src/host.mjs`

```text
⚠️ 这里曾有 `ctx.ui`（registerPanel / registerCommand / registerTheme / registerSettings /
  registerContribution / attachSlot(slot, DOM元素)）与宿主的 `bindUIHost()`，**已删除**。
  它们照搬了某个上层应用 UI 包的接口形状（内核内无任何契约定义），与上面通用的 registerUIContribution 是两套平行注册表，
  且实测有两处缺陷：attachSlot 未过生命周期门；boot 之后才 bindUIHost 时已激活插件的 ctx.ui 永远是 null。
  ⇒ 通用基座不认识「面板 / 主题 / DOM」。上层应用若需要 UI 能力，应把它声明成普通服务契约
    （如 `declareServiceContract(<上层定义的 UI 服务名>, …)`），插件经 getService 取用 —— 契约、权限、scope 追踪全部复用。
```

## 3. host：`selectActiveProvider`

原位置：`packages/kernel/src/host.mjs`

```text
★ `selectActiveProvider` 已删除。

删除理由（架构级）：它是【全局可变单点】——被调用时，所有持有该服务句柄的
  消费者一起失效，包括正在跑长任务的其它 agent。「一个 agent 的动作改变
  另一个 agent 的世界」在核心层是不可接受的，且并发越多被打断概率越高。

替代方案：
  · 「该用哪个实现」⇒ 由上层应用的装配配置决定加载哪个插件
  · 「需要多实现」  ⇒ 改用【注册表服务】（服务内部自持 Map）
  · 「需要隔离」    ⇒ 后续的作用域隔离（一个服务名在不同 scope 下各有提供者）
```

## 4. host：`__test_*` 访问器

原位置：`packages/kernel/src/host.mjs`

```text
⚠️ 这里曾有 8 个 `__test_*` 访问器（宿主字段私有化时为保住测试而加），**已删除**。
  它们是「为测试而存在的接口」—— 与 channel.mjs 删除 bindScopeParent 同一口径。
  测试改走公开 API（getDiagnostics / getUIContributions / 插件 ctx），
  观察工具见 test/fixtures/inspect.mjs。
```

## 5. types：`ServiceKind`（SINGLETON / MULTI）

原位置：`packages/kernel/src/types.mjs`

```text
★ `ServiceKind`（SINGLETON / MULTI）已删除。

为什么删：MULTI 表达的是「一个服务名由多个提供者共同贡献」，配套机制是
  `activeProviderId` + `selectActiveProvider` 选主。但「选主」是一个【全局可变单点】——
  它被改时，所有持有该服务句柄的消费者一起失效，包括正在跑长任务的其它 agent。
  在「一个 agent 的动作不该改变另一个 agent 的世界」这条要求下，选主在架构上就不成立。

三个独立来源收敛到同一条规则：
  · Cordis      —— 同名 provide 直接抛错（reflect.ts:189）
  · OpenClaw    —— "One owner per responsibility … not competing owners"
  · Codex/cline —— 能力注册撞名即拒绝

⇒ 现在：**一个服务名在同一作用域下只允许一个提供者，撞名即抛错**。
  需要"多个实现"时改用【注册表服务】（服务内部自持 Map），例如一个 `tools` 服务对外提供 `register()`。
```

## 6. catalog：手写 `compareVersions`

原位置：`packages/plugins/src/catalog.mjs`

```text
★ 此处原有手写 `compareVersions`，已删除，改用内核 `compareSemVer`。
  原实现 `String(v).split('-', 2)` 会截断含连字符的预发布段（`rc-2` 与 `rc-1` 视为相等、
  `1.0.0--` 视为正式版）⇒ 降级检查可被绕过；数字段用 Number 比较，超过 MAX_SAFE_INTEGER 失真。
  它顶部那句「与 oracle 0 分歧」只覆盖了一小撮版本，没覆盖这些输入 ——
  「自测全绿」不等于正确：语料覆盖不到的地方，分歧本来就不会出现。
```

## 7. ecosystem：`PERMITTED_CAPABILITIES` / `isInfrastructurePermission`

原位置：`packages/plugins/src/ecosystem.mjs`

```text
⚠️ 这里曾有 `PERMITTED_CAPABILITIES`（能力词表）与 `INFRASTRUCTURE_PERMISSION_PREFIX` /
  `isInfrastructurePermission`（`perm.*` 命名空间约定），**已从 cordium 移除**。
  词表内容是**某个上层应用的业务词汇**，
  而 cordium 是通用基座 —— 「有哪些能力」由上层应用定义，不由内核预设。
  二者在 cordium 内零调用点；需要能力词表的上层应用自行维护词表与对应门禁。
```

## 8. ecosystem：`checkPluginPermission`

原位置：`packages/plugins/src/ecosystem.mjs`

```text
⚠️ 这里曾有一个 `checkPluginPermission(manifest, requestedCapability)`，**已删除**。

── 为什么删 ────────────────────────────────────────────────────────
它的签名是 `(manifest, capability)` —— **读的是「谁调用就传进来的那个 manifest」**。
而内核早已明确记录过这个反模式（`kernel/src/host.mjs` 原话）：

  「读【宿主持有的权限快照】，**不读 caller.manifest —— 后者正是交给插件的那个对象**，
    插件往里 push 一个字符串就能给自己提权。」

⇒ 它生产调用点为零（只有自己的测试在用），但**形状是错的**：
  **谁把它接上去，谁就凭空多出一道可伪造的门**。而仓库里同时存在正确实现与错误实现，
  选错的概率并不低 —— 所以它不是「死代码」，是**一把上膛的枪**。

── 能力词表 ────────────────────────────────────────────────────────
词表属于上层应用（见文件顶部说明）。上层若需要「插件只能声明词表内能力」，
应当用【门禁测试】扫自己的插件清单，**不放在可被误用的运行时函数里**。

★ 内核新增 `host.declarePermissions()`，插件申请 / action 守门所用的权限名
  都必须先由宿主登记，否则注册失败 —— 「两个插件自造名字互相授权」在结构上不再可能。
```

## 9. manifest：`restartRequired`

原位置：`packages/kernel/src/types.mjs`

```text
⚠️ manifest 曾有布尔字段 `restartRequired`（默认 false），**已删除**。

内核从未据此做任何事，文档也只能写「描述性标记」—— 它回答的问题（改了要不要重启）
没有任何代码在问。热重载落地后，真正被问到的是反方向的问题：「能不能不重启就换代码」，
且答案取决于插件持有什么（只经 ctx 登记 vs 自己持有端口 / 文件 / 子进程），只有插件自己知道。
⇒ 换成 `hotReload`（默认 false = 须重启），由开发期重载器据此放行。
  两个字段同时存在会互相矛盾（true / true 是什么意思？），故不保留旧字段。
```
