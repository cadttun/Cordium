import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost, LifecycleState } from '../src/index.mjs';
// ★ 诊断快照的字段契约以 MANIFEST_FIELD_TABLE.kernel 为**唯一真相源**（见下方门禁说明）。
//   ⚠️ 本包自己的测试走**相对路径**：`@cordium/kernel/internal` 只许 plugins/src 引用
//      （boundary.test.mjs 守这条边界 —— 它当场抓住了我最初写的包名形式）。
import { MANIFEST_FIELD_TABLE, DIAGNOSTICS_CONTRACT } from '../src/types.mjs';

/**
 * 测试专用：登记本文件用到的临时服务契约。
 *
 * 生产环境的契约表由上层应用的装配层在 boot 前装载。这里的小内核测试没有装配层，
 * 所以由测试自己扮演「宿主装配代码」显式登记 —— 未登记的服务会被 registerService 拒绝。
 * 这些都是测试自造的纯内存服务，无世界状态读写，故取 public。
 */
function declareTestServices(host, ...names) {
  host.declareServiceContracts(
    Object.fromEntries(names.map(name => [name, { access: 'public' }]))
  );
}

test('Kernel Diagnostic: Empty kernel boots cleanly without any business plugins', async () => {
  const host = new CordiumHost({ hostVersion: '1.0.0' });

  // 验证未 boot 前诊断
  let diag = host.getDiagnostics();
  assert.equal(diag.booted, false);
  assert.equal(diag.totalPlugins, 0);

  // 启动空内核
  await host.boot();

  diag = host.getDiagnostics();
  assert.equal(diag.booted, true);
  assert.equal(diag.totalPlugins, 0);
  assert.equal(diag.services.length, 0);
  assert.equal(diag.uiContributionsCount, 0);
  assert.ok(diag.recentLogs.some(l => l.message.includes('booted successfully')));
});

test('Kernel Service & Dependency: Topological ordering and singleton service switching', async () => {
  const host = new CordiumHost();
  declareTestServices(host, 'service.logger', 'service.kv');

  // 注册基础日志服务插件 A
  host.registerPlugin({
    id: 'plugin.infra.logger',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.logger']
  }, {
    activate(ctx) {
      ctx.provideService('service.logger', { log: (msg) => `[DefaultLog] ${msg}` });
    }
  });

  // 注册依赖 A 的存储服务插件 B
  host.registerPlugin({
    id: 'plugin.infra.kv',
    version: '1.0.0',
    apiVersion: '1.0.0',
    dependencies: { 'plugin.infra.logger': '^1.0.0' },
    provides: ['service.kv']
  }, {
    activate(ctx) {
      const logger = ctx.getService('service.logger');
      ctx.provideService('service.kv', {
        save: (key, val) => logger.log(`Saved ${key}=${val}`)
      });
    }
  });

  await host.boot();

  const kv = host.getInternalService('service.kv');
  assert.equal(kv.save('foo', 'bar'), '[DefaultLog] Saved foo=bar');

  // ★ 新语义：一个服务名只允许一个提供者 —— 第二个提供者必须被【拒绝】，
  //   而不是静默覆盖、也不是靠 selectActiveProvider 手动选主。
  //   为什么不能选主：它是全局可变单点，一旦被切换，所有持有该服务句柄的消费者
  //   一起失效 —— 包括正在跑长任务的其它 agent。
  host.registerPlugin({
    id: 'plugin.infra.logger-advanced',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.logger']
  }, {
    activate(ctx) {
      ctx.provideService('service.logger', { log: (msg) => `[AdvancedLog] ${msg}` });
    }
  });

  await assert.rejects(
    () => host.activatePlugin('plugin.infra.logger-advanced'),
    hasCode('provider_conflict', /is already provided by plugin 'plugin\.infra\.logger'/),
    '★ 第二个提供者必须被拒绝（一个名字一个提供者），不得静默覆盖或靠选主解决'
  );

  // 既有提供者不受影响
  assert.equal(
    host.getInternalService('service.logger').log('test'),
    '[DefaultLog] test',
    '被拒绝的注册不得污染既有提供者'
  );
});

