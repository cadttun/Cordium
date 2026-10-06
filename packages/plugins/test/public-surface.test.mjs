/**
 * 公开面门禁：`@cordium/plugins` 六个入口的导出清单（定稿）。
 *
 * ── 为什么需要它（实测缺口）────────────────────────────────────────
 *   本仓内核侧的 `packages/kernel/test/public-surface.test.mjs` 把 `index.mjs` / `internal.mjs`
 *   的导出**逐字钉死**，注释写明「增删改名 = 有意的 API 变更」。
 *   而**同仓的 plugins 包此前只钉了子路径键名**（`boundary.test.mjs` 的 `Object.keys(pkg.exports)`），
 *   **没钉每个入口里导出什么**。实测：
 *     · 往 `runtime.mjs` 加一个 `export const X = 1`  ⇒ **全量测试 521/521 全绿**，无人拦；
 *     · 把 `validatePluginManifest` 改名           ⇒ 22 条变红（既有测试在调它）。
 *   ⇒ **改名有人管（因为测试在调），加导出无人管** —— 导出面可以**无声膨胀**。
 *
 * ── 为什么「加导出」也值得拦 ────────────────────────────────────────
 *   本包的消费者是**外部仓**（通过 symlink 直连源码，无 registry、无版本约束）。
 *   导出面即**契约面**：多出来的一项会被下游当成「可以用的 API」，
 *   而它可能只是内部重构的副产物 —— 等真要改它时，就已经是破坏性变更了。
 *   ⇒ 把「静默」变成「**显式**」：新增导出必须在【这里】改一行，那一刻就是有意的。
 *
 * ★ 与 `kernel/test/public-surface.test.mjs` **同一口径**：显式具名、增删改名即红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../src/runtime.mjs';
import * as ecosystem from '../src/ecosystem.mjs';
import * as catalog from '../src/catalog.mjs';
import * as isolation from '../src/isolation.mjs';
import * as loader from '../src/loader.mjs';
import * as reload from '../src/reload.mjs';
import pkg from '../package.json' with { type: 'json' };

/** 六个入口的导出清单（定稿）。★ 增删改名任何一项 = 有意的 API 变更，必须同时改这里。 */
const EXPECTED = {
  './runtime': ['PLUGIN_API_VERSION', 'validatePluginManifest', 'validatePluginManifestDetailed'],
  './ecosystem': ['callWithTimeout', 'normalizeDependencies', 'resolvePluginDependencies'],
  './catalog': ['createPluginCatalog'],
  './isolation': ['callIsolated', 'configureIsolation', 'IsolationCode'],
  './loader': ['loadPlugins'],
  './reload': ['reloadPlugin', 'watchPlugins']
};

const MODULES = {
  './runtime': runtime, './ecosystem': ecosystem, './catalog': catalog,
  './isolation': isolation, './loader': loader, './reload': reload
};

test('★ 六个入口的导出清单定稿（增删改名 = 有意的破坏性变更）', () => {
  for (const [entry, expected] of Object.entries(EXPECTED)) {
    assert.deepEqual(Object.keys(MODULES[entry]).sort(), [...expected].sort(),
      `${entry} 的导出面变了 —— 这是有意变更吗？是则同步改本清单与 PLUGIN_GUIDE`);
  }
});

test('★ 门禁覆盖完整：`package.json` exports 里的每个子路径都被本文件钉到了', () => {
  // ★ 判据取自 package.json（唯一真相源），不手列 —— 将来新增入口若忘了加进 EXPECTED，这里变红。
  const declared = Object.keys(pkg.exports).filter(k => k !== './package.json');
  assert.deepEqual(declared.sort(), Object.keys(EXPECTED).sort(),
    'exports 声明了本文件没覆盖的入口（或反之）—— 新入口必须同时进 EXPECTED，否则它没有门禁');
});

test('★ 门禁自检：清单本身有内容、且与模块真对得上（否则是恒真的假绿）', () => {
  assert.ok(Object.keys(EXPECTED).length >= 6, '六个入口都要在');
  assert.ok(Object.values(EXPECTED).every(list => list.length > 0), '每个入口都必须列出导出（空清单 = 没门禁）');
  // 反例：编一个不存在的导出名，必须与真清单不符
  assert.notDeepEqual(Object.keys(runtime).sort(), ['validatePluginManifest'], '清单不能被写成明显更短的版本');
});

test('★ 每个导出都必须是函数或常量（不得导出可变对象 —— 消费者改了会串给别人）', () => {
  for (const [entry, mod] of Object.entries(MODULES)) {
    for (const [name, value] of Object.entries(mod)) {
      const kind = typeof value;
      assert.ok(kind === 'function' || kind === 'string' || Object.isFrozen(value),
        `${entry} 的导出 ${name} 是 ${kind} 且未冻结 —— 导出面应交出函数或不可变常量`);
    }
  }
});
