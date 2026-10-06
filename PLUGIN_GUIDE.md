# 插件开发指南

本文是写 Cordium 插件所需的全部接口说明，按它写不需要读内核源码。示例都按**可直接运行**写（Node.js ≥ 22.13，ES Module）：**manifest 示例有门禁逐条核对**（内核层与描述符层都必须收下），其余示例**未在 CI 里真跑** —— 照抄后若拿不准，以仓库 [`examples/`](examples/) 目录里的完整可运行版本为准。

- [1. 插件长什么样](#1-插件长什么样)
- [2. manifest](#2-manifest)
- [3. ctx：插件能用的全部能力](#3-ctx插件能用的全部能力)
- [4. 服务](#4-服务)
- [5. 动作](#5-动作)
- [6. 事件](#6-事件)
- [7. 作用域](#7-作用域)
- [8. 生命周期与资源回收](#8-生命周期与资源回收)
- [9. 错误](#9-错误)
- [10. 装配方要做的事](#10-装配方要做的事)
- [11. 执行隔离（可选）](#11-执行隔离可选)
- [12. 约束速查](#12-约束速查)
- [13. 测试与调试](#13-测试与调试)

---

## 1. 插件长什么样

一个插件就是一个 ES 模块，导出 `manifest`，外加可选的 `activate` 与 `deactivate`：

```js
// plugins/counter.mjs
export const manifest = {
  id: 'demo.counter',
  name: 'Counter',
  version: '1.0.0',
  apiVersion: '1.0.0',
  provides: ['counter']
};

export function activate(ctx, config) {
  let n = config.start ?? 0;
  ctx.provideService('counter', {
    next: () => ++n,
    current: () => n
  });
  ctx.log('info', `counter starts at ${n}`);
}

export function deactivate() {
  // 可选。服务、监听器、动作等由宿主自动回收，这里只需释放你自己开的外部资源
}
```

也可以用默认导出同形对象：`export default { manifest, activate, deactivate }`。

- `activate(ctx, config)`：插件被激活时调用，可以是 `async`。`config` 来自装配方的加载清单，**已冻结**；直接用 `host.registerPlugin` 登记时是**空对象 `{}`**（不是 `undefined`）。两种情况都请写成 `config = {}` 有默认值的形状，或用 `config.foo ?? 默认值` 取用。
- `deactivate()`：插件被停用时调用，可以是 `async`。
- 两个钩子默认各有 **30 秒**上限（装配方可调整），超时的激活判为失败。

## 2. manifest

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | ✅ | string | 全局唯一。小写字母和数字组成的段，段之间用 `.` `_` `-` 连接，如 `acme.search-index` |
| `version` | ✅ | string | 插件自身版本，合法 SemVer，如 `1.2.0` |
| `apiVersion` | ✅ | string | 语义是「**至少需要哪个**内核接口版本」—— ★ **只是一个下界**：放行只保证宿主内核**不低于**它，**不承诺宿主行为从此稳定**（`KERNEL_API_VERSION` 冻结的是接口的**形状**，行为仍可在 minor 里收紧/改变；内核自身尚未到 1.0）。判据两条：**最左非零位相同**（当前 `1.0.0` ⇒ 主版本必须相同），且**内核 ≥ 你声明的号**。⇒ 现在写 `'1.0.0'`；写**高于内核**的号（如 `'1.0.1'`）会被拒 —— 内核还没有那个 API。 |
| `provides` | | string[] | 本插件会提供的服务名。**不在这里的服务名不能 `provideService`** |
| `dependencies` | | object | 必需依赖：`{ '插件id': 'SemVer 范围' }`，如 `{ 'demo.counter': '^1.0.0' }`。**只收这一种形态**（数组写法已取消：它写不下范围，只能一律当 `*`，等于静默放弃版本约束） |
| `optionalDependencies` | | object | 可选依赖，写法同上。缺席时不影响本插件激活 |
| `permissions` | | string[] | 本插件申请的权限名。必须是装配方登记过的名字 |
| `kind` | | `'core'` \| `'business'` | 插件类别，默认 `business`。只是描述，「core 能否被用户停用」由应用决定 |
| `activation` | | `'eager'` \| `'lazy'` | 默认 `eager`（`boot()` 时激活）。写 `'lazy'` 则登记后停在 `ready`，等**被显式激活**或**首次派发它登记的动作**时才激活；它的必需依赖会被**连带激活**（递归，先深后己） |
| `displayName` / `description` | | string | 展示用 |
| `name` | | string | 插件目录 / 市场用的名称（见下一小节）。内核不保留，登记时丢弃并记一条 `info` 级诊断 |
| `hotReload` | | boolean | 默认 `false`。写 `true` 表示本插件可以在进程内热重载：它只在 `ctx` 上登记东西，或自己开的外部资源都在 `deactivate` / `ctx.scope` 里释放干净。开发期重载器只重载写了它的插件，见 [§10](#开发期热重载) |

- 不在上表的字段会被丢弃，并记一条诊断（`host.getDiagnostics().manifestDiagnostics`）。**分级按整条诊断判定**：这条 manifest 里只要有**两层都不认**的字段（多半是拼写错误），整条记 `warn`，同一条里被列出的描述符字段（如 `name`、`config`）也一并算在该条的 `fields` 里；一个都不认的字段也没有时，才记 `info`。
- 插件拿到的 `ctx.manifest` 是规范化后的**冻结副本**，改它不会影响宿主，也不能借此提权。
- 依赖范围语法与 npm 相同（`^1.2.0`、`~1.2`、`>=1 <2`、`1.x`、`*` 等）；`latest` 之类的 tag 不是合法范围。

**哪些插件不该写 `'lazy'`**：写 `'lazy'` 的前提是「**没人调用它之前，它不做任何事也不要紧**」。所以：

- **被广泛依赖的基础设施**（日志 / 存储 / 配置等）宜 `eager` —— 它们通常是被别的东西顺带拉起来的，
  自己再懒只是把激活推迟几微秒，却让「依赖链上哪一环还没起来」多一层不确定性。
- **需要在外壳渲染前就位的东西**宜 `eager` —— 例如要往 UI 里登记贡献的插件：
  懒激活的触发点只有「显式激活」与「派发同名动作」两个，**外壳画界面不属于任何一个**
  ⇒ 用户会看到一个缺了这块的界面，而且不报错。
- **纯响应式的业务插件**（只有被调用时才干活）才适合 `'lazy'`。

★ 反过来说：**急切插件依赖一个懒插件时，那个急切插件在 `boot()` 时会被跳过**（依赖没跑过 `activate`，
不能上线），而且**懒依赖后来被触发也不会把它自动拉起来** —— 要它上线得显式 `activatePlugin`。
它的诊断快照会报 `unresolvedDependencies: [{ id: <懒依赖>, reason: 'not_running' }]`，
所以这件事**看得出来**，但不会有任何报错。这个组合基本总是写错了：要么把被依赖的那个改成 `eager`，
要么把依赖方也改成 `'lazy'`。

★ 这三条是**本内核自己的约定**，不是外部规范 —— 外部只有正向指引（如 VS Code 建议慎用 `*`），
没有「哪些扩展应当 eager」的官方清单。

### 插件目录 / 市场用的 manifest

上表是内核（`host.registerPlugin` / `loadPlugins`）认的字段。`@cordium/plugins` 的 `/runtime`（`validatePluginManifest`）、`/catalog` 与 `/ecosystem` 用的是另一套**描述符**字段，面向插件目录 / 市场：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `version` | ✅ | 同上表 |
| `name` | ✅ | 非空字符串，目录里显示的名称。**内核不认这个字段**（会丢弃并记一条 `info` 级诊断，不影响运行） |
| `apiVersion` | | 同上表；缺省按当前接口版本填充（内核要求必填，本层更宽） |
| `provides` / `permissions` | | 同上表，但更严格：必须是数组，不能有空项和重复项 |
| `dependencies` | | 同上表 |
| `kind` | | 同上表 |
| `activation` | | 同上表 |

描述符**不保留** `optionalDependencies` / `displayName` / `description` / `hotReload`。

要让同一份 manifest 既能运行又能上架，就写成两套字段的并集。本文与 README 的示例都已带上 `name`，可以直接上架。内核登记这份 manifest 时会丢掉 `name`，并记一条 `info` 级诊断，这是预期行为。

**配置从哪来**：只有一个来源 —— 装配方通过 `loadPlugins` 清单的 `config` 传入（见 §10）。manifest 里**没有** `config` 字段（曾经有过，但它从不生效：既不传给插件，也没有任何读取路径，只会让作者以为默认配置生效了）。

## 3. ctx：插件能用的全部能力

`activate` 收到的 `ctx` 是冻结对象，**19 个成员分三档**。第一次读只需看第一档，其余按需查阅。

### 3.1 主干（8 个）

每个插件几乎都会用到。实测消费方对这 8 个全部有调用点。

| 成员 | 返回 | 用途 |
|---|---|---|
| `pluginId` | string | 本插件 id |
| `manifest` | object | 冻结的 manifest 副本 |
| `provideService(name, impl)` | undefined | 提供服务，见 [§4](#4-服务) |
| `getService(name)` | 服务句柄 | 取用服务 |
| `registerAction(name, options)` | undefined | 注册动作，见 [§5](#5-动作) |
| `dispatchAction(name, payload)` | **Promise** | 调用动作 |
| `on(name, listener, options?)` | 退订函数 | 订阅事件，见 [§6](#6-事件) |
| `log(level, message, details?)` | undefined | 写宿主审计日志。`level` **必须是** `debug` / `info` / `warn` / `error` 之一，写别的（包括 `'Error'`、`'err'` 这类拼法）当场抛 `invalid_argument` —— 只有 `error` 级会进诊断的专用错误缓冲并附栈，拼错就等于让出错证据消失 |

### 3.2 作用域（3 个）

三个成员同属一套机制（见 [§7](#7-作用域)）—— 需要按 agent / 会话隔离时才读。实测消费方只用到 `scope`。

| 成员 | 返回 | 用途 |
|---|---|---|
| `scope` | EffectScope | 本次激活的资源作用域，见 [§8](#8-生命周期与资源回收) |
| `scoped(label)` | 新 ctx | 进入命名作用域，见 [§7](#7-作用域) |
| `privateScope()` | 新 ctx | 进入只属于这一次调用的私有作用域 |

### 3.3 通道与观察（8 个）

事件派发的其余形态，加上「订阅服务 / 插件状态的变化」。场景明确，但不常用 —— 实测消费方对其中 5 个（`once` / `parallel` / `serial` / `watchService` / `watchPluginState`）零调用。

| 成员 | 返回 | 用途 |
|---|---|---|
| `once(name, listener, options?)` | 退订函数 | 只触发一次的订阅 |
| `emit(name, ...args)` | undefined | 广播，不等回执 |
| `parallel(name, ...args)` | **Promise** | 广播并等待所有监听器完成 |
| `serial(name, ...args)` | **Promise** | 依次询问，第一个给出结果的胜出 |
| `waterfall(name, ...args, fallback)` | 结果（链上有 async 时为 Promise） | 中间件链 |
| `watchService(name, listener)` | 退订函数 | 监听某个服务的注册 / 注销 |
| `watchPluginState(listener)` | 退订函数 | 监听**任意插件**的状态变更（注册 / 启停 / 等触发 / 激活失败）。回调收到冻结的 `{ id, from, to }`；`from` 为 `null` 表示新注册，`to` 为 `null` 表示已移出。中间态（`activating` / `stopping`）也会推 |
| `registerUIContribution(item)` | undefined | 登记一条 UI 贡献（`{ id, type, ... }` 或字符串 id）。`type` 由装配方用 `host.declareUIContributionTypes([...])` 声明值集；声明了之后写别的值当场抛 `invalid_argument`（没声明则不做校验） |

- `dispatchAction` 总是返回 Promise；`parallel` / `serial` 正常调用返回 Promise（旧 `ctx` 上会先同步抛 `scope_disposed`，见下条）。`waterfall` 在**实际走到**的监听器与 `fallback` 都同步时直接返回结果，实际走到某一环返回 Promise 时整条链返回 Promise，稳妥的写法是一律 `await`。其余方法都是同步的。
- 插件停用后，手里留着的旧 `ctx` 基本都失效：除 `log` 外，登记、发布、取服务、派发动作、事件订阅与派发、`scoped` / `privateScope`，调用时都抛 `scope_disposed`。两处例外：`log` 不报错（只留日志，便于收尾）；`provideService` 在服务名未声明契约时，先报 `undeclared_service`（该项检查在生命周期门之前）。`dispatchAction` 是异步的，错误只会经 Promise 拒绝送达；`parallel` / `serial` 正常调用时监听器错误也走 Promise 拒绝，但生命周期门是**同步检查** —— 旧 `ctx` 上调用会**同步抛** `scope_disposed`。旧 `ctx` 的调用一律用 `try { await … } catch` 包住（同步抛与 Promise 拒绝都能接住）。
- `ctx` 不能加、改、删属性（严格模式下抛 `TypeError`）。
- `log` 的 `details` 在写入时被克隆（之后改原对象不影响日志）。单条上限 1 万个节点（对象属性 / 数组元素 / Map·Set 项）或 1 MiB（字符串按长度；二进制按底层整块 buffer 计，小视图套大 buffer 也按大的算）；超出时整条 `details` 换成 `{ truncated: true, reason }`，克隆不了的（函数等）换成 `{ unclonable: true, reason }`，`log` 本身不抛。大数据请只记摘要。

## 4. 服务

服务是点对点的「我提供一个对象，别人调它的方法」。

### 提供

```js
export const manifest = { id: 'acme.store', name: 'Store', version: '1.0.0', apiVersion: '1.0.0', provides: ['kv'] };

export function activate(ctx) {
  const data = new Map();
  ctx.provideService('kv', {
    get: (key) => data.get(key),
    set: (key, value) => { data.set(key, value); }
  });
}
```

要成功提供，需同时满足：

1. 装配方声明过这个服务的契约（否则 `undeclared_service`）；
2. 服务名写在自己 manifest 的 `provides` 里（否则 `provide_not_declared`）；
3. 契约若声明了 `methods`，实现必须有全部这些方法（否则 `invalid_implementation`）；
4. 同一作用域里只能有一个提供者，别的插件已提供则 `provider_conflict`。同一插件重复提供会替换自己的实现；**提供者一经停用、注销或重新激活，此前发出去的所有句柄一律失效**（即使服务名与实现看起来没变），消费者必须重新 `getService`。

**为什么第 2 条（必须先声明）要卡这么严**：换来的是**一份可静态审计的 manifest** ——
「这个插件会提供什么」在**不运行任何代码**的前提下就能读出来（拼写错误在启动那一刻即被发现，
而不是等某个动作调不通），也是权限推导与依赖分析的基础。

代价是**放弃了「运行时动态提供服务」的灵活性**：插件不能在 `activate` 里临时决定多提供一个服务名。
★ 若将来真需要那种形态，这条应当放宽为「**未声明则告警**」而不是现在的直接拒绝 —— 但现在不需要，
所以保持严格。（同一模式的外部先例：Grafana 的 `extensions.exposedComponents` 官方原文
「Components that are **not listed here won't work**」；反例是 VS Code 的 `registerCommand`
与 OSGi 的 `registerService`，两家都**不校验**是否预先声明。）

### 取用

```js
export const manifest = {
  id: 'acme.app', name: 'App', version: '1.0.0', apiVersion: '1.0.0',
  dependencies: { 'acme.store': '^1.0.0' }
};

export async function activate(ctx) {
  const kv = ctx.getService('kv');
  kv.set('greeting', 'hi');
  ctx.log('info', kv.get('greeting'));
}
```

能不能取到，看装配方给契约定的访问级别：

| 访问级别 | 谁能取 |
|---|---|
| `public` | 任何已激活的插件 |
| `declared` | manifest 的 `dependencies` 或 `optionalDependencies` 里写了**提供者插件 id** 的插件 |
| `sensitive`（默认） | 同 `declared`，且 `permissions` 里有契约要求的权限 |
| `internal` | 插件取不到，只有装配代码能用 `host.getInternalService(name)` 取 |

取不到时的错误码：没声明契约 `undeclared_service`；没有提供者 `no_provider`；可选提供者未安装 / 未激活 `optional_unavailable`；访问级别不满足 `access_denied`。

### 句柄的规则

`getService` 返回的是**句柄**，不是实现对象本身：

- 每次调用方法都会先检查服务是否仍然有效。提供者停用、注销或重新提供后，旧句柄的方法调用抛 `service_unavailable`，需要重新 `getService`。所以**不要长期缓存句柄**。长期运行的插件可以用 `watchService` 在服务变化时重新获取：

  ```js
  let kv = ctx.getService('kv');
  ctx.watchService('kv', (change) => {
    // change: { name, providerId, scopeKey, action: 'registered' | 'unregistered', epoch }
    if (change.action === 'registered') kv = ctx.getService('kv');
  });
  ```

- 句柄只读：不能给它赋值、删属性（`access_denied`）。
- 实现的方法抛出任何值（包括返回的原生 Promise 被拒绝）时，调用方收到 `service_failed`，`err.pluginId` 是提供者，原始错误在 `err.cause`。方法返回的是自制 thenable（非原生 Promise）时，句柄原样交回、不替它调用 `then`，它的拒绝不会被包装。
- 实现是原始值（数字、字符串）时原样返回，没有句柄。

## 5. 动作

动作是带权限守门和超时的命名调用，适合「命令」式的操作。

**提供方** —— 一个插件登记动作：

```js
export function activate(ctx) {
  ctx.registerAction('acme.export', {
    requiredPermission: 'perm.export', // 可选：调用方须持有该权限（权限名须由装配方登记）
    timeoutMs: 10000,                  // 可选：默认用宿主的 actionTimeoutMs（30 秒）
    handler: async (payload, { callerPluginId, action }) => {
      return { ok: true, rows: payload.rows.length };
    }
  });
}
```

**调用方** —— 另一个插件。它得**先在 manifest 里申请这个权限**（在 `permissions` 数组里写上 `'perm.export'`，权限名必须由装配方 `declarePermissions` 登记过），否则派发会被 `access_denied` 挡下：

```js
const result = await ctx.dispatchAction('acme.export', { rows: [1, 2, 3] });
```

- 动作名全局唯一，重复注册抛 `duplicate_action`。
- 调用方身份由宿主注入（`callerPluginId`），不能伪造。
- 超时只是**停止等待**：处理器仍在后台跑完，副作用照样发生。有副作用的处理器应自己保证幂等。
- 失败时调用方收到的错误码：

| 码 | 含义 |
|---|---|
| `action_not_found` | 没有这个动作 |
| `access_denied` | 调用方未激活，或缺少 `requiredPermission` |
| `action_timeout` | 本次调用超时 |
| `action_failed` | 处理器抛出了任何值（包括它内部再派发别的动作失败）。`err.pluginId` 是处理器所属插件，原始错误在 `err.cause` |
| `action_owner_gone` | 执行期间处理器所属插件被停用，结果作废 |
| `action_overloaded` | 同时在途的派发数达到上限（默认 1 万，通常是递归派发失控），处理器没有被调用。递归派发时它发生在最深一层，外层调用方收到的是层层包裹的 `action_failed`，要沿 `err.cause` 往下找 |

## 6. 事件

事件是一对多的通知，发布方不知道谁在听。

```js
ctx.on('task/created', (task) => { /* ... */ });       // 返回退订函数
ctx.on('task/created', handler, { prepend: true });    // 排到最前面
ctx.emit('task/created', { id: 1 });
```

| 发布方式 | 行为 | 监听器抛错时 |
|---|---|---|
| `emit(name, ...args)` | 依次调用所有监听器，不等待，不返回结果 | 不影响其它监听器，错误写进宿主日志 |
| `await parallel(name, ...args)` | 同时调用并等待全部完成 | 全部跑完后抛 `listener_failed`，各原始错误在 `err.cause.errors` |
| `await serial(name, ...args)` | 依次 `await` 每个监听器，第一个返回「有效值」的胜出并作为结果 | 立即抛 `listener_failed`，原始错误在 `err.cause` |
| `waterfall(name, ...args, fallback)` | 中间件链：监听器签名 `(...args, next)`，调 `next()` 往下传，`next(新参数)` 改写参数，不调则就此返回；都放行时由 `fallback(...args)` 收尾 | 同上；`fallback` 自己抛的错原样抛出 |

「有效值」指 `undefined`、`null`、`false` 以外的返回值（`0` 和 `''` 也算有效）。

`waterfall` 的返回类型与抛错方式**看实际走到的那一环**：派发是同步递归 —— 监听器不调 `next()`（直接返回）或抛错时链就断了，整条链同步结束、结果直接返回或错误同步抛；只有**实际走到了**一个 `async` 监听器时，`next()` 才会落到微任务里，整条链才升级为 Promise，错误也改经拒绝送达。因为「会不会走到异步环」要看运行期，稳妥的写法一律 `await`。

```js
// 谁能处理这个文件？
ctx.on('file/open', (path) => path.endsWith('.md') ? 'markdown-viewer' : undefined);
const viewer = await ctx.serial('file/open', 'notes.md'); // 'markdown-viewer'

// 中间件：给文本加前后缀
ctx.on('render', (text, next) => next(`<b>${text}</b>`));
const html = ctx.waterfall('render', 'hi', (text) => text); // '<b>hi</b>'
```

- 事件名是任意非空字符串，建议 `领域/动作` 形式。
- 监听器随插件停用自动摘除，不需要手动退订。

## 7. 作用域

`ctx.scoped(label)` 返回一个绑定了作用域的新 `ctx`，用来让一组插件在同一个「房间」里协作而不干扰别人，例如每个 agent 或会话一个作用域：

```js
const room = ctx.scoped('agent:42');
room.provideService('memory', impl);   // 只在 agent:42 里生效的实现
room.getService('memory');             // 优先取本作用域的实现，没有再取全局的
room.on('turn/done', handler);         // 只收 agent:42（及其子作用域）里发的事件
room.emit('turn/done', result);
```

- 同一个 `label` 就是同一个作用域，**不同插件用同一个 label 会进入同一个作用域**，这是有意设计的共享方式。label 是隔离键，不是权限凭证。
- 作用域可以嵌套：`ctx.scoped('agent:42').scoped('tool')`。
- **服务解析**：由近到远找本作用域及祖先作用域的实现，最后回退到全局。
- **事件放行**：在作用域 X 里订阅的监听器，收得到 X 及 X 的子作用域里发的事件；在根 `ctx` 上订阅的（没有作用域的）监听器收得到**所有**事件；在根 `ctx` 上发的事件只有没有作用域的监听器收得到。
- `ctx.privateScope()` 每次调用都创建一个新的、别人无法按名字加入的作用域。
- 作用域对象随使用它的插件停用自动回收。

## 8. 生命周期与资源回收

状态：`discovered` → `activating` → `active` → `stopping` → `disabled`；激活失败为 `failed`（可再次激活重试）。

| 时机 | 发生什么 |
|---|---|
| `host.boot()` | 按依赖拓扑顺序激活全部插件；某个失败则回滚本次已激活的插件 |
| 激活前 | 必需依赖必须都已注册、版本满足且处于 `active`，否则 `dependency_inactive` 等错误，插件进入 `failed` |
| `activate` 期间 | 已经可以 `getService`、`dispatchAction`、`provideService` 等 |
| 停用一个插件 | 先停用所有**必需依赖它**的插件，再停它；它重新激活时，这些被连带停掉的插件自动恢复 |
| 停用时回收 | 先调用插件的 `deactivate`（此时它登记的东西都还在，可以做收尾）；然后宿主摘掉它的监听器、动作、服务、UI 贡献和托管定时器，最后逆序执行 `ctx.scope` 上的清理回调 |

插件自己开的外部资源（文件句柄、连接、定时器等），交给 `ctx.scope` 托管，停用时自动清理：

```js
export function activate(ctx) {
  const conn = openConnection();
  ctx.scope.addDisposer(() => conn.close());              // 停用时逆序执行，可以是 async

  const timer = setInterval(poll, 5000);
  ctx.scope.trackTimer(timer);                            // 停用时自动 clearInterval

  const once = setTimeout(() => { ctx.scope.untrackTimer(once); run(); }, 1000);
  ctx.scope.trackTimer(once);                             // 一次性定时器触发后记得 untrack，避免常驻插件越积越多
}
```

- `ctx.scope.addDisposer(fn)` 返回一个移除函数。
- `deactivate()` 与清理回调共用宿主的生命周期时限（默认 30 秒）；超时的回调会记一条错误并被跳过，不会卡住停用。
- 插件不能自己 `dispose` 作用域（`scope_owned_by_host`）。

## 9. 错误

**宿主自身**的失败一律是 `CordiumError`，请按 `err.code` 分支，不要匹配报文文字：

> ⚠️ 口径收窄（此前写成「宿主抛出的一律」，实测为假）：**插件自己抛出的值会原样透传，不是 `CordiumError`**。
> 分两类看清楚：
> - **宿主主动检测到的失败**（参数错、未声明依赖、权限不足、取服务失败…）⇒ 一定是 `CordiumError`，带 `code`。
> - **插件钩子抛出的原始值** ⇒ **原样透传**。`activate` / `deactivate` 抛什么就得到什么（宿主只负责记日志）；
>   动作、服务、通道这几条路径上会被**包成** `CordiumError` 送到调用方，原始值在 `cause` 里。
> 所以 `catch (err) { if (err.code === …) }` 之前，**先判 `err instanceof CordiumError`**（下面的示例就是这么写的）。


```js
import { CordiumError, ErrorCode } from '@cordium/kernel';

try {
  await ctx.dispatchAction('acme.export', payload);
} catch (err) {
  if (err instanceof CordiumError && err.code === ErrorCode.ACTION_FAILED) {
    console.error(`${err.pluginId} failed:`, err.cause); // 处理器抛出的原始值
  }
}
```

| 字段 | 含义 |
|---|---|
| `err.code` | 错误码（`ErrorCode` 里的值） |
| `err.pluginId` | 与错误相关的插件 id（可能为 `null`） |
| `err.cause` | 下层原因：插件抛出的原始值，或下一层的 `CordiumError` |

**插件自己抛出什么都可以**（字符串、对象、`Error`）。在动作、服务与消息通道这几条路径上，宿主会包成带码的错误送达调用方，原值在 `cause` 里不丢；生命周期钩子（`activate` / `deactivate`）与后台失败（`emit` 监听器、清理回调）没有调用方接，原值随错误一起进宿主日志。所以钩子里请抛 `Error`（非 `Error` 值没有栈，日志里只能看到值本身）。

常见错误码：

| 类别 | 码 |
|---|---|
| 参数 | `invalid_argument` `invalid_option` `invalid_usage` |
| manifest | `invalid_manifest` `incompatible_api_version` |
| 插件表 | `duplicate_plugin` `plugin_not_found` `plugin_has_dependents` |
| 依赖 | `missing_dependency` `dependency_version_mismatch` `cyclic_dependency` `dependency_inactive` |
| 服务 | `undeclared_service` `provide_not_declared` `invalid_implementation` `provider_conflict` `no_provider` `optional_unavailable` `service_unavailable` `service_failed` |
| 权限 | `access_denied` `undeclared_permission` |
| 生命周期 | `scope_disposed` `scope_owned_by_host` `lifecycle_timeout` |
| 动作 | `duplicate_action` `action_not_found` `action_timeout` `action_failed` `action_owner_gone` `action_overloaded` |
| 事件 | `listener_failed` |
| 加载 / 隔离 | `plugin_load_failed` `call_timeout` `isolated_call_failed` `isolation_busy` |

完整列表见 `ErrorCode` 导出。

### 定位出错位置

同步抛出的调用（服务方法，以及旧 `ctx` 上的发布方法 `emit` / `parallel` / `serial`）的错误直接抛给调用方；`waterfall` 按**实际走到的那一环**决定 —— 同步结束（监听器直接返回或抛错，链就此中断）时错误同步抛；实际走到 `async` 环、整条链升级为 Promise 时，错误经拒绝送达（见 [§6](#6-事件) 的说明）。返回 Promise 的调用（`dispatchAction` 总是，`parallel` / `serial` 正常调用时，走到异步环的 `waterfall`）—— 监听器与动作里的错误在 Promise 拒绝里，**必须 `await` 才接得住**（同步 `try` / `catch` 抓不到）。两种情况下 `err.code` 是错误码，`err.pluginId` 是出错插件（部分场景为 `null`），`err.cause.stack` 是插件原始错误的完整栈。

没有调用方能接住的失败会进宿主日志（`host.getDiagnostics().recentLogs` / `recentErrors`）。这类失败包括 `emit` 监听器、清理回调、`activate` / `deactivate` 和启动回滚。日志报文末尾会附上错误码和源头位置：

```text
Channel listener for 'tick' (plugin 'acme.bad') threw: boom at file:///.../bad.mjs:4:32
```

日志的 `details` 字段：

| 字段 | 含义 |
|---|---|
| `details.error` | `"TypeError: boom"` 形式的错误摘要 |
| `details.code` | 错误码（有才出现） |
| `details.pluginId` | 出错插件（监听器归属由宿主注入，插件无法冒充） |
| `details.at` | 插件代码里的出错位置 `文件:行:列`（跳过内核帧和 `node:` 帧） |
| `details.stack` | 原始栈（截断到 4KB） |
| `details.causes` | 下层原因链，每层形状相同；过长时保留首尾，`omittedCauses` 为省略的层数 |

> error 级日志条目自带的 `entry.stack` 是**记日志那一行**的栈（在内核里）。要看出错位置，请查 `details.at` / `details.stack`。

加载和隔离：

- **语法错误**：`loadPlugins` 的报错会带出文件、行号、源码行和指示符，依赖文件里的语法错误、不存在的导入名也能定位：
  ```text
  loadPlugins: failed to load 'file:///.../bad.mjs': Unexpected token ';'
    at file:///.../bad.mjs:3
  export const broken = ;
                        ^
  ```
  定位由一个只做链接、不执行插件代码的子进程完成。自定义 `importModule` 时不做这一步；靠 loader hook 转译的源（如 TS）找不回位置，只报原错误。
- **隔离调用**（`callIsolated`）：报文附 `(at 文件:行:列)`，`err.cause.stack` 保留隔离端的完整栈。

后台失败进日志的级别：`emit` 监听器、`deactivate` 钩子抛错记 `warn`（**只进 `recentLogs`，不进 `recentErrors`**）；清理回调、`activate` 失败、启动回滚失败记 `error`（两处都有）。要在一个地方兜住所有后台失败，请查 `recentLogs`。

插件抛出非 `Error` 值（如字符串）时没有栈，只能看到值本身和 `pluginId`。

## 10. 装配方要做的事

以下由应用（装配方）完成，插件作者了解即可：

```js
import { CordiumHost } from '@cordium/kernel';
import { loadPlugins } from '@cordium/plugins/loader';

const host = new CordiumHost({
  actionTimeoutMs: 30000,     // 动作默认超时
  lifecycleTimeoutMs: 30000,  // activate / deactivate 时限（0 = 不限）
  maxInFlightActions: 10000   // 同时在途的动作派发上限
});

host.declarePermissions(['perm.export']);
host.declareServiceContracts({
  kv:      { access: 'declared', methods: ['get', 'set'] },
  counter: { access: 'public' },
  secrets: { access: 'sensitive', requiredPermission: 'perm.secrets' },
  search:  { access: 'public', optionalProvider: 'acme.search' } // 提供者缺席时报 optional_unavailable
});

await loadPlugins(host, [
  { module: '/abs/path/plugins/store.mjs' },
  { module: '/abs/path/plugins/app.mjs', config: { lang: 'zh' }, group: 'core' },
  { module: '/abs/path/plugins/slow.mjs', lifecycleTimeoutMs: 120000 },  // 放宽这一个插件的时限
  { module: '/abs/path/plugins/beta.mjs', disabled: true }                // 登记但不启动
]);

await host.boot();
```

- **服务契约和权限名只能由装配方定义**，插件不能自造。契约里的 `requiredPermission` 会自动登记为权限名。
- ★ **服务契约不带版本号**：同一个服务名**同时只允许一个不兼容版本**。真需要并存两个不兼容版本时，
  做法是**拆成两个服务名**（如 `kv` / `kv2`），**不是**给契约加 `version` 字段 ——
  后者会引入「解析哪个版本」的匹配规则与过渡期管理，而拆名字零成本。
  （同一目的的外部实现：Grafana 的扩展点用 `/v1` 版本后缀，破坏性变更时升 `/v2` 并让两版并存一个过渡期。
  ★ 那也是「同一个名字承载两个版本」，与本仓「拆成两个名字」是同一目的的两种做法。）
- 加载清单的 `module` 必须是绝对路径、`file:` / `data:` URL 或 `URL` 对象。清单里任一条出错，一条都不登记。
- 慢插件的时限在清单或 `registerPlugin(manifest, entry, { lifecycleTimeoutMs })` 里放宽；写在插件自己的 manifest 里无效。
- 常用宿主方法：`registerPlugin` / `unregisterPlugin` / `replacePlugin` / `boot` / `activatePlugin` / `deactivatePlugin` / `getInternalService` / `getUIContributions(type)` / `getDiagnostics()`。
- ★ **宿主自己要派发动作时，用 `host.dispatchActionAsHost(action, payload)`** —— 它以**宿主自己的身份**派发（`HOST_CALLER`），不受 `requiredPermission` 约束（宿主是信任根，与 `getInternalService()` 同一口径）。
  ⚠️ 别为了「过权限门」去借一个插件的 id 调 `dispatchAction(pluginId, …)` —— 那样**审计日志会记成那个插件干的**，不是宿主。确实需要「代表某个插件」时，那是**委派**，要能同时说清「谁在做」和「代表谁」。
- 插件放在哪个目录都可以，清单里写绝对路径即可；以脚本自身为基准时用 `new URL('./plugins/x.mjs', import.meta.url)`。

### 读诊断快照：哪些字段可以依赖

`host.getDiagnostics()` 交出的快照**分两档**，契约写在 `DIAGNOSTICS_CONTRACT`（`@cordium/kernel` 的导出）：

| 档 | 承诺 | 在哪 |
|---|---|---|
| **稳定面** | 点名的路径与键**不删、不改名、不改类型**；枚举值**可增不可改** | `DIAGNOSTICS_CONTRACT.stable`（按**路径**逐层给：根 / `plugins[]` / `services[]`） |
| **不稳定面** | 随时可改，**不承诺** | `DIAGNOSTICS_CONTRACT.unstable` |

★ **未点名的路径/键一律不承诺** —— 不是「大概稳定」，是**明确不承诺**（allowlist 形态）。
★ 快照里的 `schemaVersion` 是**结构版本**，供判断「这份快照按哪版契约读」；它本身不在稳定面。

**消费方的义务**（读快照的一方）：

```js
import { DIAGNOSTICS_CONTRACT, LifecycleState } from '@cordium/kernel';

const diag = host.getDiagnostics();
if (diag.schemaVersion !== DIAGNOSTICS_CONTRACT.schemaVersion) { /* 按契约版本分支处理 */ }

// ✅ 只读稳定面点名的字段；**忽略未知字段**
const active = diag.plugins.filter(p => p.state === LifecycleState.ACTIVE).map(p => p.id);

// ⚠️ 不稳定面：能用，但内核随时会改它（文本、条数、内部形状）
const tail = diag.recentLogs.slice(-5).map(l => l.message);
```

★ **只读稳定面 + 忽略未知字段**，内核**加**字段就不会打到你的代码 —— 这正是分两档的目的。
反过来，读了不稳定面就得自己承担内核改它的后果。★ 判活跃请用 `LifecycleState.ACTIVE` 常量，
不要写字面量 `'active'`（拼错是静态值，不会报错，只会静默判错）。

### 一个插件起不来时，会连累谁

`boot()` 是**原子**的：任一已登记插件的必需依赖不满足（缺失 / 版本不符），它在**激活任何插件之前**就抛错
（`missing_dependency` / `dependency_version_mismatch`），宿主停在 `booted === false`，
**所有**插件（包括依赖齐备的那些）保持 `discovered` —— 不存在「半启动」：要么整份清单起来，要么一个都不起。

`boot()` **之后**再登记 / 激活的插件不受此限：同样的 manifest 错误只让那一个插件进 `failed`，
宿主仍 `booted === true`，已经跑起来的插件不受影响。

| 插件从哪来 | 一个坏 manifest 的后果 |
|---|---|
| `boot()` 之前登记的（内置、清单里写死的） | **整份清单都不启动** |
| `boot()` 之后加载的（外部插件、热插拔） | **只有它自己 `failed`** |

★ 为什么两个世界不同：静态期那份清单是装配方自己写的，依赖写错是装配错误，启动时就暴露最省事；
动态期的插件来自外部，一个外来 manifest 打错字不该把已经跑起来的宿主整个拖垮。

**装配方要自己决定隔离谁**（内核只给事实，不给策略）：

```js
// ① boot 之前：纯查询、零副作用，一次列出【全部】有问题的插件
//    （boot() 自身一次只报它碰到的第一个）
const blocked = host.getDiagnostics().plugins
  .filter(p => p.unresolvedDependencies.length > 0);

// ② 隔离它们 —— 用 deactivatePlugin
for (const p of blocked) await host.deactivatePlugin(p.id);

await host.boot();
```

★ **为什么是 `deactivatePlugin` 而不是 `unregisterPlugin`**：前者**非破坏性** —— 插件标成「停用」
（`state: 'disabled'`），登记、manifest 与 `unresolvedDependencies` **都还在**，运维者事后查得到
「它为什么被摘」；后者把插件整个移出宿主，那是升级 / 卸载才该用的动作。
⚠️ `unregisterPlugin` 在**有必需依赖方时会拒绝**（`plugin_has_dependents`），所以用它就得自己按依赖序
从叶子往上摘；`deactivatePlugin` 会**级联**停掉依赖方，不必自己排 —— 但被级联停的那些，等提供者回来时会被自动拉起。

- `unresolvedDependencies` 在稳定面里（见上一节），形状 `[{ id, reason }]`，`reason` 有四种：

| `reason` | 含义 | `boot()` 之前就能查到？ |
|---|---|---|
| `missing` | 依赖没登记 | ✅ |
| `version_mismatch` | 版本范围不满足 | ✅ |
| `cycle` | 与这个依赖**互相**可达 ⇒ 拓扑排序必然失败 | ✅ |
| `not_running` | 依赖在、版本也对，但**此刻它跑不起来**（等触发的懒插件 / 被停用 / 已失败 / 它自己也被上游的环挡住） | ❌ |

★ 前两类与 `boot()` 的拒绝**同源**（同一份判定）；后两类**不会**让 `boot()` 抛错 ——
它们回答的是「**它为什么没起来**」，不是「这次启动为什么失败」。
⚠️ `not_running` **只在宿主启动过之后**才可能出现：`boot()` 之前所有插件都是 `discovered`，
那不是「跑不起来」，所以那时查询不会误报。
- ⚠️ `unregisterPlugin` 的**入口**拒绝（插件不存在 / 有必需依赖方）是**同步抛出**，排队后复验失败的才是 Promise 拒绝 —— 用 `try/catch` 包住 `await` 即可统一处理两者。

### 按目录加载

内核不扫描目录，只加载清单里写明的文件：会执行哪些代码一目了然，每一条还能带 `config` 等参数。想「把插件丢进一个目录就加载」，由应用自己扫描后生成清单：

```js
import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadPlugins } from '@cordium/plugins/loader';

const dir = resolve('plugins'); // 必须转成绝对路径：清单拒收相对路径
const entries = readdirSync(dir)
  .filter(f => f.endsWith('.mjs'))
  .map(f => ({ module: join(dir, f) }));

await loadPlugins(host, entries);
```

- 目录里只能放插件。混进一个不导出 `manifest` 的辅助模块，整批加载都会失败（`invalid_manifest`），一个插件都不登记。辅助模块请放到子目录或换个扩展名。
- 注意：辅助模块在报错之前已经被 `import` 执行过一次。所以扫描的目录不能让不可信的人写入。
- 同一个 `entries` 可以直接传给 `watchPlugins(host, entries)` 做开发期热重载（见下文）。只有启动时扫到的文件会被监视，之后新加的文件不会自动加载。

### 替换插件

`host.replacePlugin(manifest, entry, options)` 用新的 manifest 和代码原地换掉同 id 的已登记插件，升级插件与热重载都走它：

1. 必需依赖它的插件先被停下，再停它自己；
2. 换上新的 manifest 与代码（权限按新 manifest 生效），用新代码激活；
3. 被停下的依赖方按依赖顺序重新激活，拿到新的 `ctx`，须重新 `getService`。

- 新版本必须仍满足每个依赖方写的版本范围，否则同步抛 `dependency_version_mismatch`，什么都不改。
- 新代码激活失败时，宿主换回旧代码重新激活，再把新代码的原始错误抛给调用方。
- 原来没在运行（未启动、已停用、失败）的插件只换不启，停用状态保留。
- 插件有必需依赖方时 `unregisterPlugin` 会拒绝，所以升级不要走「先移除再登记」。

### 开发期热重载

`@cordium/plugins/reload` 在开发时用：改完插件文件，不重启进程就换上新代码。

```js
import { loadPlugins } from '@cordium/plugins/loader';
import { reloadPlugin, watchPlugins } from '@cordium/plugins/reload';

const entries = [{ module: '/abs/path/plugins/greeter.mjs', config: { lang: 'zh' } }];
await loadPlugins(host, entries);
await host.boot();

// 手动重载一个
await reloadPlugin(host, entries[0]);

// 或者监视文件，保存即重载
const watcher = watchPlugins(host, entries, {
  onReload: ({ id, version }) => console.log(`reloaded ${id}@${version}`),
  onError: (err) => console.error(err)   // 语法错、激活失败等；监视继续
});
// watcher.close();
```

- **只重载 manifest 写了 `hotReload: true` 的插件**，正在运行的版本和新版本都要写，否则抛 `invalid_usage`；开发时想全部放行可传 `{ force: true }`。
- 判断一个插件能不能写 `hotReload: true`，看它**持有什么**：
  - 只经 `ctx` 登记服务、动作、监听器、UI 贡献、托管定时器的插件（登记型），停用时宿主全部回收，可以写；
  - 自己开了端口、文件句柄、子进程、没托管的定时器或长任务的插件（持有型），只有在 `deactivate` 或 `ctx.scope.addDisposer` 里把它们释放干净时才能写，否则旧实例的资源会留在进程里。拿不准就不写，改完重启进程。
- 重载失败不影响正在运行的代码：加载失败时什么都不换；激活失败时宿主换回旧代码。
- ⚠️ **只在开发时用**：
  - 内存只增不减。ESM 没有卸载模块的接口，每次重载都会在内存里留下一份旧模块；
  - 只重载清单里的入口文件，它 `import` 的其它文件还是第一次加载的那份，改了它们要重启进程；
  - 生产环境要换插件代码，重启进程即可。

## 11. 执行隔离（可选）

插件与宿主在同一进程里运行，同步死循环会卡住整个进程，超时也拦不住。可能卡死或占大量内存的计算，用 `callIsolated` 放到独立环境里执行：

```js
import { callIsolated } from '@cordium/plugins/isolation';

// heavy.mjs 导出 export function crunch(data) { ... }
const result = await callIsolated('/abs/path/heavy.mjs', 'crunch', [data], {
  mode: 'worker',     // 'worker'（线程）或 'process'（子进程，默认禁读写文件系统）
  timeoutMs: 5000,    // 超时即终止该环境
  maxMemoryMb: 512,   // 该环境的 JS 堆上限
  pluginId: ctx.pluginId
});
```

- 参数和返回值按结构化克隆传递：
  - 函数、`ctx` 传不过去：参数里有函数抛 `invalid_argument`，返回值里有函数抛 `isolated_call_failed`。
  - 类实例能传，但到对面只剩自有字段，变成普通对象，原型和方法都丢了。
- 大块二进制可用 `transfer: [arrayBuffer]` 零拷贝移交（仅 worker 模式，移交后调用方那块变空）。
- 同时运行数、排队数、在途数据量都有上限，超出时抛 `isolation_busy`，稍后重试即可；装配方可用 `configureIsolation` 调整。
- 失败时外层 `err.code` 一律是 `isolated_call_failed`（管**归属**），**具体原因在 `err.cause.code`**（管**语义**）。隔离端自己产出的两个码导出为 `IsolationCode`（`import { IsolationCode } from '@cordium/plugins/isolation'`）；你在插件里 `throw` 出来的 `err.code` 会**原样透传**，取值任意 ⇒ **`IsolationCode` 是不完备表**，只用来判「是不是隔离端自产的」（详见 [§13](#13-测试与调试) 的两个反直觉点）。
- ⚠️ 这不是安全沙箱，不能用来运行不可信的恶意代码。

## 12. 约束速查

- 插件之间不要互相 `import`，一切经 `ctx` 通过宿主交互。
- 服务名、权限名由装配方定义；插件只能提供 manifest 里 `provides` 列出的服务。
- `getService` 的句柄不要长期缓存；服务可能被替换，用 `watchService` 或每次现取。
- 发出去的事件参数是**同一个对象引用**，监听器改它会影响后面的监听器；要不可变请自己复制。
- 动作超时和生命周期超时都只是停止等待，不能打断同步死循环，重计算请用 `callIsolated`。
- 停用后不要再用旧 `ctx`；重新激活时 `activate` 会拿到新的 `ctx`。
- 热重载只在开发时用；插件持有外部资源时，要么在 `deactivate` / `ctx.scope` 里释放干净并声明 `hotReload: true`，要么改完重启进程。
- 读 `getDiagnostics()` **只读稳定面**（`DIAGNOSTICS_CONTRACT.stable`），并**忽略未知字段**；`state` 用 `LifecycleState.ACTIVE`，不写字面量。

---

## 13. 测试与调试

本节讲怎么把插件跑起来看、怎么给它写自动化测试。

★ 先说结论：**本仓不提供测试替身** —— 两个包的 `exports` 里没有 `./testing`，`files: ["src"]` 又把 `test/` 挡在包外，连内核自己那个「只走公开 API」的观察工具外部也拿不到。但**宿主本身就是测试工具**：`CordiumHost` 可以直接 `new`（零参数），插件可以用内联 `entry` 注册，**不起任何文件**就能测。

### 最小装配

`new CordiumHost()` 零参数即可；不声明 `provides` / `permissions` 时，装配只有三行：

```js
import { CordiumHost } from '@cordium/kernel';

const host = new CordiumHost();
host.registerPlugin(
  { id: 'demo.greeter', name: 'Greeter', version: '1.0.0', apiVersion: '1.0.0' },
  { activate(ctx) { ctx.log('info', `hello from ${ctx.pluginId}`); } }
);
await host.boot();
console.log(host.getDiagnostics().plugins.map(p => `${p.id}=${p.state}`).join(' '));
```

★ `registerPlugin(manifest, entry)` 的第二个参数就是 `{ activate, deactivate }` 对象 —— 这是「单元测试插件逻辑」的官方路径，**不必先落一个 `.mjs` 文件**。这样注册时 `config` 是空对象 `{}`；要传配置就用 `loadPlugins` 的清单条目（见 [§10](#10-装配方要做的事)）。

### 单元测试一个插件逻辑

用 Node 自带的 `node:test`（`node --test` 运行）。把 `activate` 写成内联对象，起一个宿主，断言服务行为：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, LifecycleState } from '@cordium/kernel';

test('counter 服务：调用一次加一', async () => {
  const host = new CordiumHost();
  host.declareServiceContract('counter', { access: 'public' });
  host.registerPlugin(
    { id: 'demo.counter', name: 'Counter', version: '1.0.0', apiVersion: '1.0.0', provides: ['counter'] },
    { activate(ctx) { let n = 0; ctx.provideService('counter', { next: () => ++n }); } }
  );
  await host.boot();

  const p = host.getDiagnostics().plugins.find(p => p.id === 'demo.counter');
  assert.equal(p.state, LifecycleState.ACTIVE);
  const counter = host.getInternalService('counter');
  assert.equal(counter.next(), 1);
  assert.equal(counter.next(), 2);
});
```

★ 几条要点：

- 服务契约必须在 `activate` 跑之前用 `declareServiceContract` 声明，否则 `provideService` 抛 `undeclared_service`。
- `boot()` 是异步的，且**原子**：清单里任一插件的必需依赖不满足，整份清单都不启动（见 [§10](#10-装配方要做的事)）。测单个插件时，宿主里只放它一个最省心。
- 想在「插件内部视角」断言，就在 `activate(ctx)` 里把 `ctx` 存进闭包变量；想从「装配方视角」断言，用 `host.getInternalService(name)`（`internal` 级契约只有这条路能取）。

### 断言状态与错误

插件状态从 `host.getDiagnostics().plugins[].state` 读，**判活跃用 `LifecycleState` 常量，不写字面量**。错误分两类，断言方式不同：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, CordiumError, ErrorCode, DIAGNOSTICS_CONTRACT, LifecycleState } from '@cordium/kernel';

test('activate 抛裸错：状态 failed，按码分支前先判 instanceof', async () => {
  const host = new CordiumHost();
  host.registerPlugin(
    { id: 'demo.boom', name: 'Boom', version: '1.0.0', apiVersion: '1.0.0' },
    { activate() { throw new Error('boom'); } }
  );

  let caught;
  try { await host.boot(); } catch (err) { caught = err; }

  // ⚠️ 插件钩子抛出的原始值【原样透传】：不是 CordiumError，也没有 code
  assert.equal(caught instanceof CordiumError, false);
  assert.equal(caught.code, undefined);
  assert.equal(caught.message, 'boom');

  const diag = host.getDiagnostics();
  assert.equal(diag.schemaVersion, DIAGNOSTICS_CONTRACT.schemaVersion);
  assert.equal(diag.plugins.find(p => p.id === 'demo.boom').state, LifecycleState.FAILED);

  // 没有调用方接的后台失败进 recentErrors，自带插件 id 与源头位置
  const log = diag.recentErrors.find(e => /demo\.boom.*failed to activate/.test(e.message));
  assert.ok(log);
  assert.equal(log.details.pluginId, 'demo.boom');
  assert.ok(typeof log.details.at === 'string');
});

test('宿主主动检测到的失败：一定是带码的 CordiumError', () => {
  const host = new CordiumHost();
  assert.throws(
    () => host.registerPlugin({ id: 'demo.x', name: 'X', version: '1.0.0', apiVersion: '2.0.0' }),
    err => err instanceof CordiumError && err.code === ErrorCode.INCOMPATIBLE_API_VERSION
  );
});
```

- ★ **按码分支前先判类型**：`activate` / `deactivate` 抛的是插件自己的值，`err.code` 会是 `undefined`（见下「两个反直觉点」①）。
- 读快照**只读稳定面**（`DIAGNOSTICS_CONTRACT.stable`）并忽略未知字段；`recentLogs` / `recentErrors` / `manifestDiagnostics` 属**不稳定面**，测试里可以用来排障，但别把它们的内部形状当成契约。`schemaVersion` 用 `DIAGNOSTICS_CONTRACT.schemaVersion` 比对，不手写数字。
- 后台失败没有调用方接，只进日志：`emit` 监听器、`deactivate` 钩子抛错是 `warn`（只在 `recentLogs`）；清理回调、`activate` 失败是 `error`（`recentLogs` 与 `recentErrors` 都有）。要在一个地方兜住所有后台失败，查 `recentLogs`。

### 两个反直觉点

**① 钩子抛出的错没有 `code`，先判 `instanceof`。** `catch (err) { if (err.code === …) }` 在 `activate` 抛裸 `Error` 时会静默判错（`undefined === 'xxx'` 恒假），必须写成 `err instanceof CordiumError && err.code === …`。动作、服务、通道这几条路径上宿主会把插件抛的值**包成** `CordiumError`，原始值在 `err.cause`。

**② `callIsolated` 的定位在 `err.cause.stack`，不在 `err.stack` 的帧里。** 实测：

```js
import { callIsolated } from '@cordium/plugins/isolation';

const url = new URL('./heavy.mjs', import.meta.url).href; // heavy.mjs: export function crunch() { throw new Error('isolated boom'); }
try {
  await callIsolated(url, 'crunch', [], { mode: 'worker', pluginId: 'demo.heavy' });
} catch (err) {
  console.log(err.code);                              // 'isolated_call_failed'
  console.log(err.message);                           // 末尾带 "(at file:///…/heavy.mjs:2:9)" —— 位置在这里
  console.log(err.stack.split('\n')[1].trim());       // ⚠️ 帧指向内核 isolation.mjs，不指向 heavy.mjs
  console.log(err.cause.stack.split('\n')[1].trim()); // ✅ at crunch (file:///…/heavy.mjs:2:9)（截断到 4KB）
}
```

★ 精确说法：`err.stack` 的**首行会回显 `err.message`**，所以对 `err.stack` 做字符串搜索**能**搜到位置；但**帧**不指向插件。要**程序化**取插件栈，用 `err.cause.stack`。
★ `err.cause` 是**跨边界 DTO**（`{ ok, name, code, message, stack }`），不是活体 `Error` —— 读 `cause.code` / `cause.message` / `cause.stack`，**别用 `instanceof Error` 判**（原因见 [§11](#11-执行隔离可选)）。

★★ **但别把这句话推广到「隔离调用失败就一定如此」** —— `cause` 的形状是**分路径**的：

| 失败路径 | `cause` |
|---|---|
| 隔离端**回了一条失败报文**（插件里抛错、导出不是函数、结果不可克隆） | 上面的 wire DTO ✅ |
| 隔离环境**崩溃** | **活体 `Error`**，其 `code` 是 Node / OS 码（`ERR_*` / `E*`），**不是**下面那张表里的值 |
| 隔离环境**无结果退出** / **超时** | **不挂 `cause`** |

★ `cause.code` 是**第二码域**（外层 `err.code` 管**归属**，`cause.code` 管**语义**）。它**只有一半可枚举**：

- **隔离端自产的码**（`not_a_function` / `result_not_cloneable`）导出为 `IsolationCode`（`@cordium/plugins/isolation`）；
- **插件自报的码**（你在插件里 `throw` 的那个 `err.code`）由隔离端**原样透传**，取值任意、**结构上不可枚举**。

⇒ 所以 `IsolationCode` **是不完备表**：**别**写 `Object.values(IsolationCode).includes(cause.code)` 来判断「我认全了没有」—— 未命中只说明「不是隔离端自产的」，那多半是插件自己的码。判「是不是隔离端自产」才是它的用途。

### 没有测试替身，照这样自建

★ 本仓**不导出任何测试替身**，所以「官方夹具」是没有的；但测试**不需要**它，因为宿主本身可观察：

- 观察状态：`host.getDiagnostics()`（稳定面）；
- 观察 UI 贡献：`host.getUIContributions(type)`；
- 观察内部服务：`host.getInternalService(name)`；
- 造错误：注册一个会抛的插件、或给宿主喂非法输入。

照内核自己的做法，建一个**只走公开 API** 的观察小工具（不要给宿主加 `__test_*` 访问器 —— 测试能看到的必须是下游也能看到的）：

```js
// test/helpers/observe.mjs —— 只走宿主公开 API
export const pluginInfo = (host, id) => host.getDiagnostics().plugins.find(p => p.id === id);
export const pluginState = (host, id) => pluginInfo(host, id)?.state;
export const errorText = (host, id) => pluginInfo(host, id)?.error;
```

两个**可注入的测试缝**，能免掉真实文件系统：

- `loadPlugins(host, entries, { importModule })` —— 传一个返回内存插件对象的加载器，就能在不起文件、不碰磁盘的情况下测加载与装配（默认加载器是动态 `import`）；
- `validatePluginManifest` / `validatePluginManifestDetailed` —— **离线**单测 manifest，不需要起宿主。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, LifecycleState } from '@cordium/kernel';
import { loadPlugins } from '@cordium/plugins/loader';
import { validatePluginManifest, validatePluginManifestDetailed } from '@cordium/plugins/runtime';

test('注入 importModule：不碰文件系统，直接喂内存里的插件对象', async () => {
  const host = new CordiumHost();
  const fake = {
    manifest: { id: 'demo.fake', name: 'Fake', version: '1.0.0', apiVersion: '1.0.0' },
    activate(ctx) { ctx.log('info', 'fake up'); }
  };
  await loadPlugins(host, [{ module: new URL('./fake.mjs', import.meta.url) }], { importModule: async () => fake });
  await host.boot();
  assert.equal(host.getDiagnostics().plugins[0].state, LifecycleState.ACTIVE);
});

test('离线单测 manifest：不起宿主', () => {
  const m = validatePluginManifest({ id: 'demo.m', name: 'M', version: '1.0.0' });
  assert.equal(m.activation, 'eager');
  const { manifest, diagnostic } = validatePluginManifestDetailed({ id: 'demo.m', name: 'M', version: '1.0.0', config: {} });
  assert.equal(manifest.id, 'demo.m');
  assert.ok(diagnostic, 'config 是未知字段 ⇒ 诊断非空');
});
```

★ 说明（避免误解）：`importModule` 注入**绕过**了宿主默认加载器里「用子进程定位语法错误」那一步 —— 自定义加载器可能根本不读文件，宿主不去猜。所以注入加载器适合测装配与逻辑，不适合测真实文件的语法定位。

### 调试

**断点调试（`--inspect`）。** `node --inspect app.mjs` 让进程监听 `127.0.0.1:9229`，用 VS Code 的 "Attach to Node" 或 Chrome 的 `chrome://inspect` 连上。想让进程**在用户代码第一行就停下**（好在 `boot()` 之前设断点），用 `node --inspect-brk app.mjs`；想等调试器连上再跑，用 `node --inspect-wait`。

**改文件自动重启（`node --watch`）。** `node --watch app.mjs` 监视入口及其依赖，改动即重启整个进程。

**不重启进程换插件代码（`reloadPlugin` / `watchPlugins`）。** 这是本仓自己的开发循环，比整进程重启快，但**只对 manifest 写了 `hotReload: true` 的插件生效**（开发时可传 `{ force: true }` 全放行）：

```js
import { CordiumHost } from '@cordium/kernel';
import { loadPlugins } from '@cordium/plugins/loader';
import { reloadPlugin, watchPlugins } from '@cordium/plugins/reload';

const entry = { module: '/abs/path/plugins/greeting.mjs' };
const host = new CordiumHost();
await loadPlugins(host, [entry]);
await host.boot();

await reloadPlugin(host, entry);            // 手动换一次
const watcher = watchPlugins(host, [entry], {
  onReload: ({ id, version }) => console.log(`reloaded ${id}@${version}`),
  onError: (err) => console.error(err.code ?? err.message)  // 语法错 / 激活失败；监视继续
});
// watcher.close();
```

⚠️ 热重载只在开发时用：ESM 没有卸载模块的接口，**内存只增不减**；且只重载入口文件，它 `import` 的其它文件仍是旧的那份（见 [§10](#开发期热重载)）。

**只跑一部分测试。** 按名字过滤用 `node --test --test-name-pattern "…"`；或在测试里标 `{ only: true }`，再用 `node --test --test-only` 运行 —— 不加 `--test-only` 时 `only` 被忽略，防误提交一个「只跑一条」的测试。测试运行器自己的 watch 模式是 `node --test --watch`（实验性；注意与 `node --watch` 不同：后者重启整个进程）。

### 不支持 source map

★ **本仓不做 source map 映射**（全仓零命中；这是明确决定 —— 与「运行时零依赖」冲突）。含义：

- 报错位置（`err.stack` 的帧、日志的 `details.at`、语法错误定位）指向的是**宿主实际加载的那个文件**。插件是**未转译 ESM** 时，那就是你的源码，行号精确到 `:行:列`。
- 若你**转译**（TS / Babel）后把产物交给宿主，报错指向**产物行号**。Node 自带的 `--enable-source-maps` 只对**带 `sourceMappingURL` 的产物**生效，且宿主自身的语法定位子进程与自定义 `importModule` 都不做映射 —— 别指望它把宿主日志里的 `details.at` 还原回 TS 源。
- 应对：① **开发期直接用未转译 ESM**（本仓插件本就是 `.mjs`，不需要构建）；② 必须转译时，按产物行号定位，或自己保留产物↔源码的行映射再人工换算。

★ 本节所有代码示例均在 Node v24.16.0 实跑通过（含 `node --test` / `--inspect` / `--watch` / `--test-only` / `--test-name-pattern`）。