test('Kernel Scope & Cleanup: Deactivating a plugin revokes services, actions, timers and UI contributions without residual', async () => {
  const host = new CordiumHost();
  declareTestServices(host, 'service.sample');
  host.declarePermissions(['perm.sample']);   // ★ 权限名须由宿主登记

  let timerFired = false;
  host.registerPlugin({
    id: 'plugin.sample.feature',
    version: '1.0.0',
    apiVersion: '1.0.0',
    permissions: ['perm.sample'],
    provides: ['service.sample']
  }, {
    activate(ctx) {
      ctx.provideService('service.sample', { ping: () => 'pong' });
      ctx.registerAction('sample.action', {
        requiredPermission: 'perm.sample',
        handler: (payload) => `handled: ${payload}`
      });
      ctx.registerUIContribution('panel-sample', { type: 'panel', title: 'Sample Panel' });

      // 托管定时器
      const timer = setTimeout(() => { timerFired = true; }, 10000);
      ctx.scope.trackTimer(timer);
    }
  });

  await host.boot();

  // 验证能力存在
  assert.ok(host.getInternalService('service.sample'));
  assert.equal(host.getUIContributions().length, 1);

  // 停用插件
  await host.deactivatePlugin('plugin.sample.feature');

  // 验证已彻底清理
  assert.throws(() => host.getInternalService('service.sample'), hasCode('no_provider'));
  assert.equal(host.getUIContributions().length, 0);

  // 验证动作已注销
  // ★ 必须 await：裸调用时断言失败不会被归到本测试头上 —— 实测（Node 24）默认 runner 下
  //   本测试行仍显示 ✔、失败挂到【文件】（退出码 1），并伴随「测试结束后仍有异步活动」诊断；
  //   若运行器带 --test-force-exit 则连诊断都没有、**完全静默（退出码 0）**。
  //   全仓 123 处 assert.rejects，122 处已 await，此处是唯一的漏网 —— 保持这一条基线。
  await assert.rejects(
    async () => host.dispatchAction('plugin.sample.feature', 'sample.action', 'test'),
    hasCode('access_denied')
  );
  assert.equal(timerFired, false);
});

test('Kernel Security: Unauthorized callers cannot invoke protected actions', async () => {
  const host = new CordiumHost();
  host.declarePermissions(['perm.super_write', 'perm.read_only']);   // ★ 权限名须由宿主登记

  // 核心服务注册受保护动作
  host.registerPlugin({
    id: 'plugin.core.gate',
    version: '1.0.0',
    apiVersion: '1.0.0'
  }, {
    activate(ctx) {
      ctx.registerAction('protected.write', {
        requiredPermission: 'perm.super_write',
        handler: () => 'success'
      });
    }
  });

  // 普通未授权插件
  host.registerPlugin({
    id: 'plugin.unauthorized.caller',
    version: '1.0.0',
    apiVersion: '1.0.0',
    permissions: ['perm.read_only'] // 未申请 perm.super_write
  });

  await host.boot();

  // 调用受限动作必须被宿主硬核拒绝
  await assert.rejects(
    async () => host.dispatchAction('plugin.unauthorized.caller', 'protected.write', {}),
    hasCode('access_denied', /Security Violation: Plugin 'plugin.unauthorized.caller' lacks required permission 'perm.super_write'/)
  );
});

test('Kernel Resilience: Circular dependencies are detected and rejected cleanly', async () => {
  const host = new CordiumHost();

  host.registerPlugin({
    id: 'plugin.a',
    version: '1.0.0',
    apiVersion: '1.0.0',
    dependencies: { 'plugin.b': '^1.0.0' }
  });

  host.registerPlugin({
    id: 'plugin.b',
    version: '1.0.0',
    apiVersion: '1.0.0',
    dependencies: { 'plugin.a': '^1.0.0' }
  });

  await assert.rejects(
    async () => host.boot(),
    hasCode('cyclic_dependency')
  );
});

