# @cordium/kernel

Cordium 微内核：插件契约、生命周期、服务交付与轻量消息。零业务、零外部依赖，纯 ES Module，Node.js ≥ 22.13。

**完整文档在主仓**：[Cordium](https://github.com/cadttun/cordium) —— 见 [README](https://github.com/cadttun/cordium/blob/main/README.md) 与 [插件开发指南](https://github.com/cadttun/cordium/blob/main/PLUGIN_GUIDE.md)。

```js
import { CordiumHost } from '@cordium/kernel';

const host = new CordiumHost();
host.declareServiceContract('greeter', { access: 'public', methods: ['greet'] });

host.registerPlugin(
  { id: 'demo.greeter', name: 'Greeter', version: '1.0.0', apiVersion: '1.0.0', provides: ['greeter'] },
  { activate: (ctx) => ctx.provideService('greeter', { greet: (n) => `Hello, ${n}!` }) }
);

await host.boot();
```

## 导出

| 入口 | 内容 |
|---|---|
| `@cordium/kernel` | `CordiumHost`、`EffectScope`、`MessageChannel`、`DispatchMode`、`isBailed`、`CordiumError` / `ErrorCode`、manifest 校验、SemVer 工具 |
| `@cordium/kernel/internal` | 与 `@cordium/plugins` 共享的内部工具，签名不承诺稳定 |

插件机制（加载器、执行隔离、manifest 校验、目录索引）见 [`@cordium/plugins`](https://github.com/cadttun/cordium/blob/main/packages/plugins/README.md)。

## 许可证

[MIT](./LICENSE) © [Cadttun](https://github.com/cadttun)
