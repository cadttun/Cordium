// 错误模型门禁：src 下一切抛错都带稳定 code；码表清单钉死。
// ★ 为什么是文本门禁：「这个抛错点有没有 code」只能在源码上看 —— 运行期测试只覆盖被走到的分支。
// ⚠️ 文本门禁的固有上限（同 neutrality / boundary）：`const E = Error; throw new E()` 之类绕得过去。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CordiumError, ErrorCode } from '../src/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC_DIRS = ['packages/kernel/src', 'packages/plugins/src'];

function sources() {
  return SRC_DIRS.flatMap(dir => fs.readdirSync(path.join(ROOT, dir))
    .filter(n => n.endsWith('.mjs'))
    .map(n => ({ file: `${dir}/${n}`, text: fs.readFileSync(path.join(ROOT, dir, n), 'utf8') })));
}

// 裸 Error 的构造（不论是否紧跟 throw）；`new Error(message).stack` 这种只取栈的写法也算 —— 一律走 CordiumError。
// 前面不得是标识符字符：不误伤 `new CordiumError(` / `new TypeError(`。
// ★ 故意不加 /g：本常量导出给下面的自检用，带 /g 会让 `.test()` 带状态（lastIndex 残留 ⇒ 同一断言第二次翻转）。
export const BARE_ERROR = /(?<![\w$])new\s+Error\s*\(/;
const CODE_REF = /\bErrorCode\.([A-Z_]+)\b/g;

const BACKSLASH = String.fromCharCode(92);   // 避免转义地狱

/**
 * 把源码的**注释抹成空白**、**字符串/模板抹成占位符** `"S"`，其余原样。
 *
 * ★ 为什么要抹字符串：`new CordiumError('typo', …)` 的首参就在字符串里 —— 抹成空白会把首参
 *   一起吃掉（漏判），抹成 `"S"` 才能让下游看出「这里有个字面量，不是 ErrorCode.X」。
 * ★ 为什么必须保留换行：行号要从处理后的文本算。模板字面量跨行时若把内部换行一起删掉，
 *   **后面所有行号都会前移** —— 报错位置全错，且错得看不出来。
 * ★ 本函数统一了此前两处各写各的清洗（一处的 `//.*$` 会把 `'https://…'` 之后的代码整段截掉 ⇒ 漏判）。
 */
function scrubCode(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '*') {                       // 块注释
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === '/' && d === '/') {                       // 行注释
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {          // 字符串 / 模板
      const quote = c;
      let j = i + 1;
      let newlines = 0;
      while (j < n) {
        if (text[j] === BACKSLASH) { if (text[j + 1] === '\n') newlines++; j += 2; continue; }
        if (text[j] === '\n') newlines++;
        if (text[j] === quote) { j++; break; }
        j++;
      }
      out += '"S"' + '\n'.repeat(newlines);             // ★ 占位 + 补齐换行（见上）
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 字符下标 ⇒ 行号（scrubCode 保行数，故对原文同样成立） */
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// ── 门禁②：new CordiumError 的首参必须是 ErrorCode.X ────────────────────────
const FIRST_ARG = /new\s+CordiumError\s*\(\s*([^\s,)]+)/g;
const OK_FIRST_ARG = /^ErrorCode\s*\.\s*[A-Z_]+$/;
// ★ 全仓唯一允许「动态首参」的地方：host-util.mjs 的 readOptions —— 它的第 4 个形参就叫 code，
//   3 个抛点原样转发调用方给的码（这是唯一透传口，全量扫描确认）。别处出现动态首参一律红。
const PASS_THROUGH_FILE = 'packages/kernel/src/host-util.mjs';
const PASS_THROUGH_TOKEN = 'code';

/** 返回该文件的「首参违规」清单，并回报用掉了几处透传豁免 */
function badFirstArgs(scrubbed, file) {
  const bad = [];
  let passThrough = 0;
  for (const m of scrubbed.matchAll(FIRST_ARG)) {
    const tok = m[1];
    const at = lineOf(scrubbed, m.index);
    if (tok === PASS_THROUGH_TOKEN) {
      if (file === PASS_THROUGH_FILE) passThrough++;
      else bad.push(`${file}:${at}  动态首参 \`${tok}\` 出现在透传口之外（透传口只有 readOptions）`);
      continue;
    }
    if (!OK_FIRST_ARG.test(tok)) bad.push(`${file}:${at}  首参 \`${tok}\` 不是 ErrorCode.X`);
  }
  return { bad, passThrough };
}

// ── 门禁③：码表每个码都必须可达 ────────────────────────────────────────────
const DIRECT_CODE = /new\s+CordiumError\s*\(\s*ErrorCode\s*\.\s*([A-Z_]+)/g;
const READ_OPTIONS_CALL = /readOptions\s*\(/g;

/** 按括号配对切出每个 readOptions(...) 的实参，返回第 4 个（没写就跳过）。跨行安全。 */
function readOptionsCodeArgs(scrubbed) {
  const out = [];
  for (const m of scrubbed.matchAll(READ_OPTIONS_CALL)) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < scrubbed.length && depth > 0) {
      if (scrubbed[i] === '(') depth++;
      else if (scrubbed[i] === ')') depth--;
      i++;
    }
    const args = [];
    let d = 0;
    let cur = '';
    for (const ch of scrubbed.slice(m.index + m[0].length, i - 1)) {
      if ('([{'.includes(ch)) d++;
      else if (')]}'.includes(ch)) d--;
      if (ch === ',' && d === 0) { args.push(cur); cur = ''; } else cur += ch;
    }
    args.push(cur);
    // 定义处 `code = ErrorCode.INVALID_ARGUMENT` 带前缀，不会被下面的精确匹配认成透传点
    if (args.length >= 4) out.push(args[3].trim());
  }
  return out;
}

/** 抽出一段源码里的「可达点」：直接构造 ∪ readOptions 第 4 参透传 */
function scanReachability(scrubbed) {
  const direct = new Set();
  for (const m of scrubbed.matchAll(DIRECT_CODE)) direct.add(m[1]);
  const viaReadOptions = new Set();
  for (const arg of readOptionsCodeArgs(scrubbed)) {
    const mm = /^ErrorCode\s*\.\s*([A-Z_]+)$/.exec(arg);
    if (mm) viaReadOptions.add(mm[1]);
  }
  return { direct, viaReadOptions };
}

test('★ src 下不得出现裸 new Error(...)：一律 new CordiumError(ErrorCode.X, …)', () => {
  const scan = new RegExp(BARE_ERROR.source, 'g');
  const hits = [];
  for (const { file, text } of sources()) {
    const code = scrubCode(text);                 // 注释 / 字符串里提到 new Error( 不算
    const raw = text.split('\n');
    for (const m of code.matchAll(scan)) {
      const at = lineOf(code, m.index);
      hits.push(`${file}:${at}  ${(raw[at - 1] ?? '').trim()}`);
    }
  }
  assert.deepEqual(hits, [], '\n' + hits.join('\n'));
});

test('★ src 引用的每个 ErrorCode.X 都必须在码表里（拼错即红）', () => {
  const unknown = [];
  for (const { file, text } of sources()) {
    // 注释（JSDoc 里的 `ErrorCode.X` 示例）与字符串里提到的不算引用
    for (const m of scrubCode(text).matchAll(CODE_REF)) {
      if (!(m[1] in ErrorCode)) unknown.push(`${file}  ErrorCode.${m[1]}`);
    }
  }
  assert.deepEqual(unknown, [], '\n' + unknown.join('\n'));
});

// ★★ 上面那道门禁只保证「写出来的 ErrorCode.X 拼不错」；写 `new CordiumError('typo', …)`
//    是字面量，压根不经过 ErrorCode ⇒ 此前全绿。这条补上另一半。
// ⚠️ 故意不覆盖：别名 callee（见下面单独的守卫）、Reflect.construct、子类、不带 new 的调用、
//    正则字面量里的假代码；也不校验码与语义是否匹配（只管形态）。
test('★ src 里 new CordiumError 的首参必须是 ErrorCode.X（写裸字符串码即红）', () => {
  const bad = [];
  let passThrough = 0;
  for (const { file, text } of sources()) {
    const r = badFirstArgs(scrubCode(text), file);
    bad.push(...r.bad);
    passThrough += r.passThrough;
  }
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
  // ★ 判据未失效：透传豁免必须还有实际用武之地，否则这条豁免已成死规则、该连同本测试一起清掉
  assert.ok(passThrough >= 1,
    `host-util.mjs 的 readOptions 透传口不见了 —— 透传豁免已失效，请连同本测试一起清理`);
});

// ★★ 码表清单只钉「有哪些码」；新增一个从不抛出的码，上面三条一条都不会红。
//    判据：码可达 = (a) 出现在 `new CordiumError(ErrorCode.X` 里，或
//    (b) 作为 `readOptions(…, ErrorCode.X)` 的第 4 个实参（唯一透传口）。
// ⚠️ 「可达」只到「有构造点」为止 —— 死分支里的构造点照样算，不等于运行期真会抛。
// ⚠️ 裸引用（`x === ErrorCode.FOO`、把码列进某个 Set）**不算**可达：否则「加一行 + 引用一下」
//    就能骗过本门禁。反向（引用了表外的码）由上面那道 CODE_REF 门禁负责，此处不重复。
test('★ 码表每个码都必须可达（有直接构造点或经 readOptions 透传；防新增死码）', () => {
  const direct = new Set();
  const viaReadOptions = new Set();
  for (const { text } of sources()) {
    const r = scanReachability(scrubCode(text));
    for (const k of r.direct) direct.add(k);
    for (const k of r.viaReadOptions) viaReadOptions.add(k);
  }
  const reachable = new Set([...direct, ...viaReadOptions]);
  const missing = Object.keys(ErrorCode).filter(k => !reachable.has(k));
  assert.deepEqual(missing, [],
    '\n以下码全 src 找不到任何构造 / 透传点（新增死码？）：\n' + missing.join('\n'));
  // ★ 非恒真：扫描必须真抓到构造点，否则「全绿」可能只是空扫（规矩 44 的同款）
  assert.ok(direct.size >= 40, `直接构造点只覆盖 ${direct.size} 个码 —— 扫描疑似失效`);
});

// ★★ 上面两道门禁都锚在字面名 `CordiumError` / `ErrorCode` 上 ⇒ 起了别名就同时失效。
//    正则与 AST 都绕不过别名，只能靠这条独立的守卫。今天 src 内 0 处（全量扫描确认）。
test('★ 不得给 CordiumError / ErrorCode 起别名（别名会让上面两道门禁同时失效）', () => {
  const bad = [];
  for (const { file, text } of sources()) {
    const code = scrubCode(text);
    if (/\bimport\s*\{[^}]*\b(?:CordiumError|ErrorCode)\s+as\s+[\w$]/.test(code)) bad.push(`${file}  import { … as … }`);
    if (/\{[^{}]*\b(?:CordiumError|ErrorCode)\s*:\s*[\w$]/.test(code)) bad.push(`${file}  解构重命名`);
  }
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
});

test('★ 门禁自检：首参门禁能判别，且不误伤注释 / 字符串 / 透传', () => {
  const probe = src => badFirstArgs(scrubCode(src), 'x.mjs');
  const n = src => probe(src).bad.length;
  assert.equal(n("throw new CordiumError('typo_code', 'x')"), 1, '字符串首参必须判红');
  assert.equal(n('throw new CordiumError(`typo`, "x")'), 1, '模板字面量首参必须判红');
  assert.equal(n('throw new CordiumError(ERROR_CODE.X)'), 1, '错枚举对象必须判红');
  assert.equal(n("throw new CordiumError(code, 'x')"), 1, '透传形参出现在透传口之外必须判红');
  assert.equal(n("throw new CordiumError(\n  'typo',\n)"), 1, '跨行调用必须判红');
  assert.equal(n("throw new CordiumError(ErrorCode.X, 'x')"), 0, 'ErrorCode.X 不得误伤');
  assert.equal(n("throw new CordiumError(\n  ErrorCode.ACTION_TIMEOUT, 'x')"), 0, '跨行 ErrorCode.X 不得误伤');
  assert.equal(n("// new CordiumError('typo')"), 0, '行注释不算');
  assert.equal(n("/* new CordiumError('typo') */"), 0, '块注释不算');
  assert.equal(n('const s = "new CordiumError(\'typo\')";'), 0, '字符串内容不算');
  assert.equal(n('throw new TypeError("x")'), 0, '不误伤 TypeError');
  // 透传豁免只认 host-util.mjs 那一个文件
  assert.equal(badFirstArgs(scrubCode("throw new CordiumError(code, 'x')"), PASS_THROUGH_FILE).passThrough, 1);
  // ★ 非恒真：真实 src 里必须确实扫到了构造点
  const total = sources().reduce((acc, { text }) => acc + [...scrubCode(text).matchAll(FIRST_ARG)].length, 0);
  assert.ok(total >= 100, `只扫到 ${total} 个 new CordiumError —— 扫描疑似失效`);
});

test('★ 门禁自检：可达性门禁能判别（从未构造的码必被报出；透传算可达；裸引用不算）', () => {
  const keys = ['A_OK', 'B_DEAD'];
  const one = scanReachability(scrubCode("const e = new CordiumError(ErrorCode.A_OK, 'x');"));
  const reached = new Set([...one.direct, ...one.viaReadOptions]);
  assert.deepEqual(keys.filter(k => !reached.has(k)), ['B_DEAD'], '从未构造的码必须被报出');

  const viaPass = scanReachability(scrubCode("readOptions(o, 'w', [], ErrorCode.B_DEAD);"));
  assert.ok(viaPass.viaReadOptions.has('B_DEAD'), 'readOptions 第 4 参必须被认成透传点');
  assert.equal(viaPass.direct.size, 0, '此例不应有直接构造点（负向对照）');

  const multi = scanReachability(scrubCode("readOptions(\n  options,\n  `w`,\n  ['a', 'b'],\n  ErrorCode.A_OK\n);"));
  assert.ok(multi.viaReadOptions.has('A_OK'), '跨行 / 带数组实参的 readOptions 也要认出来');

  const onlyRef = scanReachability(scrubCode('if (x === ErrorCode.B_DEAD) return [ErrorCode.B_DEAD];'));
  assert.equal(onlyRef.direct.size + onlyRef.viaReadOptions.size, 0, '裸引用不得算可达');

  // 定义处的默认值 `code = ErrorCode.INVALID_ARGUMENT` 不得被误认成透传点
  const def = scanReachability(scrubCode('export function readOptions(options, where, allow = [], code = ErrorCode.INVALID_ARGUMENT) {}'));
  assert.equal(def.viaReadOptions.size, 0, 'readOptions 定义处的默认值不是调用点');
});

test('★ 门禁自检：别名守卫能判别', () => {
  const has = src => /\bimport\s*\{[^}]*\b(?:CordiumError|ErrorCode)\s+as\s+[\w$]/.test(scrubCode(src))
    || /\{[^{}]*\b(?:CordiumError|ErrorCode)\s*:\s*[\w$]/.test(scrubCode(src));
  assert.ok(has("import { CordiumError as CE } from './errors.mjs';"), 'import 别名必须判出');
  assert.ok(has("const { ErrorCode: EC } = await import('./errors.mjs');"), '解构重命名必须判出');
  assert.ok(!has("import { CordiumError, ErrorCode } from './errors.mjs';"), '正常 import 不得误伤');
  assert.ok(!has('const pick = flag ? CordiumError : ErrorCode;'), '三元表达式不得误伤');
});

test('★ 码表清单定稿（增删改 = 破坏性变更）', () => {
  assert.ok(Object.isFrozen(ErrorCode));
  assert.deepEqual(Object.values(ErrorCode).sort(), [
    'access_denied', 'action_failed', 'action_not_found', 'action_overloaded', 'action_owner_gone', 'action_timeout', 'call_timeout',
    'cyclic_dependency', 'dependency_inactive', 'dependency_version_mismatch', 'duplicate_action',
    'duplicate_plugin', 'duplicate_ui_contribution', 'identity_required', 'implementation_conflict',
    'incompatible_api_version', 'invalid_argument', 'invalid_catalog', 'invalid_contract',
    'invalid_dependencies', 'invalid_implementation', 'invalid_manifest', 'invalid_option', 'invalid_permission', 'invalid_registry',
    'invalid_timeout', 'invalid_usage', 'isolated_call_failed', 'isolation_busy', 'lifecycle_timeout', 'listener_failed', 'missing_dependency', 'no_provider', 'optional_unavailable',
    'plugin_has_dependents', 'plugin_load_failed', 'plugin_not_found', 'provide_not_declared', 'provider_conflict',
    'scope_conflict', 'scope_cycle', 'scope_disposed', 'scope_owned_by_host', 'service_failed', 'service_unavailable',
    'undeclared_permission', 'undeclared_service', 'version_conflict'
  ]);
  // 键名与码值一一对应（KEY = 大写的 value），防止「键改了、值没改」
  for (const [k, v] of Object.entries(ErrorCode)) assert.equal(k, v.toUpperCase());
});

test('CordiumError：带 code / pluginId / cause，仍是 Error', () => {
  const cause = new TypeError('root');
  const err = new CordiumError(ErrorCode.NO_PROVIDER, 'x', { cause, pluginId: 'p' });
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'CordiumError');
  assert.equal(err.code, 'no_provider');
  assert.equal(err.pluginId, 'p');
  assert.equal(err.cause, cause);
  assert.equal('cause' in new CordiumError(ErrorCode.NO_PROVIDER, 'y'), false, '不传 cause 就不挂 cause');
});

test('★ 门禁自检：裸 Error 能判别，且不误伤', () => {
  assert.ok(BARE_ERROR.test("throw new Error('x')"));
  assert.ok(BARE_ERROR.test('entry.stack = new Error(message).stack;'));
  for (const ok of ["throw new CordiumError(ErrorCode.X, 'x')", "throw new TypeError('x')", 'const e = err instanceof Error;']) {
    assert.ok(!BARE_ERROR.test(ok), `不得误伤：${ok}`);
  }
});

// ─────────── 文本门禁查不到的「引擎级无码错误」逐条运行期锁定 ───────────
// ★ BARE_ERROR 只能看见源码里的 `new Error(`；引擎自己抛的 TypeError（解构 null、读 null 的属性）
//   与零依赖模块 semver.mjs 的 TypeError 不在文本里 ⇒ 只能按调用点逐条跑。

test('★ 公开 API 的非法输入一律带码（不是引擎 TypeError）', async () => {
  const { CordiumHost, compareSemVer } = await import('../src/index.mjs');
  const { parseRange } = await import('../src/internal.mjs');
  const coded = (fn, code) => assert.throws(fn, err => err instanceof CordiumError && err.code === code);

  coded(() => compareSemVer('x', '1.0.0'), 'invalid_argument');
  coded(() => parseRange('>>>x'), 'invalid_argument');
  assert.equal(compareSemVer('1.0.0', '2.0.0') < 0, true, '正向对照：合法输入照常比较');

  const host = new CordiumHost();
  assert.doesNotThrow(() => host.declareServiceContract('x.null', null), 'null options 按「什么都不写」处理');
  coded(() => host.declareServiceContract('x.num', 42), 'invalid_contract');
  assert.doesNotThrow(() => host.declareServiceContracts({ 'y.null': null }));

  let caught = null;
  host.registerPlugin({ id: 'r', version: '1.0.0', apiVersion: '1.0.0' }, {
    activate(ctx) { try { ctx.registerAction('a'); } catch (e) { caught = e; } }
  });
  await host.boot();
  assert.ok(caught instanceof CordiumError && caught.code === 'invalid_argument', `registerAction 无 options：${caught}`);
});

test('★ ctx.parallel 失败 ⇒ listener_failed，插件原始错误在 cause.errors', async () => {
  const { CordiumHost } = await import('../src/index.mjs');
  const host = new CordiumHost();
  let ctx = null;
  host.registerPlugin({ id: 'p', version: '1.0.0', apiVersion: '1.0.0' }, { activate(c) { ctx = c; } });
  await host.boot();
  const boom = new Error('listener boom');
  ctx.on('evt', () => { throw boom; });
  ctx.on('evt', () => 'fine');
  await assert.rejects(ctx.parallel('evt'), err =>
    err instanceof CordiumError && err.code === 'listener_failed'
    && err.cause instanceof AggregateError && err.cause.errors[0] === boom);
});

test('★ declareServiceContracts 只收对象表：字符串 / 数组不得产出下标假契约', async () => {
  const { CordiumHost } = await import('../src/index.mjs');
  const host = new CordiumHost();
  for (const bad of ['ab', ['svc.a'], 42]) {
    assert.throws(() => host.declareServiceContracts(bad),
      err => err instanceof CordiumError && err.code === 'invalid_argument', `拒绝：${JSON.stringify(bad)}`);
  }
  assert.deepEqual(host.getDiagnostics().services.map(s => s.name), [], '★ 不得注册出 0 / 1 这类下标契约');
  assert.doesNotThrow(() => host.declareServiceContracts(null), 'null 仍视为「没有契约」');
  host.declareServiceContracts({ 'svc.ok': { access: 'public' } });
  assert.deepEqual(host.getDiagnostics().services.map(s => s.name), ['svc.ok'], '正向对照：对象表照常');
});

test('★ 服务名与插件 id 同一格式：非法名 ⇒ invalid_contract，且不落表', async () => {
  const { CordiumHost } = await import('../src/index.mjs');
  const host = new CordiumHost();
  for (const bad of [null, undefined, '', 'Svc.Upper', 'svc/slash', ' svc', 'svc..x', 42]) {
    assert.throws(() => host.declareServiceContract(bad, { access: 'public' }),
      err => err instanceof CordiumError && err.code === 'invalid_contract', `拒绝：${String(bad)}`);
  }
  assert.deepEqual(host.getDiagnostics().services, [], '★ 非法名不得落表');
  for (const ok of ['service.demo', 'svc.demo_name', 'a-b.c_d', 'x1']) {
    assert.doesNotThrow(() => host.declareServiceContract(ok, { access: 'public' }), `合法：${ok}`);
  }
});