// 回归：boot 中途失败必须回滚已激活插件，并允许修复后重新 boot
test('boot rolls back already-activated plugins when a later plugin fails', async () => {
  const host = new CordiumHost({ hostVersion: '1.0.0' });
  declareTestServices(host, 'service.first');
  let firstDeactivated = false;
  host.registerPlugin(
    { id: 'plugin.first', version: '1.0.0', apiVersion: '1.0.0', dependencies: {}, provides: ['service.first'] },
    {
      async activate(ctx) { ctx.provideService('service.first', { ok: true }); },
      async deactivate() { firstDeactivated = true; }
    }
  );
  host.registerPlugin(
    { id: 'plugin.explodes', version: '1.0.0', apiVersion: '1.0.0', dependencies: { 'plugin.first': '^1.0.0' } },
    { async activate() { throw new Error('activation boom'); } }
  );

  // 保留报文断言：插件自抛的错误须原样透传（非 CordiumError、无 code），报文即被测对象
  await assert.rejects(() => host.boot(), /activation boom/);  // 保留报文断言：插件自抛的错误须原样透传，报文即被测对象

  assert.equal(firstDeactivated, true, '先前激活的插件必须被回滚停用');
  assert.equal(host.booted, false, 'boot 失败后不得标记为已启动');
  const first = host.getDiagnostics().plugins.find(plugin => plugin.id === 'plugin.first');
  assert.equal(first.state, LifecycleState.DISABLED, '回滚后应回到 DISABLED');
});

// 回归：不同插件注册同名 action 必须显式冲突，且停用一方不得误删另一方的 handler
test('action registration rejects cross-plugin conflicts and preserves ownership', async () => {
  const host = new CordiumHost({ hostVersion: '1.0.0' });
  host.registerPlugin(
    { id: 'plugin.alpha', version: '1.0.0', apiVersion: '1.0.0', dependencies: {} },
    { async activate(ctx) { ctx.registerAction('shared.action', { handler: async () => 'alpha' }); } }
  );
  host.registerPlugin(
    { id: 'plugin.beta', version: '1.0.0', apiVersion: '1.0.0', dependencies: {} },
    { async activate(ctx) { ctx.registerAction('shared.action', { handler: async () => 'beta' }); } }
  );

  await host.activatePlugin('plugin.alpha');
  // 同名动作被他人占用时必须拒绝，而不是静默覆盖
  await assert.rejects(() => host.activatePlugin('plugin.beta'), hasCode('duplicate_action', /already registered by plugin 'plugin.alpha'/));

  // 停用 alpha 后 action 应被清理，beta 才能顺利注册
  await host.deactivatePlugin('plugin.alpha');
  await host.activatePlugin('plugin.beta');
  assert.equal(await host.dispatchAction('plugin.beta', 'shared.action'), 'beta');
});

test('★ 公开面门禁：实例字段与原型方法必须与清单一致（防游离字段 / 测试后门混入）', () => {
  // 缺陷背景：私有化补丁打歪，类体里多出一个游离的 `n` ⇒ 被解析成公开类字段，
  //   `node --check` 与 192 条测试全绿都发现不了。公开面必须被显式钉住：
  //   新增/删除公开成员是【有意的 API 变更】，应当同时改这份清单。
  const host = new CordiumHost();
  // ★ 实例上【零】公开字段 —— 日志、诊断、通道全部私有；配置 / 状态走原型上的只读 getter。
  assert.deepEqual(Object.keys(host), []);
  const getters = Object.entries(Object.getOwnPropertyDescriptors(CordiumHost.prototype))
    .filter(([, d]) => d.get).map(([k, d]) => [k, typeof d.set]);
  assert.deepEqual(getters.sort(), [
    ['booted', 'undefined'], ['defaultActionTimeoutMs', 'undefined'], ['hostVersion', 'undefined'], ['lifecycleTimeoutMs', 'undefined'],
    ['maxErrorLogSize', 'undefined'], ['maxInFlightActions', 'undefined'], ['maxLogSize', 'undefined'], ['maxManifestDiagnostics', 'undefined']
  ], '只读 getter：不得带 setter');
  const methods = Object.entries(Object.getOwnPropertyDescriptors(CordiumHost.prototype))
    .filter(([k, d]) => k !== 'constructor' && typeof d.value === 'function').map(([k]) => k);
  assert.equal(methods.filter(k => k.startsWith('__')).length, 0, '不得出现 __test_* 之类的测试专用方法');
  assert.deepEqual(methods.sort(), [
    'activatePlugin', 'boot', 'deactivatePlugin', 'declarePermissions', 'declareServiceContract',
    'declareServiceContracts', 'declareUIContributionTypes', 'dispatchAction', 'getDiagnostics',
    'getInternalService', 'getService', 'getUIContributions',
    'log', 'recordManifestDiagnostic', 'registerPlugin', 'replacePlugin', 'unregisterPlugin'
  ]);
});

