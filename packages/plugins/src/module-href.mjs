/**
 * @file packages/plugins/src/module-href.mjs
 * @description 插件模块位置 → 可 `import()` 的 href（loader / isolation 共用）。包内工具，不在 `exports`。
 *
 * 只收绝对路径 / `file:` / `data:` URL / URL 对象。相对路径不收：相对谁会随调用方工作目录漂移。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { CordiumError, ErrorCode, describeValue } from '@cordium/kernel/internal';

/**
 * @param {string|URL} module
 * @param {string} where 报错前缀，如 `loadPlugins: entries[0].module`
 * @returns {string}
 */
export function toModuleHref(module, where) {
  if (module instanceof URL) return module.href;
  if (typeof module === 'string' && /^(?:file|data):/.test(module)) return module;
  if (typeof module === 'string' && path.isAbsolute(module)) return pathToFileURL(module).href;
  throw new CordiumError(ErrorCode.INVALID_ARGUMENT,
    `${where} must be an absolute path, a file: URL or a URL object, got '${describeValue(module)}'`);
}
