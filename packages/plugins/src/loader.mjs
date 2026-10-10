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
import { CordiumError, ErrorCode, readOptions } from '@cordium/kernel/internal';
import { normalizeEntry, loadOne, hostEntry, assertHost, defaultImport } from './entry.mjs';

/**
 * 按清单加载并注册插件。
 *
 * @param {import('@cordium/kernel').CordiumHost} host
 * @param {ReadonlyArray<{ module: string|URL, config?: object, disabled?: boolean, group?: string, lifecycleTimeoutMs?: number }>} entries
 * @param {object} [options]
 * @param {(href: string) => Promise<any>} [options.importModule] 模块加载器（默认动态 `import`）；测试 / 打包场景可注入
 * @returns {Promise<Array<{ id: string, group: string|null, disabled: boolean }>>} 按清单顺序
 */
export async function loadPlugins(host, entries, options) {
  const { importModule = defaultImport } = readOptions(options, 'loadPlugins', ['importModule']);
  assertLoadArgs(host, entries, importModule);
  // ① 全部校验清单
  const normalized = entries.map((e, i) => normalizeEntry(e, `loadPlugins: entries[${i}]`));
  // ② 全部加载模块（加载失败 ⇒ 一条都不注册）
  const loaded = [];
  for (const e of normalized) loaded.push({ ...e, plugin: await loadOne(e.href, importModule, 'loadPlugins') });
  assertUniqueIds(loaded);
  // ③ 注册；中途失败 ⇒ 撤掉本次已注册的（宿主里不留半装状态）
  await registerAll(host, loaded);
  return loaded.map(l => ({ id: l.plugin.manifest.id, group: l.group, disabled: l.disabled }));
}

function assertLoadArgs(host, entries, importModule) {
  assertHost(host, 'loadPlugins');
  if (!Array.isArray(entries)) throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'loadPlugins: entries must be an array');
  if (typeof importModule !== 'function') throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'loadPlugins: importModule must be a function');
}

function assertUniqueIds(loaded) {
  const ids = loaded.map(l => l.plugin.manifest.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) {
    throw new CordiumError(ErrorCode.DUPLICATE_PLUGIN, `loadPlugins: plugin '${dup}' appears more than once in the list`, { pluginId: dup });
  }
}

/**
 * 撤销顺序：**依赖方在前、被依赖方在后**（拓扑逆序）。
 *
 * ⚠️ 不能只写 `registered.reverse()` —— 那按的是**清单顺序**，不是依赖顺序。
 *   宿主 `unregisterPlugin` 在「还有依赖方在册」时抛 `plugin_has_dependents`，
 *   而它的判定**只看 manifest.dependencies，不看生命周期状态** ⇒
 *   「已注册但从未激活的依赖方」照样算数。
 *   实测（清单 A 依赖 B，第三个条目注册失败触发回滚）：
 *     按清单逆序撤 ⇒ 撤 B 时 A 还在册且依赖 B ⇒ 抛错被吞 ⇒ **B 残留**，
 *     宿主留下半装状态 —— 与文件头「不留半装状态」的承诺相反。
 *   ⇒ 按依赖拓扑逆序，保证撤每个插件时它的依赖方都已先撤掉。
 */
function rollbackOrder(loaded) {
  const byId = new Map(loaded.map((l) => [l.plugin.manifest.id, l]));
  const out = [];
  const seen = new Set();
  // ★ 迭代 DFS（此前递归，深依赖链会栈溢出）。与 ecosystem.mjs 的 topologicalOrder 同一形状：
  //   enter 压帧、leave 出帧；后序（先访问依赖、再收自己）⇒ 撤销时从末尾取，依赖方先撤。
  const enter = (id, stack) => {
    seen.add(id);
    stack.push({ id, deps: Object.keys(byId.get(id).plugin.manifest.dependencies || {}), next: 0 });
  };
  const leave = (frame) => out.push(frame.id);
  for (const l of loaded) {
    const rootId = l.plugin.manifest.id;
    if (seen.has(rootId)) continue;
    const stack = [];
    enter(rootId, stack);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.next >= frame.deps.length) { leave(stack.pop()); continue; }
      const depId = frame.deps[frame.next++];
      if (seen.has(depId)) continue;
      if (!byId.has(depId)) { seen.add(depId); continue; }   // 依赖不在本批 ⇒ 与递归版一致：标记后跳过
      enter(depId, stack);
    }
  }
  return out.reverse();
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
    // ★ 回滚【不完整】时以回滚错为准（宿主可能已脏），但把【原始注册失败】挂在 cause 上 ——
    //   否则 unregisterAll 一抛，下面的 `throw err` 就永远执行不到，
    //   调用方**永远看不到「为什么注册失败」**（实测：原始错误被顶掉）。
    await unregisterAll(host, registered, loaded, err);
    throw err;
  }
}

/**
 * 回滚已注册的插件。**失败不再静默吞掉。**
 *
 * ★ 此前是 `catch { /* 逆序撤不会被拒 *\/ }` —— 一句**未经运行时验证的注释**，
 *   而它恰恰是错的（见 rollbackOrder 的实测）。更严重的是：即使失败，
 *   调用方也拿不到任何信号，会以为「已回滚干净」。
 * ⇒ 现在：能撤的都撤；若有撤不掉的，**抛出带名单的错误**，
 *   让调用方知道宿主里可能留有半装状态（这比「静默干净」安全得多）。
 *
 * ★ 码是 `plugin_load_failed`（**不是** `invalid_argument`）：回滚失败【不是参数错】，是内部状态失败。
 *   调用方按码分支时，`invalid_argument` 会被读成「输入错、改改重试」，
 *   而真相是**宿主已脏、必须中止**。
 * ★ 原始注册失败挂在 `cause` 上 —— 它是「为什么会走到回滚」的真正原因，绝不能丢。
 *
 * @param {import('@cordium/kernel').CordiumHost} host
 * @param {string[]} ids 本次真的注册成功的插件 id
 * @param {ReadonlyArray<{ plugin: { manifest: { id: string, dependencies?: object } } }>} loaded
 * @param {unknown} originalError 触发回滚的【原始注册失败】—— 挂到回滚错的 cause
 */
async function unregisterAll(host, ids, loaded, originalError) {
  const failed = [];
  for (const id of rollbackOrder(loaded)) {
    if (!ids.includes(id)) continue;              // 只撤本次真的注册成功的
    try { await host.unregisterPlugin(id); }
    catch (err) { failed.push(`${id}(${err?.code ?? 'unknown'})`); }
  }
  if (failed.length > 0) {
    throw new CordiumError(ErrorCode.PLUGIN_LOAD_FAILED,
      `loadPlugins: rollback incomplete — could not unregister ${failed.join(', ')}; `
      + `the host may be left with partially registered plugins`,
      { cause: originalError });
  }
}