test('★ 公开面门禁：插件 ctx 成员清单（定稿；增删改名 = 破坏性变更）', async () => {
  const host = new CordiumHost();
  let ctx = null;
  host.registerPlugin({ id: 'plugin.ctx', version: '1.0.0', apiVersion: '1.0.0' }, { activate(c) { ctx = c; } });
  await host.boot();
  const expected = [
    'dispatchAction', 'emit', 'getService', 'log', 'manifest', 'on', 'once', 'parallel',
    'pluginId', 'privateScope', 'provideService', 'registerAction', 'registerUIContribution',
    'scope', 'scoped', 'serial', 'watchPluginState', 'watchService', 'waterfall'
  ];
  assert.deepEqual(Object.keys(ctx).sort(), expected);
  assert.deepEqual(Object.keys(ctx.scoped('s')).sort(), expected, 'scoped() 派生的 ctx 必须同形');
  assert.deepEqual(Object.keys(ctx.privateScope()).sort(), expected, 'privateScope() 派生的 ctx 必须同形');
});

// ════════════ PLUGIN_GUIDE §3 的 ctx 成员表 vs 运行时 ════════════

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NL = String.fromCharCode(10);   // ★ 本文件里的字符串一律不写转义（见下方说明）

/** 取 `PLUGIN_GUIDE.md` 里 §3 那一段（到 §4 标题为止）。找不到边界 ⇒ 返回 null。 */
function guideCtxSection(guide) {
  const from = guide.indexOf('## 3. ctx');
  if (from < 0) return null;
  const to = guide.indexOf('## 4. ', from);
  return to < 0 ? null : guide.slice(from, to);
}

/**
 * 从 §3 里抽成员名 —— 取每张表格行首的反引号标识符（三档的表都是同一形状）。
 * @returns {string[]} 按出现顺序；解析不出任何一行 ⇒ `[]`
 */
function ctxMembersInSection(section) {
  const out = [];
  for (const line of section.split(NL)) {
    if (!line.startsWith('| `')) continue;
    const end = line.indexOf('`', 3);
    if (end < 0) continue;
    // ★ 成员列写的是**签名**（`provideService(name, impl)`）⇒ 只取首个 `(` 之前的名字。
    //   漏了这一步会静默只抽到不带参数的那几个（本文件的自检正是这么把它抓出来的）。
    const name = line.slice(3, end).split('(')[0].trim();
    if (/^[A-Za-z]+$/.test(name)) out.push(name);
  }
  return out;
}

/**
 * ★★ §3 的成员表必须与运行时 `ctx` **同集**，判据取自**运行时**而不是另一份手抄清单。
 *
 * 为什么需要它：§3 是插件作者读的第一张表，而它此前**零门禁** ——
 *   往 `host.mjs` 加一个 ctx 成员，上面那条成员清单门禁会红；但**文档表**少一行 / 多一行
 *   可以静默存在，读者照着写就得到「不是函数」。
 * ★ 判据来源是 `Object.keys(ctx)`（唯一真相源），文档是**被测对象** ——
 *   若拿另一份手写清单来比，就是循环论证（判据取自被检查对象自身）。
 * ★ 「解析不出」与「检查通过」分开报（同 boundary.test.mjs 的版本声明门先例）。
 */
