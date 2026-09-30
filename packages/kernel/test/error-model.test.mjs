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
export const BARE_ERROR = /(?<![\w$])new\s+Error\s*\(/;
const CODE_REF = /\bErrorCode\.([A-Z_]+)\b/g;

test('★ src 下不得出现裸 new Error(...)：一律 new CordiumError(ErrorCode.X, …)', () => {
  const hits = [];
  for (const { file, text } of sources()) {
    text.split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');   // 注释里提到 new Error( 不算
      if (BARE_ERROR.test(code)) hits.push(`${file}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], '\n' + hits.join('\n'));
});

test('★ src 引用的每个 ErrorCode.X 都必须在码表里（拼错即红）', () => {
  const unknown = [];
  for (const { file, text } of sources()) {
    // 注释（JSDoc 里的 `ErrorCode.X` 示例）不算引用
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of code.matchAll(CODE_REF)) {
      if (!(m[1] in ErrorCode)) unknown.push(`${file}  ErrorCode.${m[1]}`);
    }
  }
  assert.deepEqual(unknown, [], '\n' + unknown.join('\n'));
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
  for (const ok of ['service.provider', 'svc.agent_loop', 'a-b.c_d', 'x1']) {
    assert.doesNotThrow(() => host.declareServiceContract(ok, { access: 'public' }), `合法：${ok}`);
  }
});
