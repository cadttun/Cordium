/**
 * @file packages/plugins/src/syntax-location.mjs
 * @description 插件模块语法错时，找回「哪个文件、第几行」。包内工具，不在 `exports`。
 *
 * ★ 为什么需要：动态 `import()` 遇到语法错，抛出的 SyntaxError 的栈**只有 Node 内部帧**
 *   （`node:internal/modules/esm/...`），不含出错文件与行号 —— Node 20 / 24 实测一致。
 *   而同一份代码用 Node 直接跑，首行就是 `file:///…/plugin.mjs:12` 加一行源码和 `^` 指示。
 *   插件作者拿到的却只有 `Unexpected token ';'`，几十个文件里找一个分号。
 *
 * ★ 做法：失败后【另起一个子进程】让 Node 自己报位置，只在失败路径上付一次代价（成功加载零开销）。
 *   子进程入口 = `import '<插件>'; import { 不存在的名字 } from 'data:…'`：
 *   ESM 先把整张依赖图【解析 + 链接】完才开始执行任何模块，而第二句一定链接失败 ⇒
 *   插件若有语法错，报的是插件的位置；没有语法错，报的是入口自己的链接错 —— **两种情况都不执行任何插件代码**
 *   （实测：带顶层副作用的 .mjs、被 .mjs 引用的 .cjs，Node 20 / 24 都未落副作用）。
 *   也覆盖依赖里的语法错（报的是依赖文件的位置）与「导入了不存在的导出名」。
 *
 * ⚠️ 边界：子进程不继承本进程的 loader 钩子（--import / --loader）；靠钩子转译的源（TS 等）找不回位置，返回 null。
 *    找不回 ⇒ 返回 null，调用方照旧只报原错误（兜底不能反过来制造新失败）。
 */
import { execFile } from 'node:child_process';

const PROBE_TIMEOUT_MS = 10_000;
// 子进程 stderr 首行：`file:///C:/x/plugin.mjs:12` 或 Windows 盘符路径 `C:\x\plugin.cjs:12`
const LOCATION_LINE = /^((?:file:\/\/\/|[A-Za-z]:[\\/]|\/).+?:\d+)\s*$/;

/**
 * @param {string} href 插件模块的 file: URL
 * @returns {Promise<string | null>} `位置\n源码行\n指示符`，或 null
 */
export function locateSyntaxError(href) {
  if (typeof href !== 'string' || !href.startsWith('file:')) return Promise.resolve(null);
  const source = `import ${JSON.stringify(href)}; import { __cordium_probe_never__ } from 'data:text/javascript,export{}';`;
  return new Promise(resolve => {
    execFile(process.execPath, ['--input-type=module', '-e', source],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 },
      (_err, _stdout, stderr) => {
        const lines = String(stderr).split(/\r?\n/);
        const loc = LOCATION_LINE.exec(lines[0] ?? '');
        // 报在入口自己身上（[eval…]）⇒ 插件本身能解析，这次失败不是语法错
        if (!loc || loc[1].includes('[eval')) return resolve(null);
        const snippet = lines.slice(1, 3).filter(l => l.trim() !== '');
        resolve([loc[1], ...snippet].join('\n'));
      });
  });
}