test('★★ PLUGIN_GUIDE §3 的 ctx 成员表与运行时 ctx 同集，且三档不重不漏', async () => {
  const host = new CordiumHost();
  let ctx = null;
  host.registerPlugin({ id: 'plugin.doc', version: '1.0.0', apiVersion: '1.0.0' }, { activate(c) { ctx = c; } });
  await host.boot();

  // 行尾归一放在读入那一刻：抽取以行首为锚，CRLF 会让它整条失效
  const guide = fs.readFileSync(path.join(ROOT, 'PLUGIN_GUIDE.md'), 'utf8').split('\r\n').join(NL);
  const section = guideCtxSection(guide);
  assert.ok(section !== null, '★ 判据失效：PLUGIN_GUIDE 里找不到 §3 与 §4 的边界（标题改了？）—— 这不是「检查通过」');

  const doc = ctxMembersInSection(section);
  assert.ok(doc.length > 0, '★ 判据失效：§3 里一个成员都没解析出来（表换了形状？）—— 这不是「检查通过」');
  assert.equal(new Set(doc).size, doc.length, '§3 的三档之间不得重复列出同一成员');

  assert.deepEqual([...doc].sort(), Object.keys(ctx).sort(),
    '§3 的成员表与运行时 ctx 不一致 —— 这张表是插件作者读的第一张表，必须与实现同集');
});

test('★ 门禁自检：§3 的解析与比对真的能判别（否则是恒真假绿）', async () => {
  const host = new CordiumHost();
  let ctx = null;
  host.registerPlugin({ id: 'plugin.doc', version: '1.0.0', apiVersion: '1.0.0' }, { activate(c) { ctx = c; } });
  await host.boot();
  const runtime = Object.keys(ctx).sort();

  // 正向：解析器必须真的从真实文档里抽到全部成员（否则下面两条负向断言可能只是恒真）
  const guide = fs.readFileSync(path.join(ROOT, 'PLUGIN_GUIDE.md'), 'utf8').split('\r\n').join(NL);
  assert.equal(ctxMembersInSection(guideCtxSection(guide)).length, runtime.length,
    '解析器必须真的抽到全部成员');

  // 负向①：少一行的表必须与运行时不同集（模拟「加了 ctx 成员却忘了写进文档」）
  const oneRow = ['| 成员 | 返回 | 用途 |', '|---|---|---|', '| `pluginId` | string | x |'].join(NL) + NL;
  assert.notDeepEqual(ctxMembersInSection(oneRow).sort(), runtime, '少列成员必须被判出');

  // 负向②：多一行的表必须把多出来的名字解析出来（模拟「删了成员却没删文档」）
  //   ⚠️ 名字要写成解析器认得的形状（纯字母）：写 `__ghost__` 会被 `[A-Za-z]+` 滤掉，
  //      于是这条断言测的就成了「解析器漏了什么」而不是「多列能不能被看见」。
  const extra = oneRow + '| `ghostMember(name)` | x | x |' + NL;
  assert.ok(ctxMembersInSection(extra).includes('ghostMember'), '多列的成员必须被解析出来（否则漏报）');
  assert.notDeepEqual(ctxMembersInSection(extra).sort(), runtime, '多列的成员必须让「同集」比对失败');

  // ★ 判据失效与检查通过分开：找不到小节边界必须返回 null，不能拿空段当「通过」
  assert.equal(guideCtxSection('## 3. ctx' + NL + '没有第四章' + NL), null, '找不到 §4 必须报判据失效');
  assert.equal(guideCtxSection('没有第三章' + NL), null, '找不到 §3 必须报判据失效');
});

test('★ 同一插件 id 不得重复注册（此前无任何测试守护：删掉查重仍全绿）', () => {
  const host = new CordiumHost();
  host.registerPlugin({ id: 'plugin.dup', version: '1.0.0', apiVersion: '1.0.0' }, {});
  assert.throws(
    () => host.registerPlugin({ id: 'plugin.dup', version: '2.0.0', apiVersion: '1.0.0' }, {}),
    hasCode('duplicate_plugin')
  );
});

