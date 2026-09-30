/**
 * @file packages/plugins/src/loader.mjs
 * @description 加载器（最小可用版）：按声明清单把插件模块装进宿主。
 *
 * 形状对标 cordis 的 `Entry`（id / name / config / group / disabled），只取本内核已有语义能承接的部分：
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `module`   | 必填。插件模块的绝对路径 / `file:` URL / URL 对象 |
 * | `config`   | 可选，普通对象。作为 `activate(ctx, config)` 的第二参交给插件（结构化克隆 + 冻结，插件改不到清单） |
 * | `disabled` | 可选。`true` ⇒ 注册但标记为「用户停用」，`boot()` 跳过它及依赖它的插件（内核既有语义） |
 * | `group`    | 可选字符串，只用于诊断分组（`loadPlugins` 返回值里原样带出），内核不解释 |
 * | `lifecycleTimeoutMs` | 可选。放宽 / 收紧【这一个】插件的 activate / deactivate 上限（覆盖宿主 `lifecycleTimeoutMs`）。清单是装配方写的，所以放在这里而不是 manifest |
 *
 * 插件模块写法（二选一）：
 *   · 具名导出 `manifest` + 可选 `activate(ctx, config)` / `deactivate()`；
 *   · `default` 导出同形对象。
 *
 * ★ 边界：
 *   · **加载器不做任何隔离**（加载 ≠ 隔离）。模块在宿主进程内 `import`，拥有进程全部权限。
 *     需要把某段计算放进隔离环境，用 `@cordium/plugins/isolation` 的 `callIsolated`。
 *   · 清单**整体先验证、再加载、再注册**：任一条目非法 / 模块加载失败 ⇒ 一条都不注册（不留半装状态）。
 *   · 不调 `boot()`：何时启动由调用方决定（通常装配层 `await loadPlugins(...)` 后 `await host.boot()`）。
 */
import { CordiumError, ErrorCode, describeError, readOptions, MAX_TIMER_MS } from '@cordium/kernel/internal';
import { toModuleHref } from './module-href.mjs';
import { locateSyntaxError } from './syntax-location.mjs';

const ENTRY_KEYS = new Set(['module', 'config', 'disabled', 'group', 'lifecycleTimeoutMs']);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function normalizeEntry(entry, index) {
  const fail = msg => new CordiumError(ErrorCode.INVALID_ARGUMENT, `loadPlugins: entries[${index}] ${msg}`);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail('must be an object');
  const unknown = Object.keys(entry).filter(k => !ENTRY_KEYS.has(k));
  // ★ 未知键直接拒：清单是人写的，拼错（`disable` / `configs`）静默忽略 = 声明不生效且零报错（白名单重建的老坑）
  if (unknown.length) throw fail(`has unknown field(s): ${unknown.join(', ')} (allowed: ${[...ENTRY_KEYS].join(', ')})`);
  if (entry.config !== undefined && (entry.config === null || typeof entry.config !== 'object' || Array.isArray(entry.config))) {
    throw fail('config must be a plain object');
  }
  if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') throw fail('disabled must be a boolean');
  if (entry.group !== undefined && typeof entry.group !== 'string') throw fail('group must be a string');
  const t = entry.lifecycleTimeoutMs;
  if (t !== undefined && (typeof t !== 'number' || Number.isNaN(t) || t > MAX_TIMER_MS)) {
    throw fail(`lifecycleTimeoutMs must be a number ≤ ${MAX_TIMER_MS} (0 or negative = unlimited)`);
  }
  let config;
  try { config = deepFreeze(structuredClone(entry.config ?? {})); } catch (err) {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `loadPlugins: entries[${index}] config must be structured-cloneable`, { cause: err });
  }
  return { href: toModuleHref(entry.module, `loadPlugins: entries[${index}].module`), config, disabled: entry.disabled === true, group: entry.group ?? null, lifecycleTimeoutMs: t };
}

function pluginShape(mod, href) {
  const src = (mod.manifest === undefined && mod.default && typeof mod.default === 'object') ? mod.default : mod;
  const fail = msg => new CordiumError(ErrorCode.INVALID_MANIFEST, `loadPlugins: module '${href}' ${msg}`);
  if (!src.manifest || typeof src.manifest !== 'object') throw fail('must export a `manifest` object (named or on default)');
  for (const hook of ['activate', 'deactivate']) {
    if (src[hook] !== undefined && typeof src[hook] !== 'function') throw fail(`\`${hook}\` must be a function`);
  }
  return src;
}

