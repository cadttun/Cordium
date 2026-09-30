// Stores and resolves local plugin metadata without executing plugin code.
import { PLUGIN_API_VERSION, validatePluginManifestDetailed } from './runtime.mjs';
import { diagnosticSink } from './diagnostic-sink.mjs';
import { compareSemVer, CordiumError, ErrorCode, readOptions } from '@cordium/kernel/internal';

// 本文件的 assert 只守目录索引格式 ⇒ 一律 invalid_catalog
function assert(condition, message) {
  if (!condition) throw new CordiumError(ErrorCode.INVALID_CATALOG, message);
}

function clone(value) {
  return structuredClone(value);
}

// 版本比较只用内核 `compareSemVer`（已删除手写 `compareVersions`，见 design/removed-apis.md §6）

/**
 * catalog 条目自身的字段（与 manifest 并列）—— 进 manifest 校验前剥掉。
 * ★ 单一真相源：此前另有一个从未被读的 `ENTRY_FIELDS` 常量与这里的解构各写一份字段名，
 *   改前者零效果。现在剥掉哪些字段直接由本表驱动。
 */
const ENTRY_FIELDS = Object.freeze(['source', 'packageUrl']);

function stripEntryFields(input) {
  if (!input || typeof input !== 'object') return input;
  const manifest = { ...input };
  for (const field of ENTRY_FIELDS) delete manifest[field];
  return manifest;
}

/**
 * @param {object} [options]
 * @param {string} [options.apiVersion]
 * @param {(diagnostic: object) => void} [options.onDiagnostic] ★ manifest 白名单重建丢字段时回调
 *   （形状同内核 diffManifestFields，可直接接 `host.recordManifestDiagnostic`）。
 *   此前 catalog 静默丢字段，且 exportIndex 把丢失写进索引 ⇒ 不可逆。
 */
export function createPluginCatalog(options) {
  const { apiVersion = PLUGIN_API_VERSION, onDiagnostic } = readOptions(options, 'createPluginCatalog');
  const entries = new Map();
  const report = diagnosticSink(onDiagnostic);

  function add(input) {
    // 平铺写法（manifest 与条目字段混在一层）：source / packageUrl 归 catalog 条目，先剥掉再校验，
    //   否则会被报成「manifest 丢字段」（误报）。校验器本就不读这两个键 ⇒ manifest 结果不变。
    const raw = input?.manifest || stripEntryFields(input);
    const { manifest, diagnostic } = validatePluginManifestDetailed(raw, { apiVersion });
    report(diagnostic);
    const current = entries.get(manifest.id);
    if (current && compareSemVer(manifest.version, current.manifest.version) < 0) {
      throw new CordiumError(ErrorCode.VERSION_CONFLICT, 'catalog plugin version is older', { pluginId: manifest.id });
    }
    entries.set(manifest.id, {
      manifest,
      source: String(input?.source || 'local'),
      packageUrl: input?.packageUrl ? String(input.packageUrl) : null
    });
    return clone(entries.get(manifest.id));
  }

  function list() {
    return [...entries.values()]
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
      .map(clone);
  }

  return {
    add,
    list,
    resolve(id) {
      const entry = entries.get(id);
      return entry ? clone(entry) : null;
    },
    exportIndex() {
      return JSON.stringify({
        schemaVersion: 'plugin-catalog/v1',
        apiVersion,
        entries: list()   // ★ 不依赖 this：解构调用（const { exportIndex } = catalog）也必须可用
      });
    },
    importIndex(raw) {
      assert(typeof raw === 'string', 'catalog index must be text');
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        throw new CordiumError(ErrorCode.INVALID_CATALOG, 'invalid catalog index: ' + error.message, { cause: error });
      }
      assert(payload?.schemaVersion === 'plugin-catalog/v1', 'catalog schema version is incompatible');
      assert(payload.apiVersion === apiVersion, 'catalog api version is incompatible');
      assert(Array.isArray(payload.entries), 'catalog entries are invalid');
      // ★ 原子导入：先在副本上全部校验通过，再整体替换。
      //   此前逐条 add，第 N 条失败时前 N-1 条已写入 ⇒ 半导入状态。
      // ★ 诊断先暂存，整体替换成功后再上报 —— 导入失败时不报「会丢」的字段（那批条目根本没落地）。
      const pending = [];
      const staged = createPluginCatalog({ apiVersion, onDiagnostic: d => pending.push(d) });
      for (const [, entry] of entries) staged.add(entry);
      payload.entries.forEach(staged.add);
      entries.clear();
      for (const entry of staged.list()) entries.set(entry.manifest.id, entry);
      pending.forEach(report);
      return list();
    }
  };
}
