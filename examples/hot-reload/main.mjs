// 热重载示例（开发用）：启动后修改 plugins/ 下的插件文件并保存，插件会在不重启进程的情况下换上新代码。
// 运行：node examples/hot-reload/main.mjs            （Ctrl+C 退出）
//      node examples/hot-reload/main.mjs <插件目录>  （用别处的一份插件，目录里须有 greeting.mjs 与 ticker.mjs）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CordiumHost } from '@cordium/kernel';
import { loadPlugins } from '@cordium/plugins/loader';
import { watchPlugins } from '@cordium/plugins/reload';

const dir = path.resolve(process.argv[2] ?? fileURLToPath(new URL('./plugins', import.meta.url)));

const host = new CordiumHost();
host.declareServiceContract('greeting', { access: 'declared', methods: ['text'] });

const entries = [
  { module: path.join(dir, 'greeting.mjs') },
  { module: path.join(dir, 'ticker.mjs'), config: { name: 'Cordium', intervalMs: 1000 } }
];
await loadPlugins(host, entries);
await host.boot();

const watcher = watchPlugins(host, entries, {
  onReload: ({ id, previousVersion, version }) => console.log(`[reload] ${id} ${previousVersion} -> ${version}`),
  // 语法错、激活失败都到这里；正在跑的代码不受影响，改好再存一次即可
  onError: (err) => console.error(`[reload failed] ${err.code ?? ''} ${err.message}`)
});
console.log(`watching ${dir} — edit a plugin and save (Ctrl+C to quit)`);

process.on('SIGINT', async () => {
  watcher.close();
  for (const { id } of [...host.getDiagnostics().plugins].reverse()) await host.deactivatePlugin(id);
  process.exit(0);
});
