# 示例

可直接运行的示例插件与装配脚本。先在仓库根目录运行一次 `npm install`（建立两个 workspace 的链接），然后：

| 示例 | 运行 | 演示 |
|---|---|---|
| [`basic/`](basic/) | `node examples/basic/main.mjs` | 从文件加载插件、服务契约与依赖、事件、带权限的动作、级联停用与自动恢复 |
| [`hot-reload/`](hot-reload/) | `node examples/hot-reload/main.mjs` | 开发期热重载：运行中修改 `plugins/` 下的文件并保存，插件不重启进程就换上新代码 |

- 插件文件放在哪个目录都可以，装配脚本的清单里写绝对路径或 `file:` URL 即可。`hot-reload` 可以指向别处的一份插件：`node examples/hot-reload/main.mjs /path/to/your/plugins`。
- 在自己的项目里使用时，把 `@cordium/kernel` 与 `@cordium/plugins` 装为依赖（见仓库 [README](../README.md#安装)），示例代码不用改。
- 写插件的完整接口说明见 [PLUGIN_GUIDE.md](../PLUGIN_GUIDE.md)；热重载的适用范围与限制见其中「开发期热重载」一节。
- 这些示例由 `npm test` 实际运行（`packages/plugins/test/examples.test.mjs`），接口变了示例跟着变。
