# Cordium

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js >= 22.13](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)
![Third-party deps: 0](https://img.shields.io/badge/third--party_deps-0-brightgreen.svg)
![Version 0.3.0](https://img.shields.io/badge/version-0.3.0-orange.svg)

**通用插件基座（微内核）**：负责插件的契约、生命周期、服务交付和轻量消息。模型、记忆、工具、业务等上层能力都以插件形式装进来，内核本身不含任何业务。

- **零第三方依赖**：纯 ES Module（`.mjs`），Node.js ≥ 22.13。`@cordium/kernel` 无任何依赖；`@cordium/plugins` 只依赖同仓的 `@cordium/kernel`（精确钉版本，两者成对安装）。
- **插件之间只经宿主交互**：服务按契约取用、带访问级别和权限；插件停用后它注册的一切自动回收。
- **防失控**：生命周期钩子有时限，动作派发有在途上限；插件抛出的值经统一错误模型带码送达 —— 动作、服务与消息通道的失败抛给调用方（含插件归属），生命周期钩子与后台失败进宿主日志。
- **可选执行隔离**：把一段可能卡死或吃内存的计算放进 worker 线程或子进程里跑，超时即终止。

> 当前为 0.3.0，接口在 1.0 之前仍可能调整，变更见 [CHANGELOG](CHANGELOG.md)。

## 目录

- [安装](#安装)
- [快速上手](#快速上手)
- [核心概念](#核心概念)
- [两个包](#两个包)
- [写插件](#写插件)
- [开发](#开发)
- [许可证](#许可证)

## 安装

两个包暂不发布到 npm registry。推荐先打包，再以 tarball 引用：

```sh
# 在 cordium 目录下
npm run pack        # 产物：dist/cordium-kernel-0.3.0.tgz、dist/cordium-plugins-0.3.0.tgz
```

```jsonc
// package.json（下游项目）
{
  "dependencies": {
    "@cordium/kernel": "file:../cordium/dist/cordium-kernel-0.3.0.tgz",
    "@cordium/plugins": "file:../cordium/dist/cordium-plugins-0.3.0.tgz"
  }
}
```

- 用到 `@cordium/plugins` 时，两个包都要写进依赖：它的 `dependencies` 钉的是 `@cordium/kernel@0.3.0`，registry 上没有这个包。
- 联调时也可以直接指向源码目录（`file:../cordium/packages/kernel` 与 `file:../cordium/packages/plugins`）。这种写法装进来的是符号链接，Node 按真实路径解析，`@cordium/plugins` 会到 cordium 自己的 `node_modules` 里找 `@cordium/kernel`。所以要先在 cordium 目录下运行一次 `npm install`，否则报 `ERR_MODULE_NOT_FOUND`。

## 快速上手

```js
import { CordiumHost } from '@cordium/kernel';

// 宿主（装配方）：先声明服务契约
const host = new CordiumHost();
host.declareServiceContract('greeter', { access: 'public', methods: ['greet'] });

// 插件 = manifest + activate / deactivate
const greeterPlugin = {
  manifest: { id: 'demo.greeter', name: 'Greeter', version: '1.0.0', apiVersion: '1.0.0', provides: ['greeter'] },
  activate(ctx) {
    ctx.provideService('greeter', { greet: (name) => `Hello, ${name}!` });
  }
};

const appPlugin = {
  manifest: {
    id: 'demo.app', name: 'App', version: '1.0.0', apiVersion: '1.0.0',
    dependencies: { 'demo.greeter': '^1.0.0' }
  },
  activate(ctx) {
    ctx.log('info', ctx.getService('greeter').greet('Cordium'));
  }
};

for (const plugin of [greeterPlugin, appPlugin]) host.registerPlugin(plugin.manifest, plugin);

await host.boot();                           // 按依赖顺序激活：demo.greeter → demo.app
await host.deactivatePlugin('demo.greeter'); // 级联：先停 demo.app，再停 demo.greeter
```

从文件加载插件用 `@cordium/plugins/loader`：

```js
import { loadPlugins } from '@cordium/plugins/loader';

await loadPlugins(host, [
  { module: new URL('./plugins/greeter.mjs', import.meta.url) },
  { module: '/abs/path/app.mjs', config: { lang: 'zh' } }
]);
await host.boot();
```

插件文件放在哪个目录都可以，清单里写绝对路径或 `file:` URL 即可。可运行的完整示例（含开发期热重载）见 [examples/](examples/)。

## 核心概念

| 概念 | 说明 |
|---|---|
| **宿主** `CordiumHost` | 由应用（装配方）创建。声明服务契约和权限名、登记插件、启动与停用插件，并提供诊断信息。 |
| **插件** | 一个 `manifest` 加上可选的 `activate(ctx)` / `deactivate()`。插件能做的事全部经 `ctx` 完成。 |
| **服务契约** | 装配方声明「有哪个服务、谁能取、必须有哪些方法」。插件不能自造服务名。 |
| **服务** | 插件在 `activate` 里 `provideService`，其它插件 `getService` 取到一个句柄；提供者停用后句柄立即失效。 |
| **动作** | 带权限守门、超时的点对点调用：`registerAction` / `dispatchAction`。 |
| **消息通道** | 一对多通知：`emit` / `parallel` / `serial` / `waterfall`。 |
| **作用域** | `ctx.scoped(label)` 让服务与事件只在同一作用域内流动（例如按 agent 或会话隔离）。 |
| **资源回收** | 插件注册的服务、动作、监听器、UI 贡献、托管的定时器都挂在它的 `scope` 上，停用时由宿主统一回收。 |

## 两个包

| 包 | 入口 | 内容 |
|---|---|---|
| `@cordium/kernel` | `@cordium/kernel` | `CordiumHost`、`EffectScope`、`MessageChannel`、`CordiumError` / `ErrorCode`、manifest 校验、SemVer 工具 |
| `@cordium/plugins` | `/loader` | `loadPlugins`：按清单从模块加载并登记插件（全有或全无） |
| | `/reload` | `reloadPlugin` / `watchPlugins`：开发期热重载，改完插件文件不重启进程就换上新代码（只重载声明了 `hotReload: true` 的插件） |
| | `/isolation` | `callIsolated` / `configureIsolation`：把某个模块里的一个导出函数放到 worker 线程或子进程里执行 |
| | `/runtime` | `validatePluginManifest`：描述符层的 manifest 校验，列表与字段形状比内核更严格（适合插件市场 / 目录） |
| | `/catalog` | `createPluginCatalog`：插件元数据索引（不执行插件代码） |
| | `/ecosystem` | `resolvePluginDependencies`（依赖排序）、`normalizeDependencies`、`callWithTimeout` |

只能从上表列出的入口导入；`@cordium/kernel/internal` 是两包之间共享的内部工具，签名不承诺稳定。

依赖方向单向：`@cordium/plugins` → `@cordium/kernel`，内核不依赖插件层。

## 写插件

**[PLUGIN_GUIDE.md](PLUGIN_GUIDE.md)** 是写插件所需的完整接口说明：manifest 字段、`ctx` 全部成员、服务与动作的规则、作用域、生命周期、错误码，以及装配方需要做的事。按它写就不需要读内核源码。

## 开发

```bash
npm install
npm test               # 两包全部测试
npm run test:coverage  # 测试 + 覆盖率
npm run pack           # 打包到 dist/
```

CI（GitHub Actions）在 Ubuntu 与 Windows 上、Node 22 / 24 / 26 各跑一遍测试与打包，另有一步 oxlint 静态检查。贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请按 [SECURITY.md](SECURITY.md) 私下报告；曾删除的接口及原因见 [design/removed-apis.md](design/removed-apis.md)。

## 许可证

[MIT](LICENSE) © [Cadttun](https://github.com/cadttun)
