# 插件开发指南

本文是写 Cordium 插件所需的全部接口说明，按它写不需要读内核源码。示例均可直接运行（Node.js ≥ 22.13，ES Module）。可运行的完整示例在仓库的 [`examples/`](examples/) 目录。

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

- `activate(ctx, config)`：插件被激活时调用，可以是 `async`。`config` 来自装配方的加载清单，已冻结；直接用 `host.registerPlugin` 登记时没有第二个参数。
- `deactivate()`：插件被停用时调用，可以是 `async`。
- 两个钩子默认各有 **30 秒**上限（装配方可调整），超时的激活判为失败。

## 2. manifest

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | ✅ | string | 全局唯一。小写字母和数字组成的段，段之间用 `.` `_` `-` 连接，如 `acme.search-index` |
| `version` | ✅ | string | 插件自身版本，合法 SemVer，如 `1.2.0` |
| `apiVersion` | ✅ | string | 插件面向的内核接口版本。主版本号必须等于内核的 `KERNEL_API_VERSION`（当前 `1.0.0`，所以写 `1.x.y`） |
| `provides` | | string[] | 本插件会提供的服务名。**不在这里的服务名不能 `provideService`** |
| `dependencies` | | object | 必需依赖：`{ '插件id': 'SemVer 范围' }`，如 `{ 'demo.counter': '^1.0.0' }`。也可写成数组 `['demo.counter']`，等同范围 `*` |
| `optionalDependencies` | | object | 可选依赖，写法同上。缺席时不影响本插件激活 |
| `permissions` | | string[] | 本插件申请的权限名。必须是装配方登记过的名字 |
| `kind` | | `'core'` \| `'business'` | 插件类别，默认 `business`。只是描述，「core 能否被用户停用」由应用决定 |
| `displayName` / `description` | | string | 展示用 |
| `name` | | string | 插件目录 / 市场用的名称（见下一小节）。内核不保留，登记时丢弃并记一条 `info` 级诊断 |
| `hotReload` | | boolean | 默认 `false`。写 `true` 表示本插件可以在进程内热重载：它只在 `ctx` 上登记东西，或自己开的外部资源都在 `deactivate` / `ctx.scope` 里释放干净。开发期重载器只重载写了它的插件，见 [§10](#开发期热重载) |

- 不在上表的字段会被丢弃，并记一条诊断（`host.getDiagnostics().manifestDiagnostics`）。**分级按整条诊断判定**：这条 manifest 里只要有**两层都不认**的字段（多半是拼写错误），整条记 `warn`，同一条里被列出的描述符字段（如 `name`、`config`）也一并算在该条的 `fields` 里；一个都不认的字段也没有时，才记 `info`。
- 插件拿到的 `ctx.manifest` 是规范化后的**冻结副本**，改它不会影响宿主，也不能借此提权。
- 依赖范围语法与 npm 相同（`^1.2.0`、`~1.2`、`>=1 <2`、`1.x`、`*` 等）；`latest` 之类的 tag 不是合法范围。

### 插件目录 / 市场用的 manifest

上表是内核（`host.registerPlugin` / `loadPlugins`）认的字段。`@cordium/plugins` 的 `/runtime`（`validatePluginManifest`）、`/catalog` 与 `/ecosystem` 用的是另一套**描述符**字段，面向插件目录 / 市场：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `version` | ✅ | 同上表 |
| `name` | ✅ | 非空字符串，目录里显示的名称。**内核不认这个字段**（会丢弃并记一条 `info` 级诊断，不影响运行） |
| `apiVersion` | | 同上表；缺省按当前接口版本 |
| `provides` / `permissions` | | 同上表，但更严格：必须是数组，不能有空项和重复项 |
| `dependencies` | | 同上表 |
| `kind` | | 同上表 |
| `config` | | 普通对象，随描述符一起进目录；缺省为 `{}` |

描述符**不保留** `optionalDependencies` / `displayName` / `description` / `hotReload`。

要让同一份 manifest 既能运行又能上架，就写成两套字段的并集。本文与 README 的示例都已带上 `name`，可以直接上架。内核登记这份 manifest 时会丢掉 `name` / `config`，并记一条 `info` 级诊断，这是预期行为。运行时的配置由装配方通过 `loadPlugins` 清单的 `config` 传入（见 §10），不读 manifest 里的 `config`。

## 3. ctx：插件能用的全部能力

`activate` 收到的 `ctx` 是冻结对象，成员如下：

| 成员 | 返回 | 用途 |
|---|---|---|
| `pluginId` | string | 本插件 id |
| `manifest` | object | 冻结的 manifest 副本 |
| `scope` | EffectScope | 本次激活的资源作用域，见 [§8](#8-生命周期与资源回收) |
| `provideService(name, impl)` | undefined | 提供服务，见 [§4](#4-服务) |
| `getService(name)` | 服务句柄 | 取用服务 |
| `watchService(name, listener)` | 退订函数 | 监听某个服务的注册 / 注销 |
| `registerAction(name, options)` | undefined | 注册动作，见 [§5](#5-动作) |
| `dispatchAction(name, payload)` | **Promise** | 调用动作 |
| `on(name, listener, options?)` | 退订函数 | 订阅事件，见 [§6](#6-事件) |
| `once(name, listener, options?)` | 退订函数 | 只触发一次的订阅 |
| `emit(name, ...args)` | undefined | 广播，不等回执 |
| `parallel(name, ...args)` | **Promise** | 广播并等待所有监听器完成 |
| `serial(name, ...args)` | **Promise** | 依次询问，第一个给出结果的胜出 |
| `bail(name, ...args)` | 结果 | `serial` 的同步版 |
| `waterfall(name, ...args, fallback)` | 结果（链上有 async 时为 Promise） | 中间件链 |
| `scoped(label)` | 新 ctx | 进入命名作用域，见 [§7](#7-作用域) |
| `privateScope()` | 新 ctx | 进入只属于这一次调用的私有作用域 |
| `registerUIContribution(item)` | undefined | 登记一条 UI 贡献（`{ id, type, ... }` 或字符串 id） |
| `log(level, message, details?)` | undefined | 写宿主审计日志，`level` 一般用 `info` / `warn` / `error` |

- `dispatchAction`、`parallel`、`serial` 总是返回 Promise。`waterfall` 在所有监听器与 `fallback` 都同步时直接返回结果，链上任何一环返回 Promise 时整条链返回 Promise，稳妥的写法是一律 `await`。其余方法都是同步的。
- 插件停用后，手里留着的旧 `ctx` 基本都失效：除 `log` 外，登记、发布、取服务、派发动作、事件订阅与派发、`scoped` / `privateScope`，调用时都抛 `scope_disposed`。两处例外：`log` 不报错（只留日志，便于收尾）；`provideService` 在服务名未声明契约时，先报 `undeclared_service`（该项检查在生命周期门之前）。`dispatchAction` / `parallel` / `serial` 是异步的，同步调用不抛，`await` 才能看到该错误。
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

// 另一个插件
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
| `bail(name, ...args)` | `serial` 的同步版；监听器返回 Promise 会抛 `invalid_usage` | 同上 |
| `waterfall(name, ...args, fallback)` | 中间件链：监听器签名 `(...args, next)`，调 `next()` 往下传，`next(新参数)` 改写参数，不调则就此返回；都放行时由 `fallback(...args)` 收尾 | 同上；`fallback` 自己抛的错原样抛出 |

「有效值」指 `undefined`、`null`、`false` 以外的返回值（`0` 和 `''` 也算有效）。

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

宿主抛出的一律是 `CordiumError`，请按 `err.code` 分支，不要匹配报文文字：

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

同步抛出的调用（服务方法、`bail`、`waterfall`）的错误直接抛给调用方；异步调用（`dispatchAction`、`parallel`、`serial`）返回的 Promise 拒绝同一个错误，**必须 `await` 才接得住**（同步 `try` / `catch` 抓不到）。两种情况下 `err.code` 是错误码，`err.pluginId` 是出错插件（部分场景为 `null`），`err.cause.stack` 是插件原始错误的完整栈。

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
- 加载清单的 `module` 必须是绝对路径、`file:` / `data:` URL 或 `URL` 对象。清单里任一条出错，一条都不登记。
- 慢插件的时限在清单或 `registerPlugin(manifest, entry, { lifecycleTimeoutMs })` 里放宽；写在插件自己的 manifest 里无效。
- 常用宿主方法：`registerPlugin` / `unregisterPlugin` / `replacePlugin` / `boot` / `activatePlugin` / `deactivatePlugin` / `getInternalService` / `getUIContributions(type)` / `getDiagnostics()`。
- 插件放在哪个目录都可以，清单里写绝对路径即可；以脚本自身为基准时用 `new URL('./plugins/x.mjs', import.meta.url)`。

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
- ⚠️ 这不是安全沙箱，不能用来运行不可信的恶意代码。

## 12. 约束速查

- 插件之间不要互相 `import`，一切经 `ctx` 通过宿主交互。
- 服务名、权限名由装配方定义；插件只能提供 manifest 里 `provides` 列出的服务。
- `getService` 的句柄不要长期缓存；服务可能被替换，用 `watchService` 或每次现取。
- 发出去的事件参数是**同一个对象引用**，监听器改它会影响后面的监听器；要不可变请自己复制。
- 动作超时和生命周期超时都只是停止等待，不能打断同步死循环，重计算请用 `callIsolated`。
- 停用后不要再用旧 `ctx`；重新激活时 `activate` 会拿到新的 `ctx`。
- 热重载只在开发时用；插件持有外部资源时，要么在 `deactivate` / `ctx.scope` 里释放干净并声明 `hotReload: true`，要么改完重启进程。
