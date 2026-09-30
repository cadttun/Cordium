import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost, LifecycleState } from '../src/index.mjs';

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