test('★ 公开面门禁：ctx 各方法的同步 / 异步形状钉死（调用面同步性）', async () => {
  // 形状上看不出哪些返回 Promise ⇒ 漏 await 静默不报错。这里钉死现状，改任何一个 = 有意的破坏性变更，
  // 须同步 PLUGIN_GUIDE.md §3 的说明。★ 边界声明：同步的那些【不承诺永久同步】（将来做隔离须异步化）。
  const host = new CordiumHost();
  host.declareServiceContracts({ 'service.s': { access: 'public' } });
  const shape = {};
  const kind = v => (v && typeof v.then === 'function') ? 'async' : 'sync';
  host.registerPlugin({ id: 'plugin.ctx', version: '1.0.0', apiVersion: '1.0.0', provides: ['service.s'] }, {
    async activate(ctx) {
      ctx.on('e', () => 1);
      ctx.registerAction('a.b', { handler: () => 1 });
      shape.provideService = kind(ctx.provideService('service.s', { f() {} }));
      shape.getService = kind(ctx.getService('service.s'));
      shape.watchService = kind(ctx.watchService('service.s', () => {}));
      shape.watchPluginState = kind(ctx.watchPluginState(() => {}));
      shape.on = kind(ctx.on('x', () => {}));
      shape.once = kind(ctx.once('y', () => {}));
      shape.emit = kind(ctx.emit('e'));
      shape.waterfall = kind(ctx.waterfall('e', () => 0));
      const p = ctx.parallel('e'); shape.parallel = kind(p); await p;
      const s = ctx.serial('e'); shape.serial = kind(s); await s;
      shape.scoped = kind(ctx.scoped('t'));
      shape.privateScope = kind(ctx.privateScope());
      shape.log = kind(ctx.log('info', 'x'));
      shape.registerUIContribution = kind(ctx.registerUIContribution({ id: 'u', slot: 's' }));
      const d = ctx.dispatchAction('a.b', {}); shape.dispatchAction = kind(d); await d.catch(() => {});
      Object.defineProperty(shape, '__fnMembers', { value: Object.keys(ctx).filter(k => typeof ctx[k] === 'function').sort() });
    }
  });
  await host.boot();
  const async = Object.keys(shape).filter(k => shape[k] === 'async').sort();
  assert.deepEqual(async, ['dispatchAction', 'parallel', 'serial'], JSON.stringify(shape));
  assert.deepEqual([...Object.keys(shape), 'registerAction'].sort(), shape.__fnMembers,
    '每个函数型 ctx 成员都要测到（registerAction 在前置里已调用，恒同步返回注销函数）');
});

