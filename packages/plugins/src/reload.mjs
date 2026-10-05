/**
 * @file packages/plugins/src/reload.mjs
 * @description 开发期热重载：改完插件文件，不重启进程就换上新代码。
 *
 * | 函数 | 做什么 |
 * |---|---|
 * | `reloadPlugin(host, entry)` | 按清单条目重新 `import` 插件模块，经 `host.replacePlugin` 原地换上 |
 * | `watchPlugins(host, entries)` | 监视这些条目的模块文件，保存即重载；返回 `{ close() }` |
 *
 * ★ 只放行 manifest 写了 `hotReload: true` 的插件（宿主里正在跑的版本与新版本都要写）。
 *   判据是插件【持有什么】，不是它【重不重要】：
 *   · 只在 `ctx` 上登记东西（服务 / 动作 / 监听器 / UI / 托管定时器）的插件，停用时宿主全部回收，换代码是安全的；
 *   · 自己持有端口、文件句柄、子进程、未托管的定时器 / 长任务的插件，除非 `deactivate` 或 `ctx.scope` 清理回调
 *     把它们释放干净，否则旧实例的资源会留在进程里 —— 这类插件不写 `hotReload`，改了代码就重启进程。
 *   不想逐个声明的开发场景可传 `force: true` 跳过检查（后果自负）。
 *
 * ⚠️ 只用于开发，别在生产里用：
 *   · **内存只增不减**：ESM 没有卸载模块的接口，重载靠给地址加查询串（`?cordium-reload=N`）让 Node 当成新模块加载，
 *     旧模块永远留在内存里（实测：500KB 的模块重载 100 次，堆从 4MB 涨到 55MB，GC 后不回落）。
 *   · **只重载插件入口这一个文件**：它 `import` 的其它模块仍是第一次加载的那份。改了被引用的文件要重启进程
 *     （或把常改的逻辑放进入口文件）。
 *   · 依赖方会被停下再拉起（见 `host.replacePlugin`），它们手里的旧服务句柄失效，须在新的 `activate` 里重新 `getService`。
 *   生产环境要换插件代码：重启进程；或把插件放进子进程，换代码 = 杀掉重起。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CordiumError, ErrorCode, readOptions, describeError } from '@cordium/kernel/internal';
import { normalizeEntry, loadOne, hostEntry, assertHost, defaultImport } from './entry.mjs';

let generation = 0;

/** 同一文件每次得到不同的地址 ⇒ Node 的模块缓存认作新模块 */
function freshHref(href) {
  generation += 1;
  return `${href}${href.includes('?') ? '&' : '?'}cordium-reload=${generation}`;
}

/** 清单条目 → 规范化结果；只收本地文件（data: 的内容就在地址里，加查询串会改掉内容；远程地址没法监视） */
function readEntry(entry, where) {
  const e = normalizeEntry(entry, where);
  if (!e.href.startsWith('file:')) {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `${where}.module must be a local file (absolute path or file: URL), got '${e.href}'`);
  }
  return e;
}

function assertHotReloadable(running, manifest, force) {
  if (force) return;
  const unsafe = [running.hotReload !== true && 'the running version', manifest.hotReload !== true && 'the new version'].filter(Boolean);
  if (unsafe.length > 0) {
    throw new CordiumError(ErrorCode.INVALID_USAGE,
      `reloadPlugin: plugin '${manifest.id}' is not hot-reloadable (${unsafe.join(' and ')} ${unsafe.length > 1 ? 'do' : 'does'} not declare hotReload: true); `
      + 'restart the process instead, or pass { force: true }',
      { pluginId: manifest.id });
  }
}

/**
 * 重新加载一个插件模块并原地换上（同 id）。
 *
 * @param {import('@cordium/kernel').CordiumHost} host
 * @param {{ module: string|URL, config?: object, lifecycleTimeoutMs?: number }} entry
 *        与 `loadPlugins` 同形的清单条目。`disabled` / `group` 不起作用：替换保留插件原来的启停状态。
 * @param {object} [options]
 * @param {boolean} [options.force=false] 不检查 `hotReload` 声明
 * @param {(href: string) => Promise<any>} [options.importModule] 模块加载器（默认动态 `import`）；收到的地址带防缓存查询串
 * @returns {Promise<{ id: string, version: string, previousVersion: string }>}
 */
