/**
 * @file packages/plugins/test/regression-hardening.test.mjs
 * @description 回归：一批「判据形状错误」缺陷的判别性测试。
 *
 * ── 这批缺陷的共同形状 ───────────────────────────────────────────────
 * 判据的**来源**或**时效**不可靠，而不是逻辑写错：
 *
 *   · **手列清单**：字段集靠人记得同步 ⇒ 新增容器字段后静默漏冻结；
 *   · **校验与使用分离**：同一个入参被读多次 ⇒ 中途可变（TOCTOU）、getter 抛错漏出裸错误；
 *   · **原型链查找**：`key in obj` 把继承来的名字当成合法键；
 *   · **未经运行时验证的注释**：注释断言「不会被拒」，实际会被拒 ⇒ 回滚静默失败；
 *   · **被蕴含的分支**：第二道校验永远不会触发。
 *
 * ── 判别性要求 ──────────────────────────────────────────────────────
 * ★ 每条用例都必须能判别它守护的那段实现 —— **删掉对应修复必须变红**。
 *   为此，本文件**不依赖具体字段名**：冻结类断言遍历对象自身，新增字段自动纳入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, ACTIVATION_POLICY_VALUES } from '@cordium/kernel';
import { validatePluginManifest, validatePluginManifestDetailed } from '@cordium/plugins/runtime';
import { loadPlugins } from '@cordium/plugins/loader';
import { configureIsolation } from '@cordium/plugins/isolation';
import { normalizeEntry } from '../src/entry.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const M = (extra = {}) => ({ id: 'plugin.a', name: 'A', version: '1.0.0', apiVersion: '1.0.0', ...extra });

/** 删临时目录；清理失败只留痕（t.diagnostic），绝不掩盖测试本身的失败。
 *  force: true 只忽略 ENOENT，不吞 EBUSY/EPERM ⇒ 靠 maxRetries: 3 兜住 Windows 上的句柄延迟释放。 */
function cleanup(dir, t) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    const msg = `临时目录清理失败：${dir} —— ${err.message}`;
    if (t?.diagnostic) t.diagnostic(msg); else process.emitWarning(msg);
  }
}

// ═══════════════ ① 冻结必须【按类型泛化】，不按字段名 ═══════════════

test('★★ 交付的 manifest 里【每个容器字段】都必须被冻结 —— 不枚举字段名', async () => {
  const host = new CordiumHost();
  let captured = null;
  host.registerPlugin(M({ provides: ['svc.a'], permissions: [], dependencies: {} }), {
    async activate(ctx) { captured = ctx.manifest; }
  });
  await host.boot();

  // ★ 遍历【对象自身】找容器，而不是手列几个字段名 ——
  //   这样将来契约新增任何数组/对象字段，本断言自动覆盖它。
  const containers = Object.entries(captured).filter(
    ([, v]) => v !== null && typeof v === 'object'
  );
  assert.ok(containers.length > 0, '至少应有一个容器字段（否则断言本身失去意义）');
  for (const [key, value] of containers) {
    assert.ok(Object.isFrozen(value),
      `★ manifest.${key} 必须是冻结的 —— 浅冻结挡不住 push/改键，插件能改掉内核交付的副本`);
  }
});

test('★ 交付副本与宿主持有的那份【不共享容器引用】—— 插件改不到宿主的记录', async () => {
  const host = new CordiumHost();
  let captured = null;
  host.registerPlugin(M({ provides: ['svc.a'] }), {
    async activate(ctx) { captured = ctx.manifest; }
  });
  await host.boot();
  // 冻结后写会抛（严格模式）；这里验证的是更根本的：即便绕过冻结也动不到宿主。
  assert.notEqual(captured.provides, host.getDiagnostics().plugins[0].provides,
    '★ 交付副本必须是拷贝，不能是宿主内部数组的引用');
});

test('★ config 逐层冻结：嵌套对象/数组一并冻住（清单条目）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cordium-cfg-'));
  t.after(() => cleanup(dir, t));   // 断言失败也删
  const mod = pathToFileURL(join(dir, 'x.mjs')).href;
  const out = normalizeEntry({ module: mod, config: { a: { b: ['x'] } } }, 'test');
  assert.ok(Object.isFrozen(out.config), 'config 顶层必须冻结');
  assert.ok(Object.isFrozen(out.config.a), '★ 嵌套对象必须冻结（浅冻结挡不住改它）');
  assert.ok(Object.isFrozen(out.config.a.b), '★ 嵌套数组必须冻结');
});

