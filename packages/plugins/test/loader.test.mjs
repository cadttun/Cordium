/**
 * @file packages/plugins/test/loader.test.mjs
 * @description 最小可用版：loadPlugins（按清单装插件；不隔离；全有或全无）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost } from '@cordium/kernel';
import { hasCode } from './fixtures/errors.mjs';
import { loadPlugins } from '../src/loader.mjs';

const at = name => new URL(`./fixtures/loadable/${name}`, import.meta.url);
const makeHost = () => { const h = new CordiumHost(); h.declareServiceContracts({ 'service.demo': { access: 'public' } }); return h; };

test('按清单装：具名导出 / default 导出都认；config 交给 activate 且冻结；依赖顺序由 boot 处理', async () => {
  const host = makeHost();
  const result = await loadPlugins(host, [
    { module: at('user.mjs'), group: 'demo' },
    { module: at('base.mjs'), config: { greeting: 'hello' } }
  ]);
  assert.deepEqual(result, [{ id: 'demo.user', group: 'demo', disabled: false }, { id: 'demo.base', group: null, disabled: false }]);
  await host.boot();
  assert.equal(globalThis.__cordiumLoaderSeen, 'hello from base');
  assert.equal(host.getInternalService('service.demo').configFrozen(), true);
});

test('disabled: true ⇒ 注册但 boot 跳过（及其依赖方）', async () => {
  const host = makeHost();
  await loadPlugins(host, [{ module: at('base.mjs'), disabled: true }, { module: at('user.mjs') }]);
  await host.boot();
  assert.throws(() => host.getInternalService('service.demo'), hasCode('no_provider'));
});

test('★ 全有或全无：任一条目坏 ⇒ 一条都不注册（宿主可照常再装）', async () => {
  for (const bad of [
    [{ module: at('base.mjs') }, { module: at('broken.mjs') }],              // manifest 非法（注册期失败 ⇒ 回滚已注册的）
    [{ module: at('base.mjs') }, { module: at('nomanifest.mjs') }],          // 没有 manifest
    [{ module: at('base.mjs') }, { module: at('throws-on-import.mjs') }],    // 模块加载抛错
    [{ module: at('base.mjs') }, { module: at('base.mjs') }]                 // 清单内重复
  ]) {
    const host = makeHost();
    await assert.rejects(loadPlugins(host, bad));
    await loadPlugins(host, [{ module: at('base.mjs') }]);   // 若残留 demo.base，这里会 duplicate_plugin
    await host.boot();
  }
});

test('错误码：加载失败 plugin_load_failed / 缺 manifest invalid_manifest / 重复 duplicate_plugin', async () => {
  await assert.rejects(loadPlugins(makeHost(), [{ module: at('throws-on-import.mjs') }]), hasCode('plugin_load_failed', /module init failed/));
  await assert.rejects(loadPlugins(makeHost(), [{ module: at('nomanifest.mjs') }]), hasCode('invalid_manifest'));
  await assert.rejects(loadPlugins(makeHost(), [{ module: at('base.mjs') }, { module: at('base.mjs') }]), hasCode('duplicate_plugin', /more than once in the list/));   // 清单内重复在注册前就拦（不走「先注册再回滚」）
});

test('清单校验 fail-loud：未知键（拼错）/ 类型错 / 相对路径', async () => {
  const host = makeHost();
  for (const entry of [
    { module: at('base.mjs'), disable: true },
    { module: at('base.mjs'), config: [] },
    { module: at('base.mjs'), disabled: 'yes' },
    { module: at('base.mjs'), group: 1 },
    { module: './base.mjs' },
    null
  ]) {
    await assert.rejects(loadPlugins(host, [entry]), hasCode('invalid_argument'), JSON.stringify(entry));
  }
  await assert.rejects(loadPlugins(host, 'x'), hasCode('invalid_argument'));
  await assert.rejects(loadPlugins({}, []), hasCode('invalid_argument'));
});

test('importModule 可注入（打包 / 测试场景）', async () => {
  const host = makeHost();
  const seen = [];
  await loadPlugins(host, [{ module: 'file:///virtual/p.mjs' }], {
    importModule: async href => { seen.push(href); return { manifest: { id: 'virtual.p', version: '1.0.0', apiVersion: '1.0.0' } }; }
  });
  assert.deepEqual(seen, ['file:///virtual/p.mjs']);
  await host.boot();
});

test('★ 模块导出是抛错的 getter ⇒ plugin_load_failed / invalid_manifest（此前漏出裸错误）', async () => {
  const host = makeHost();
  await assert.rejects(loadPlugins(host, [{ module: 'file:///virtual/a.mjs' }], {
    importModule: async () => ({ get manifest() { throw undefined; } })
  }), hasCode('plugin_load_failed', /threw: undefined/));
  await assert.rejects(loadPlugins(host, [{ module: 'file:///virtual/b.mjs' }], {
    importModule: async () => ({ manifest: { id: 'p.z', version: '1.0.0', get apiVersion() { throw 1; } } })
  }), hasCode('invalid_manifest'));
  assert.equal(host.getDiagnostics().totalPlugins, 0);
});

test('清单条目 lifecycleTimeoutMs：装配方放宽单个插件的生命周期预算（不进 manifest）', async () => {
  const host = new CordiumHost({ lifecycleTimeoutMs: 30 });
  const slow = id => async () => ({ manifest: { id, version: '1.0.0', apiVersion: '1.0.0' }, activate: () => new Promise(r => setTimeout(r, 120)) });
  await loadPlugins(host, [{ module: 'file:///virtual/slow.mjs', lifecycleTimeoutMs: 2000 }], { importModule: slow('p.slow') });
  await host.boot();
  assert.equal(host.getDiagnostics().plugins[0].state, 'active');
  await assert.rejects(loadPlugins(new CordiumHost(), [{ module: 'file:///virtual/x.mjs', lifecycleTimeoutMs: 'long' }], { importModule: slow('p.x') }),
    hasCode('invalid_argument', /lifecycleTimeoutMs/));
});

// ════════════════ 兜底定位：加载失败报出文件与行号 ════════════════
// ★ import() 的 SyntaxError 栈里只有 Node 内部帧（Node 20 / 24 实测）⇒ 加载器在子进程里让 Node 报一次位置

test('★ 插件语法错 ⇒ plugin_load_failed 报文带「文件:行」+ 源码行 + 指示符', async () => {
  const err = await loadPlugins(makeHost(), [{ module: at('syntax-error.mjs') }]).then(() => null, e => e);
  assert.equal(err?.code, 'plugin_load_failed');
  assert.match(err.message, /\n {2}at file:.*syntax-error\.mjs:3\n/, err.message);
  assert.match(err.message, /export const broken = ;\n\s+\^/);
  assert.equal(err.cause?.name, 'SyntaxError', '原错误仍在 cause');
});

test('★ 依赖里的语法错 ⇒ 报的是【依赖文件】的位置；导入不存在的导出名 ⇒ 报导入那一行', async () => {
  const dep = await loadPlugins(makeHost(), [{ module: at('imports-syntax-error.mjs') }]).then(() => null, e => e);
  assert.match(dep.message, /at file:.*syntax-error\.mjs:3/);
  const link = await loadPlugins(makeHost(), [{ module: at('bad-import-name.mjs') }]).then(() => null, e => e);
  assert.match(link.message, /at file:.*bad-import-name\.mjs:2\n.*doesNotExist/);
});

test('★ 定位探测只解析不执行：顶层执行期的 SyntaxError（JSON.parse）不追加位置，模块只被执行 1 次', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cordium-'));
  const log = path.join(dir, 'eval.log');
  process.env.CORDIUM_EVAL_LOG = log;
  try {
    const err = await loadPlugins(makeHost(), [{ module: at('runtime-syntax-error.mjs') }]).then(() => null, e => e);
    assert.equal(err?.code, 'plugin_load_failed');
    assert.equal(err.cause?.name, 'SyntaxError');
    assert.doesNotMatch(err.message, /\n {2}at /, '能解析的模块不编造位置（执行期错误的位置在 cause.stack 里）');
    assert.equal(fs.readFileSync(log, 'utf8'), 'evaluated\n', '子进程探测不得执行插件顶层代码');
  } finally {
    delete process.env.CORDIUM_EVAL_LOG;
    // ★ 清理失败只留痕（t.diagnostic），绝不掩盖断言失败。
    //   force: true 只忽略 ENOENT，不吞 EBUSY/EPERM ⇒ maxRetries 兜住 Windows 上子进程刚释放的句柄。
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      t.diagnostic(`临时目录清理失败：${dir} —— ${err.message}`);
    }
  }
});

test('自定义 importModule 的 SyntaxError 不去探测（它可能根本不读文件）', async () => {
  const err = await loadPlugins(makeHost(), [{ module: at('syntax-error.mjs') }], {
    importModule: () => { throw new SyntaxError('custom'); }
  }).then(() => null, e => e);
  assert.equal(err?.code, 'plugin_load_failed');
  assert.doesNotMatch(err.message, /\n {2}at /);
});
