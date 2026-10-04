/**
 * @file packages/plugins/src/entry.mjs
 * @description 清单条目 → 已加载的插件：loader 与 reload 共用。包内工具，不在 `exports`。
 *
 * 每个函数都带 `fn`（调用方公开函数名）用作报错前缀，报文里点名是哪个入口出的错。
 */
import { CordiumError, ErrorCode, describeError, MAX_TIMER_MS, deepFreeze } from '@cordium/kernel/internal';
import { toModuleHref } from './module-href.mjs';
import { locateSyntaxError } from './syntax-location.mjs';

const ENTRY_KEYS = new Set(['module', 'config', 'disabled', 'group', 'lifecycleTimeoutMs']);

/**
 * 校验并规范化一个清单条目。
 * @param {any} entry
 * @param {string} where 报错前缀，如 `loadPlugins: entries[0]`
 */
export function normalizeEntry(entry, where) {
  const fail = msg => new CordiumError(ErrorCode.INVALID_ARGUMENT, `${where} ${msg}`);
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
  // ★ 克隆与冻结是两件事，归因必须分开（此前合成一条 try，把冻结失败也说成「不可克隆」）：
  //   实测 `config: new Uint8Array(3)` 能被 structuredClone 成功克隆，却因
  //   Object.freeze 对**非空 TypedArray** 抛 TypeError 而报成 "must be structured-cloneable" ——
  //   报文把调用方指向了错误的排查方向（输入没问题，是本层的冻结策略）。
  //   现在：克隆失败 ⇒ 是输入的错；冻结走 deepFreeze，对视图类型一律跳过，不再抛。
  let cloned;
  try { cloned = structuredClone(entry.config ?? {}); } catch (err) {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `${where} config must be structured-cloneable`, { cause: err });
  }
  const config = deepFreeze(cloned);
  return { href: toModuleHref(entry.module, `${where}.module`), config, disabled: entry.disabled === true, group: entry.group ?? null, lifecycleTimeoutMs: t };
}

function pluginShape(mod, href, fn) {
  const src = (mod.manifest === undefined && mod.default && typeof mod.default === 'object') ? mod.default : mod;
  const fail = msg => new CordiumError(ErrorCode.INVALID_MANIFEST, `${fn}: module '${href}' ${msg}`);
  if (!src.manifest || typeof src.manifest !== 'object') throw fail('must export a `manifest` object (named or on default)');
  for (const hook of ['activate', 'deactivate']) {
    if (src[hook] !== undefined && typeof src[hook] !== 'function') throw fail(`\`${hook}\` must be a function`);
  }
  return src;
}

export const defaultImport = href => import(href);
// 被抛出的可以是任何值（Proxy / 抛错的 getter）：判断本身不得再抛
const isSyntaxError = err => { try { return err?.name === 'SyntaxError'; } catch { return false; } };

/**
 * 加载一个模块并读出插件形状；任何失败都归一为带码错误。
 * @param {string} href 交给 importModule 的地址（重载时带防缓存查询串）
 * @param {(href: string) => Promise<any>} importModule
 * @param {string} fn 报错前缀
 */
export async function loadOne(href, importModule, fn) {
  let mod;
  try {
    mod = await importModule(href);
  } catch (err) {
    // ★ 语法 / 链接错：import() 抛的 SyntaxError 栈里只有 Node 内部帧，没有文件与行号 ⇒ 让 Node 在子进程里报一次位置
    //   （只在失败路径上付代价；只用默认加载器 —— 自定义 importModule 可能根本不读文件，不去猜）
    const where = isSyntaxError(err) && importModule === defaultImport ? await locateSyntaxError(href) : null;
    throw new CordiumError(ErrorCode.PLUGIN_LOAD_FAILED,
      `${fn}: failed to load '${href}': ${describeError(err)}${where ? `\n  at ${where}` : ''}`, { cause: err });
  }
  // 模块导出可以是抛错的 getter：读形状时的非 CordiumError 同样算加载失败（否则会漏出裸错误）
  try { return pluginShape(mod, href, fn); } catch (err) {
    if (err instanceof CordiumError) throw err;
    throw new CordiumError(ErrorCode.PLUGIN_LOAD_FAILED, `${fn}: reading exports of '${href}' threw: ${describeError(err)}`, { cause: err });
  }
}

/** 清单条目 → 内核 entry：config 由加载器注入 activate 第二参 */
export function hostEntry(plugin, config) {
  return {
    activate: plugin.activate ? (ctx) => plugin.activate(ctx, config) : undefined,
    deactivate: plugin.deactivate ? () => plugin.deactivate() : undefined
  };
}

export function assertHost(host, fn) {
  if (!host || typeof host.registerPlugin !== 'function' || typeof host.deactivatePlugin !== 'function') {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `${fn}: host must be a CordiumHost`);
  }
}