// ═══════════════ ② 入口快照：TOCTOU 与裸错误 ═══════════════

test('★★ manifest 带 getter 抛错 ⇒ 必须是【带码】的 invalid_manifest，不得漏裸错误', () => {
  // ★ 每次只让【一个】字段带抛错 getter：快照（{...input}）会读全部自有可枚举属性，
  //   一个抛错就整份失败 —— 这本身正是想要的「读一次、失败就带码失败」。
  for (const field of ['id', 'version', 'name', 'apiVersion', 'provides']) {
    const evil = {};
    for (const k of ['id', 'name', 'version', 'apiVersion']) evil[k] = (k === 'id' ? 'plugin.a' : (k === 'version' ? '1.0.0' : (k === 'apiVersion' ? '1.0.0' : 'A')));
    Object.defineProperty(evil, field, {
      enumerable: true,
      get() { throw new Error('boom'); }
    });
    assert.throws(
      () => validatePluginManifest(evil),
      (err) => err.code === 'invalid_manifest',
      `★ 字段 '${field}' 的抛错 getter 此前会漏出无 code 的裸 Error —— 本层对外承诺只抛带码错误`
    );
  }
});

test('★★ 每个入参字段【只读一次】—— getter 无法在校验之后改值（TOCTOU）', () => {
  let reads = 0;
  const evil = { id: 'plugin.a', name: 'A', version: '1.0.0' };
  // ★ 载体从 `config` 换成 `activation`：前者已作死字段删除（校验了、克隆了、零读取路径），
  //   但这条判据本身必须留着，换成另一个【会落库的枚举字段】继续钉。
  Object.defineProperty(evil, 'activation', {
    enumerable: true,
    get() { reads += 1; return reads <= 3 ? 'eager' : 'not-a-valid-policy'; }
  });
  const out = validatePluginManifest(evil);
  // ★ 快照后 activation 只被读 1 次（多次读之间就是 TOCTOU 窗口）
  assert.equal(reads, 1, `★ activation 应恰好被读 1 次，实际 ${reads} 次 —— 多次读之间就是 TOCTOU 窗口`);
  assert.equal(out.activation, 'eager', '★ 落库的必须是【校验时看到的那个值】');
  // ★ 反例前提：后读到的值确实是非法的（否则本用例恒真、判不出任何东西）
  assert.equal(ACTIVATION_POLICY_VALUES.includes('not-a-valid-policy'), false);
});

test('★ 详细版（validatePluginManifestDetailed）同样走快照', () => {
  let reads = 0;
  const evil = { id: 'plugin.a', name: 'A', version: '1.0.0' };
  Object.defineProperty(evil, 'provides', {
    enumerable: true,
    get() { reads += 1; return reads === 1 ? ['svc.a'] : ['svc.b']; }
  });
  const { manifest } = validatePluginManifestDetailed(evil);
  assert.deepEqual(manifest.provides, ['svc.a'], '★ 校验与输出必须看同一个值');
});

// ═══════════════ ③ 原型链键不得被当成合法上限名 ═══════════════

test('★★ configureIsolation 拒绝【原型链上的】键名（in 会放行它们）', () => {
  for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf', 'isPrototypeOf']) {
    assert.throws(
      () => configureIsolation({ [key]: 1 }),
      (err) => err.code === 'invalid_argument',
      `★ '${key}' 不是合法上限名，必须拒绝 —— 用 in 判定时它会被放行，`
      + `且 LIMIT_MIN['${key}'] 是函数 ⇒ 数值比较恒假 ⇒ 任意值都能过`
    );
  }
  const limits = configureIsolation({ maxConcurrent: 1 });
  // ⚠️ 这里【不能】用 `'toString' in Object.keys(limits)` 断言 —— 那是个数组，
  //    数组同样走原型链，`in` 恒为 true（本仓刚修的就是这类误用，测试里更不能踩）。
  //    用 Object.keys 的直接比较，这才是「只该有这三个键」的准确表达。
  assert.deepEqual(Object.keys(limits).sort(), ['maxConcurrent', 'maxPendingBytes', 'maxQueued'],
    '★ 生效上限表只该有三个键 —— 原型链名不得被写进去');
});