export async function reloadPlugin(host, entry, options) {
  const { force = false, importModule = defaultImport } = readOptions(options, 'reloadPlugin', ['force', 'importModule']);
  assertHost(host, 'reloadPlugin');
  if (typeof importModule !== 'function') throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'reloadPlugin: importModule must be a function');
  const e = readEntry(entry, 'reloadPlugin: entry');
  const plugin = await loadOne(freshHref(e.href), importModule, 'reloadPlugin');
  const id = plugin.manifest.id;
  const running = host.getDiagnostics().plugins.find(p => p.id === id);
  if (!running) {
    throw new CordiumError(ErrorCode.PLUGIN_NOT_FOUND,
      `reloadPlugin: plugin '${String(id)}' is not registered (load it with loadPlugins first; the id must stay the same across reloads)`,
      { pluginId: typeof id === 'string' ? id : null });
  }
  assertHotReloadable(running, plugin.manifest, force);
  const replaceOptions = e.lifecycleTimeoutMs === undefined ? undefined : { lifecycleTimeoutMs: e.lifecycleTimeoutMs };
  await host.replacePlugin(plugin.manifest, hostEntry(plugin, e.config), replaceOptions);
  return { id, version: host.getDiagnostics().plugins.find(p => p.id === id).version, previousVersion: running.version };
}

/**
 * 监视清单里各插件的模块文件，保存即 `reloadPlugin`。
 *
 * ★ 监视文件所在目录而不是文件本身：不少编辑器保存时先写临时文件再改名替换，
 *   直接监视文件的话，第一次保存后监视就断了。
 * ★ 同一文件的连续变更合并成一次（`debounceMs`）；重载进行中又改了 ⇒ 这次完了再重载一次，不并发。
 * ★ 重载失败（语法错、激活失败、未声明 hotReload）只交给 `onError`，监视继续 —— 改好再存一次即可。
 *   激活失败时宿主已换回旧代码（见 `host.replacePlugin`）。
 *
 * @param {import('@cordium/kernel').CordiumHost} host
 * @param {Array<{ module: string|URL, config?: object, lifecycleTimeoutMs?: number }>} entries
 * @param {object} [options]
 * @param {(result: { id: string, version: string, previousVersion: string }) => void} [options.onReload]
 * @param {(err: unknown, entry: object) => void} [options.onError] 缺省 ⇒ `console.error`
 * @param {number} [options.debounceMs=100]
 * @param {boolean} [options.force=false] 同 `reloadPlugin`
 * @param {(href: string) => Promise<any>} [options.importModule] 同 `reloadPlugin`
 * @returns {{ close(): void }}
 */
export function watchPlugins(host, entries, options) {
  const {
    onReload = () => {}, onError = err => console.error(err), debounceMs = 100, force = false, importModule = defaultImport
  } = readOptions(options, 'watchPlugins', ['onReload', 'onError', 'debounceMs', 'force', 'importModule']);
  assertHost(host, 'watchPlugins');
  if (!Array.isArray(entries)) throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'watchPlugins: entries must be an array');
  for (const [name, fn] of [['onReload', onReload], ['onError', onError], ['importModule', importModule]]) {
    if (typeof fn !== 'function') throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `watchPlugins: ${name} must be a function`);
  }
  if (typeof debounceMs !== 'number' || !Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'watchPlugins: debounceMs must be a non-negative number');
  }

  // 先全部校验（任一条目非法 ⇒ 一个监视都不开）
  const targets = entries.map((entry, i) => ({
    entry,
    file: fileURLToPath(readEntry(entry, `watchPlugins: entries[${i}]`).href),
    timer: null,
    running: false,
    again: false
  }));

  let closed = false;
  // 回调自己抛错不得打断监视
  const safeCall = (fn, ...args) => { try { fn(...args); } catch { /* ignore */ } };

  const run = async (t) => {
    if (t.running) { t.again = true; return; }
    t.running = true;
    try {
      do {
        t.again = false;
        try {
          safeCall(onReload, await reloadPlugin(host, t.entry, { force, importModule }));
        } catch (err) {
          safeCall(onError, err, t.entry);
        }
      // ★ closed 不在这里赋值 —— 它在下面的 closeAll 里被置 true，而 closeAll 作为 close()
      //   暴露给外部；循环体里有 await，外部能在 await 期间调 close() 把它置 true。
      //   ⇒ 循环条件在迭代之间是【会变的】。（静态检查看不见闭包外部的赋值，报的是误报。）
      } while (t.again && !closed);
    } finally {
      t.running = false;
    }
  };

  const byDir = new Map();
  for (const t of targets) {
    const dir = path.dirname(t.file);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(t);
  }

  const watchers = [];
  const closeAll = () => {
    closed = true;
    for (const w of watchers) w.close();
    for (const t of targets) clearTimeout(t.timer);
  };
  try {
    for (const [dir, group] of byDir) {
      const w = fs.watch(dir, (_event, filename) => {
        if (closed || !filename) return;
        for (const t of group) {
          if (path.basename(t.file) !== String(filename)) continue;
          clearTimeout(t.timer);
          t.timer = setTimeout(() => { t.timer = null; if (!closed) void run(t); }, debounceMs);
        }
      });
      w.on('error', err => safeCall(onError, err, group[0].entry));
      watchers.push(w);
    }
  } catch (err) {
    closeAll();
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `watchPlugins: cannot watch plugin directory: ${describeError(err)}`, { cause: err });
  }

  return { close: closeAll };
}
