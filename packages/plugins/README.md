# @cordium/plugins

Cordium 的插件机制：加载器、执行隔离、manifest 校验、依赖解析、目录索引。不含任何具体业务插件。纯 ES Module，Node.js ≥ 22.13。

**完整文档在主仓**：[Cordium](https://github.com/cadttun/cordium) —— 见 [README](https://github.com/cadttun/cordium/blob/main/README.md) 与 [插件开发指南](https://github.com/cadttun/cordium/blob/main/PLUGIN_GUIDE.md)。

> 本包依赖 `@cordium/kernel@0.1.0`，两个包要成对安装。

## 导出

| 入口 | 内容 |
|---|---|
| `@cordium/plugins/loader` | `loadPlugins`：按清单从模块加载并登记插件（全有或全无） |
| `@cordium/plugins/reload` | `reloadPlugin` / `watchPlugins`：开发期热重载，改完插件文件不重启进程就换上新代码（只重载声明了 `hotReload: true` 的插件） |
| `@cordium/plugins/isolation` | `callIsolated` / `configureIsolation`：把某个模块里的一个导出函数放到 worker 线程或子进程里执行 |
| `@cordium/plugins/runtime` | `validatePluginManifest` / `validatePluginManifestDetailed`：描述符层的 manifest 校验，列表与字段形状比内核更严格（适合插件市场 / 目录） |
| `@cordium/plugins/catalog` | `createPluginCatalog`：插件元数据索引（不执行插件代码） |
| `@cordium/plugins/ecosystem` | `resolvePluginDependencies`（依赖排序）、`normalizeDependencies`、`callWithTimeout` |

```js
import { loadPlugins } from '@cordium/plugins/loader';

await loadPlugins(host, [
  { module: '/abs/path/plugins/store.mjs' },
  { module: '/abs/path/plugins/app.mjs', config: { lang: 'zh' } }
]);
await host.boot();
```

## 许可证

[MIT](./LICENSE) © [Cadttun](https://github.com/cadttun)