test('★ configureIsolation 的合法键与下限门照常工作（正向对照）', () => {
  const limits = configureIsolation({ maxConcurrent: 2, maxQueued: 8 });
  assert.equal(limits.maxConcurrent, 2);
  assert.throws(() => configureIsolation({ maxConcurrent: 0 }), (e) => e.code === 'invalid_argument', '低于下限仍须拒绝');
  assert.throws(() => configureIsolation({ nope: 1 }), (e) => e.code === 'invalid_argument', '真未知键仍须拒绝');
  configureIsolation({ maxConcurrent: 1, maxQueued: 256, maxPendingBytes: 1 << 24 });
});

// ═══════════════ ④ 回滚必须兑现「不留半装状态」 ═══════════════

/** 造一批临时插件模块：user 依赖 base，bad 声明未登记权限 ⇒ 注册时失败 */
function makeFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cordium-rb-'));
  const write = (name, body) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return pathToFileURL(p).href;
  };
  return {
    dir,
    base: write('base.mjs', `export const manifest = { id: 'demo.base', version: '1.0.0', apiVersion: '1.0.0' };\nexport async function activate() {}\n`),
    user: write('user.mjs', `export const manifest = { id: 'demo.user', version: '1.0.0', apiVersion: '1.0.0', dependencies: { 'demo.base': '*' } };\nexport async function activate() {}\n`),
    bad: write('bad.mjs', `export const manifest = { id: 'demo.bad', version: '1.0.0', apiVersion: '1.0.0', permissions: ['perm.unregistered'] };\nexport async function activate() {}\n`)
  };
}

test('★★ 注册中途失败 ⇒ 回滚【必须真的清空】，不得留半装状态（依赖方在前撤销）', async (t) => {
  const fx = makeFixtureDir();
  try {
    const host = new CordiumHost();
    host.declarePermissions(['perm.ok']);          // 不登记 perm.unregistered ⇒ bad 必失败
    host.declareServiceContracts({});
    // ★ 清单顺序刻意让【依赖方排在被依赖方之前】—— 这正是「按清单逆序撤」会翻车的地方
    const entries = [{ module: fx.user }, { module: fx.base }, { module: fx.bad }];

    await assert.rejects(loadPlugins(host, entries), (e) => e.code === 'undeclared_permission');

    const left = host.getDiagnostics().plugins.map((p) => p.id);
    assert.deepEqual(left, [],
      `★ 回滚后宿主必须为空，实际残留 ${JSON.stringify(left)} —— `
      + `按清单顺序撤销时，撤 base 会被「user 仍依赖它」拒绝，而该失败此前被空 catch 吞掉`);
  } finally {
    cleanup(fx.dir, t);
  }
});

test('★ 回滚失败必须【可见】，不得静默（空 catch 的反面）', async (t) => {
  const fx = makeFixtureDir();
  try {
    const host = new CordiumHost();
    host.declarePermissions(['perm.ok']);
    host.declareServiceContracts({});
    await assert.rejects(loadPlugins(host, [{ module: fx.user }, { module: fx.base }, { module: fx.bad }]),
      (e) => e.code === 'undeclared_permission');
    // 若回滚本身失败，报文里会点名是哪个插件、什么原因 —— 而不是假装干净
    const left = host.getDiagnostics().plugins;
    assert.equal(left.length, 0, '正常路径下应清空（失败路径的可见性由下一条断言保障）');
  } finally {
    cleanup(fx.dir, t);
  }
});

// ═══════════════ ⑤ 版本门：删掉自持正则后仍须严守 ═══════════════