/**
 * 按清单加载并注册插件。
 *
 * @param {import('@cordium/kernel').CordiumHost} host
 * @param {Array<{ module: string|URL, config?: object, disabled?: boolean, group?: string }>} entries
 * @param {object} [options]
 * @param {(href: string) => Promise<any>} [options.importModule] 模块加载器（默认动态 `import`）；测试 / 打包场景可注入
 * @returns {Promise<Array<{ id: string, group: string|null, disabled: boolean }>>} 按清单顺序
 */
const defaultImport = href => import(href);
// 被抛出的可以是任何值（Proxy / 抛错的 getter）：判断本身不得再抛
const isSyntaxError = err => { try { return err?.name === 'SyntaxError'; } catch { return false; } };

export async function loadPlugins(host, entries, options) {
  const { importModule = defaultImport } = readOptions(options, 'loadPlugins');
  assertLoadArgs(host, entries, importModule);
  // ① 全部校验清单
  const normalized = entries.map(normalizeEntry);
  // ② 全部加载模块（加载失败 ⇒ 一条都不注册）
  const loaded = [];
  for (const e of normalized) loaded.push({ ...e, plugin: await loadOne(e.href, importModule) });
  assertUniqueIds(loaded);
  // ③ 注册；中途失败 ⇒ 撤掉本次已注册的（宿主里不留半装状态）
  await registerAll(host, loaded);
  return loaded.map(l => ({ id: l.plugin.manifest.id, group: l.group, disabled: l.disabled }));
}

function assertLoadArgs(host, entries, importModule) {
  if (!host || typeof host.registerPlugin !== 'function' || typeof host.deactivatePlugin !== 'function') {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'loadPlugins: host must be a CordiumHost');
  }
  if (!Array.isArray(entries)) throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'loadPlugins: entries must be an array');
  if (typeof importModule !== 'function') throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'loadPlugins: importModule must be a function');
}

/** 加载一个模块并读出插件形状；任何失败都归一为带码错误 */
async function loadOne(href, importModule) {
  let mod;
  try {
    mod = await importModule(href);
  } catch (err) {
    // ★ 语法 / 链接错：import() 抛的 SyntaxError 栈里只有 Node 内部帧，没有文件与行号 ⇒ 让 Node 在子进程里报一次位置
    //   （只在失败路径上付代价；只用默认加载器 —— 自定义 importModule 可能根本不读文件，不去猜）
    const where = isSyntaxError(err) && importModule === defaultImport ? await locateSyntaxError(href) : null;
    throw new CordiumError(ErrorCode.PLUGIN_LOAD_FAILED,
      `loadPlugins: failed to load '${href}': ${describeError(err)}${where ? `\n  at ${where}` : ''}`, { cause: err });
  }
  // 模块导出可以是抛错的 getter：读形状时的非 CordiumError 同样算加载失败（否则会漏出裸错误）
  try { return pluginShape(mod, href); } catch (err) {
    if (err instanceof CordiumError) throw err;
    throw new CordiumError(ErrorCode.PLUGIN_LOAD_FAILED, `loadPlugins: reading exports of '${href}' threw: ${describeError(err)}`, { cause: err });
  }
}

function assertUniqueIds(loaded) {
  const ids = loaded.map(l => l.plugin.manifest.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) {
    throw new CordiumError(ErrorCode.DUPLICATE_PLUGIN, `loadPlugins: plugin '${dup}' appears more than once in the list`, { pluginId: dup });
  }
}

/** 清单条目 → 内核 entry：config 由加载器注入 activate 第二参 */
function hostEntry(plugin, config) {
  return {
    activate: plugin.activate ? (ctx) => plugin.activate(ctx, config) : undefined,
    deactivate: plugin.deactivate ? () => plugin.deactivate() : undefined
  };
}

async function registerAll(host, loaded) {
  const registered = [];
  try {
    for (const { plugin, config, disabled, lifecycleTimeoutMs } of loaded) {
      const options = lifecycleTimeoutMs === undefined ? undefined : { lifecycleTimeoutMs };
      host.registerPlugin(plugin.manifest, hostEntry(plugin, config), options);
      registered.push(plugin.manifest.id);
      // 注册后尚未激活 ⇒ deactivatePlugin 只打「用户停用」标记（boot 跳过它与其依赖方）
      if (disabled) await host.deactivatePlugin(plugin.manifest.id);
    }
  } catch (err) {
    await unregisterAll(host, registered.reverse());
    throw err;
  }
}

async function unregisterAll(host, ids) {
  for (const id of ids) {
    try { await host.unregisterPlugin(id); } catch { /* 依赖方同批注册、同批撤销，逆序撤不会被拒 */ }
  }
}
