import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost, LifecycleState } from '../src/index.mjs';
// ★ 诊断快照的字段契约以 MANIFEST_FIELD_TABLE.kernel 为**唯一真相源**（见下方门禁说明）。
//   ⚠️ 本包自己的测试走**相对路径**：`@cordium/kernel/internal` 只许 plugins/src 引用
//      （boundary.test.mjs 守这条边界 —— 它当场抓住了我最初写的包名形式）。
import { MANIFEST_FIELD_TABLE } from '../src/types.mjs';

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
  assert.rejects(
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
    'declareServiceContracts', 'dispatchAction', 'getDiagnostics', 'getInternalService', 'getService',
    'getUIContributions', 'log', 'recordManifestDiagnostic', 'registerPlugin', 'replacePlugin', 'unregisterPlugin'
  ]);
});

test('★ 公开面门禁：插件 ctx 成员清单（定稿；增删改名 = 破坏性变更）', async () => {
  const host = new CordiumHost();
  let ctx = null;
  host.registerPlugin({ id: 'plugin.ctx', version: '1.0.0', apiVersion: '1.0.0' }, { activate(c) { ctx = c; } });
  await host.boot();
  const expected = [
    'bail', 'dispatchAction', 'emit', 'getService', 'log', 'manifest', 'on', 'once', 'parallel',
    'pluginId', 'privateScope', 'provideService', 'registerAction', 'registerUIContribution',
    'scope', 'scoped', 'serial', 'watchService', 'waterfall'
  ];
  assert.deepEqual(Object.keys(ctx).sort(), expected);
  assert.deepEqual(Object.keys(ctx.scoped('s')).sort(), expected, 'scoped() 派生的 ctx 必须同形');
  assert.deepEqual(Object.keys(ctx.privateScope()).sort(), expected, 'privateScope() 派生的 ctx 必须同形');
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
      shape.on = kind(ctx.on('x', () => {}));
      shape.once = kind(ctx.once('y', () => {}));
      shape.emit = kind(ctx.emit('e'));
      shape.bail = kind(ctx.bail('e'));
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
  const RUNTIME_FIELDS = ['state', 'error', 'activationMs'];
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