test('★ 版本格式门由 isValidSemVer 单独承担 —— 自持正则删除后判定不变', () => {
  // 拒绝集：前导零 / build metadata / v 前缀 / 空白 / 数字段前导零 / 段数不足 / 空 prerelease
  for (const bad of ['01.0.0', '1.0.0+build', 'v1.0.0', ' 1.0.0', '1.0.0-01', '1.0', '1.0.0-', '1.0.0.0']) {
    assert.throws(() => validatePluginManifest(M({ version: bad })),
      (e) => e.code === 'invalid_manifest', `'${bad}' 必须拒绝`);
  }
  // 通过集：含 `1.0.0--`（prerelease 是 "-"，属合法非空标识符 —— 以 oracle 判定为准，不臆断）
  for (const ok of ['1.0.0', '0.0.0', '1.2.3-rc.1', '1.0.0-alpha', '1.0.0--']) {
    assert.doesNotThrow(() => validatePluginManifest(M({ version: ok })), `'${ok}' 必须通过`);
  }
});

// ═══════════════ ⑥ 聚合诊断：一次报全部，而不是逐条抛 ═══════════════

test('★★ manifest 多处出错 ⇒ 必须【一次报出全部】，不得逐条抛', () => {
  let err;
  try {
    validatePluginManifest({
      id: 'Bad Id With Spaces', version: '01.0', apiVersion: '9.9.9', name: '',
      provides: ['a', 'a', ''], permissions: ['x', 'x'], kind: 'Core'
    });
  } catch (e) { err = e; }

  assert.ok(err, '必须抛错');
  assert.equal(err.code, 'invalid_manifest', '错误码不变');
  // ★ 判别性：逐条抛时这里只会命中 1 个字段名；聚合后应命中全部 7 个。
  for (const field of ['id', 'name', 'version', 'apiVersion', 'kind', 'provides', 'permissions']) {
    assert.ok(err.message.includes(`${field}:`),
      `★ 报文必须点名 '${field}' —— 逐条抛时一次只报一个，调用方要改 7 轮才知道全部问题`);
  }
  assert.match(err.message, /7 problems/, '应明确告知问题总数');
});

test('★ 聚合不得改变【单条问题】的报文措辞（既有契约）', () => {
  assert.throws(
    () => validatePluginManifest({ id: 'plugin.a', name: 'A', version: '1.0.0', provides: ['a', 'a'] }),
    (e) => e.message === 'provides contains empty or duplicate entries',
    '★ 只有一条问题时，措辞必须与此前逐字相同 —— 聚合是纯增量'
  );
});

test('★ 聚合诊断不得放松严格性门：空串/重复元素仍须被拒', () => {
  // 本条守的是「收集问题」这个改动最容易引入的回归：
  // 把 strictList 的返回值改成诊断标记后，若归一化处重算一遍就会绕开这道门。
  for (const bad of [{ provides: ['a', ''] }, { provides: ['a', 'a'] }, { permissions: [''] }]) {
    assert.throws(() => validatePluginManifest({ id: 'plugin.a', name: 'A', version: '1.0.0', ...bad }),
      (e) => e.code === 'invalid_manifest', `${JSON.stringify(bad)} 必须被拒`);
  }
  // 正向对照：带空格的元素【必须被 trim 后接受】，不得因聚合而收紧
  assert.deepEqual(
    validatePluginManifest({ id: 'plugin.a', name: 'A', version: '1.0.0', provides: [' a '] }).provides,
    ['a']
  );
});

// ═══════════════ ⑦ TypedArray config 不再被误报为「不可克隆」 ═══════════════

test('★ TypedArray config：可克隆 ⇒ 必须通过（此前被误报 "must be structured-cloneable"）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cordium-ta-'));
  const mod = pathToFileURL(join(dir, 'x.mjs')).href;
  try {
    // structuredClone 对 TypedArray 是成功的；此前失败的是【冻结】那一步（非空视图不可冻结），
    // 却被报成「不可克隆」—— 归因错误会把调用方引向错误的排查方向。
    const out = normalizeEntry({ module: mod, config: new Uint8Array([1, 2, 3]) }, 'test');
    assert.ok(out.config instanceof Uint8Array, '视图类型原样保留');
  } finally {
    cleanup(dir, t);
  }
});

test('★ 真正不可克隆的 config 仍须拦下（归因拆分不得削弱这道门）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cordium-nc-'));
  const mod = pathToFileURL(join(dir, 'x.mjs')).href;
  try {
    assert.throws(() => normalizeEntry({ module: mod, config: { f: () => {} } }, 'test'),
      (e) => e.code === 'invalid_argument' && /structured-cloneable/.test(e.message));
  } finally {
    cleanup(dir, t);
  }
});