// ★ 诊断快照必须带出 `kind` —— 装配层据此决定「能否被用户停用」。
//
// 为什么需要这条门禁：这是本项目记录过的「白名单重建漏字段」同形第 4 次 ——
//   `kind` 加进了 manifest 与 MANIFEST_FIELD_TABLE，但 getDiagnostics() 的快照忘了带；
//   上层装配代码拿不到它，只能改读私有字段（拿不到）或按 id 前缀猜（实测误伤）。
//   门禁形状：**拿 MANIFEST_FIELD_TABLE.kernel 当清单**逐项比对快照 ——
//   将来往 manifest 加字段时，这条会自动提醒「快照也要跟着加」。
// ★★ 诊断快照的字段契约 —— **由 MANIFEST_FIELD_TABLE.kernel 派生**，不手列。
//
// ── 为什么必须派生（这是本门禁的设计要点）────────────────────────────
// 这个 bug 的形状是「**手工维护的子集漏了新字段**」：`kind` 加进了 manifest 与
// MANIFEST_FIELD_TABLE，而 getDiagnostics() 的投影没跟着加。
//
// ⚠️ 如果这里【手列】一份期望清单（`['kind', 'displayName', …]`），门禁本身
//    就成了同一个 bug 的载体 —— 下次往 manifest 加字段时，**新字段同时被
//    实现和门禁忽略**（门禁只检查它自己列的那几个），于是照常全绿。
//    这就是「循环论证」：判据既然取自被检查对象自身，检查通过只证明了两者自洽。
//
// ⇒ 判据必须来自**唯一真相源** `MANIFEST_FIELD_TABLE.kernel`：
//   往 manifest 加字段 ⇒ 表变 ⇒ 本条自动要求快照跟上，**不需要人记得改门禁**。
//
//    反例就是「循环论证」：判据取自被检查对象自身，检查通过只证明了两者自洽。
//
// 「照单全带出」而不是「只带装配层要的」：装配层需要哪些字段会随上层演进，
// 内核无从预判（本仓的教训：判据一旦取自「当前调用方要什么」，调用方一变就失效）。
// 全带出 + 逐层深拷贝，既满足投影完整性，也不泄露可变引用。
test('★★ 诊断快照的字段必须【由 manifest 契约派生】—— 白名单重建不得漏字段', async () => {
  const host = new CordiumHost({ hostVersion: '1.0.0' });
  host.registerPlugin({
    id: 'plugin.kinded', version: '1.0.0', apiVersion: '1.0.0',
    displayName: '带类型的插件', description: '说明文字',
    provides: [], permissions: [], dependencies: {}, kind: 'core'
  });
  await host.boot();

  const entry = host.getDiagnostics().plugins.find(p => p.id === 'plugin.kinded');
  assert.ok(entry, '插件必须出现在诊断快照里');

  // ① 契约里的每个字段都必须出现在快照里（**清单来自真相源，不手写**）
  const missing = MANIFEST_FIELD_TABLE.kernel.filter((f) => !(f in entry));
  assert.deepEqual(
    missing,
    [],
    `诊断快照漏了 manifest 契约里的字段：${missing.join(', ')}\n`
    + `  ⇒ 往 MANIFEST_FIELD_TABLE.kernel 加字段时，getDiagnostics() 的投影必须同步带上。\n`
    + `     这是本项目「白名单重建漏字段」的同形（前三次：optionalDependencies / `
    + `optionalProvider / 契约未知键）。`
  );

  // ② 快照的**非 manifest 字段**必须白名单化，不得凭空多出。
  //
  //    快照由两部分组成，判据不同：
  //      · manifest 字段 —— 由 ① 保证「恰好等于契约表」；
  //      · 运行时状态字段 —— 不是 manifest 的一部分（内核自己的观察结果：生命周期、
  //        错误、耗时），**必须显式登记**，否则「顺手多带一个内部字段到公开面」
  //        不会有任何提示。
  //    ⇒ 这条是 ① 的**反向对照**：① 防漏，② 防多。
  //      只写「不漏」是单向断言 —— 实现把整个内部 record 透传出去也照样能过。
  //  ★★ 运行时字段清单**从契约表派生**，不手抄。
  //    此前这里是 `['state', 'error', 'activationMs']` —— 与
  //    `DIAGNOSTICS_CONTRACT.stable['plugins[]']` 的尾巴是**同一份知识写了两遍**。
  //    两份清单的漂移是**双向**的：漏了 ⇒ 新字段被当成"凭空多出"而误红；
  //    多了 ⇒ 某个已删字段仍被"登记在册"而放行。⇒ 取真相源，去掉这一份。
  const RUNTIME_FIELDS = DIAGNOSTICS_CONTRACT.stable['plugins[]']
    .filter((k) => !MANIFEST_FIELD_TABLE.kernel.includes(k));
  const extra = Object.keys(entry).filter(
    (k) => !MANIFEST_FIELD_TABLE.kernel.includes(k) && !RUNTIME_FIELDS.includes(k)
  );
  assert.deepEqual(
    extra,
    [],
    `诊断快照出现了未登记的字段：${extra.join(', ')}\n`
    + `  ⇒ 要么是忘了登记进 MANIFEST_FIELD_TABLE.kernel（若是 manifest 字段），\n`
    + `     要么是新增运行时状态却没加进本测试的 RUNTIME_FIELDS（若是内核观察结果）。`
  );

  // ③ kind 的语义（装配层靠它区分 core / business）
  assert.equal(entry.kind, 'core');
  host.registerPlugin({ id: 'plugin.nokind', version: '1.0.0', apiVersion: '1.0.0' });
  const entry2 = host.getDiagnostics().plugins.find(p => p.id === 'plugin.nokind');
  assert.equal(entry2.kind, 'business', '未声明 kind 的插件必须报 business，不是 undefined');

  // ④ 快照如实反映 manifest 的**已归一化**形态（不是原始输入）：
  //    `displayName` 缺省回落 id、`description` 缺省为 ''（types.mjs 的既有默认）。
  //    把两条默认值都钉住 —— 否则将来有人改默认，快照与展示层会一起静默变样。
  assert.equal(entry.displayName, '带类型的插件');
  assert.equal(entry.description, '说明文字');
  assert.equal(entry2.displayName, 'plugin.nokind', '未写 displayName 时按既有默认回落到 id');
  assert.equal(entry2.description, '', '未写 description 时按既有默认为空串');
});
