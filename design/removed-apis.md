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
而内核早已明确记录过这个反模式（`packages/kernel/src/action-registry.mjs` 原话）：

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

## 10. manifest：`config`

原位置：`packages/kernel/src/types.mjs`（字段表）/ `packages/plugins/src/runtime.mjs`（校验与克隆）

```text
⚠️ manifest 曾有字段 `config`（对象），**已删除**。

它此前被校验（必须是普通对象）、被深克隆产出，却**零读取路径** —— 内核字段表
（`MANIFEST_FIELD_TABLE`）从不认它，宿主只读加载清单的 `entry.config`。
⇒ 插件作者把默认配置写进 `manifest.config`，运行时永远拿到 `{}`
（实测：`CFG received config = {}`、`ctx.manifest.config = undefined`），
只留一条 `info` 级诊断 —— 而**插件自己读不到诊断**。
这是「声明了却永不生效」的负资产：它让人以为「config 已经有位置了」。
更早的根因是：`validateManifest` 按白名单**重建**输出，裸对象在这一步就被静默丢弃。

联网对标（VS Code / OSGi / cordis / OpenClaw）：无一家在清单里放「裸默认配置对象」，
主流形态是「schema 声明 + 用户覆盖 + 合并」（cordis 的默认值写在插件代码的 schema 里，
清单只放覆盖值）。唯一相近的 npm `config` 面向脚本环境变量，不在插件运行时这条路径上。

替代方案：真正生效的注入点是**加载清单的 `entry.config`**（`loadPlugins` 的 `config:`）——
  宿主 `const config = record.entry.config ?? EMPTY_CONFIG;`，经 `activate(ctx, config)`
  第二参交付（无配置时为冻结的 `{}`）。将来要做「插件自带默认值」，应做 **schema 形态**
  （对齐 cordis / VS Code），**不是**把裸对象加回来。

现状：manifest 里仍写 `config` 会被 `diffManifestFields` 报成 `unknownFields` ⇒ `warn`
  —— 响亮可见，这正是我们要的。
```

## 11. types：`LifecycleState` 的 `VALIDATED` / `WAITING_DEPENDENCIES`

原位置：`packages/kernel/src/types.mjs`

```text
⚠️ `LifecycleState` 曾有两个枚举成员 `VALIDATED` / `WAITING_DEPENDENCIES`，**已删除**。

**死枚举**：零赋值点、零断言、零下游 —— 随**首次提交**带进来的残留，运行期永不写入。

★ 它们曾经骗过人：调研时一度以为「状态机里已经有这两个状态，懒激活本来就有位置」，
  从而判断「按需激活不需要新增状态」。**静态阅读被运行时证据推翻**（规矩 52：
  主判据必须是运行时）—— grep `packages/*/src` 只有定义处命中，没有任何赋值。

★ 懒激活真正落地时**没有复用**它们：那两个名字说的是**别的事**
  （`VALIDATED` 像是「校验通过」，`WAITING_DEPENDENCIES` 像是「等依赖」），
  而新状态的语义是「**依赖齐备、等触发**」，故新造 `READY`。名字不许将就 ——
  语义不同的状态共用一个名字，比多一个名字更贵。
```

## 12. channel：`bail`

原位置：`packages/kernel/src/channel.mjs` / `packages/kernel/src/host.mjs`（`ctx.bail` 的接线）

```text
⚠️ `MessageChannel` 曾有 `bail(name, ...args)` 与 `ctx.bail`（`serial` 的同步版），**已删除**。

── 为什么删 ────────────────────────────────────────────────────────
它唯一的用处是「监听器全是同步函数时省一个 `await`」。为此要养：
  · 一套分发模式（`DispatchMode.BAIL` + 通道里两个方法 + `ctx` 上一个成员 + 一份文档表格）；
  · 一个**只在运行期才暴露的语义陷阱** —— 异步监听器返回的 Promise 恒为 truthy，
    会被 `isBailed` 判成「已拦截」，于是后面真正有答案的监听器被跳过，
    调用方拿到的还是个 Promise 而不是结果。此前靠一道**按返回值形状判错**的运行时检查
    兜住（抛 `invalid_usage` 并指向 `serial`）—— 那道检查本身就是在给一个不该存在的模式兜底。
  · 实测**消费方零调用**；本仓自己的用例也全部落在 `serial` 上，`bail` 只有专门为它写的测试。

⇒ 为一个 `await` 养一套模式不划算，且它最容易吸引的正是**写错**。
  要「第一个有回应的赢」时用 `serial` —— 它本就接受同步监听器，只是把结果包在 Promise 里。

★ **保留 `isBailed`**：它是「这个返回值算不算一个回应」的判据，由 `serial` / `waterfall`
  共用，与 `bail` 这个分发模式无关。「删 `bail` 就顺手删 `isBailed`」会让 `serial`
  的短路判定失去名字。

★ **不升 `KERNEL_API_VERSION`**：本次删除落在 0.3.0 内，而 0.3.0 **尚未发版** ——
  没有任何已发布的契约版本包含 `bail`，因此不存在需要迁移的消费者。
  （`CONTRIBUTING.md` 那条「破坏性变化升主版本」的判据据此写准为「**已发布**的契约版本」。）
```
