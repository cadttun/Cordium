/**
 * @file packages/kernel/test/service-lifecycle.test.mjs
 * @description 服务句柄生命周期、注册端校验与动作超时的回归门禁
 *
 * 缺陷背景（三条）：
 *   ① registerService 不校验 manifest.provides —— 任何插件都能拿别人的服务名注册实现；
 *   ② unregisterService 只从 Map 里删，【不撤销已发出去的引用】——
 *      插件停用后，之前拿到的服务对象依然可调用（幽灵引用）；
 *      且「同 ID 重新激活后注册新实现」与「旧实现」无法区分（缺实现代次）；
 *   ③ registerAction 漏保存 timeoutMs —— 类注释承诺「单条注册可用 timeoutMs 覆盖」，
 *      实际 dispatchAction 读到的永远是 undefined。
 *
 * ★ 关于 Proxy 包装的技术前提（MDN 与规范行为）：
 *   - Proxy 的 get 陷阱触发时 this 指向 Proxy 而非原对象 ⇒
 *     私有字段与内置槽会访问失败 ⇒ 必须用原对象作 this；
 *   - 若属性是「自有 + 不可写 + 不可配置」（Object.freeze 过就是这样），
 *     get 陷阱必须返回完全相同的值，否则抛 TypeError ⇒ 这类属性退化为直接返回原方法。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost } from '../src/index.mjs';
import { addPublisher } from './fixtures/publisher.mjs';

function makeHost(contracts) {
  const host = new CordiumHost();
  host.declareServiceContracts(contracts);
  return host;
}

/** 提供一个服务 + 一个消费者；消费者依赖提供者以保证拓扑顺序，并在 activate 里取句柄 */
async function setupHandleScenario(implementation) {
  const host = makeHost({ 'service.store': { access: 'public' } });
  const captured = { handle: null, ctx: null };

  host.registerPlugin({
    id: 'plugin.provider',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.store']
  }, {
    async activate(ctx) {
      ctx.provideService('service.store', implementation);
    }
  });

  host.registerPlugin({
    id: 'plugin.consumer',
    version: '1.0.0',
    apiVersion: '1.0.0',
    dependencies: { 'plugin.provider': '^1.0.0' }
  }, {
    async activate(ctx) {
      captured.ctx = ctx;
      captured.handle = ctx.getService('service.store');
    }
  });

  await host.boot();
  return { host, captured };
}

// ───────────────────────── 注册端校验 ─────────────────────────

test('未在 manifest.provides 声明的服务名一律拒绝注册', async () => {
  const host = makeHost({ 'service.rogue': { access: 'public' } });
  host.registerPlugin({
    id: 'plugin.rogue',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: []            // 没有声明 service.rogue
  }, {
    async activate(ctx) { ctx.provideService('service.rogue', { ping: () => 'pong' }); }
  });

  await assert.rejects(
    () => host.boot(),
    hasCode('provide_not_declared', /is not allowed to provide 'service\.rogue'/),
    '插件不得注册自己没声明过的服务名 —— 否则能把别人的服务实现挤掉'
  );
});

// ───────────────────────── 句柄生命周期 ─────────────────────────

test('提供者停用后，之前发出的句柄立即失效（幽灵引用）', async () => {
  const { host, captured } = await setupHandleScenario({ read: () => 'v1' });
  assert.equal(captured.handle.read(), 'v1', '初始句柄应可用');

  await host.deactivatePlugin('plugin.provider');

  assert.throws(
    () => captured.handle.read(),
    (err) => err.code === 'service_unavailable',
    '提供者停用后旧句柄必须按稳定错误码失效，而不是继续可用'
  );
});

// ⚠️ 这里曾有「未经 scope 追踪的服务，提供者停用后句柄仍失效」，**已删除**。
//   它靠 `host.registerService(…, scope = null)` 构造「服务留在表里、提供者已停用」的场景；
//   registerService 私有化后，唯一注册入口是 ctx.provideService（必带 scope，停用即注销）⇒
//   该场景从公开 API **构造不出来**（实测：activate 抛错 / deactivate 钩子两条路都是先注销）。
//   句柄里的提供者状态检查保留为防御纵深。

test('消费者自身停用后，它手里的句柄同样失效', async () => {
  const { host, captured } = await setupHandleScenario({ read: () => 'v1' });
  assert.equal(captured.handle.read(), 'v1');

  await host.deactivatePlugin('plugin.consumer');

  assert.throws(
    () => captured.handle.read(),
    (err) => err.code === 'service_unavailable',
    '消费者停用后不得再通过旧句柄操作世界 —— 双向失效，缺一边都不算完成'
  );
});

test('同 ID 重新激活注册新实现后，旧句柄仍然失效（实现代次）', async () => {
  const { host, captured } = await setupHandleScenario({ read: () => 'v1' });
  const staleHandle = captured.handle;
  assert.equal(staleHandle.read(), 'v1');

  // 提供者停用 → 重新激活（此时会重新 provideService，产生新实现与新一代次）
  await host.deactivatePlugin('plugin.provider');
  await host.activatePlugin('plugin.provider');

  // 消费者已被 host 侧停用？没有 —— 只停了提供者，消费者仍是 ACTIVE
  assert.throws(
    () => staleHandle.read(),
    (err) => err.code === 'service_unavailable',
    '★ 这一条正是「只检查 Map + active 状态」抓不到的：服务名还在、提供者也 active，'
      + '但实现已经换了一代，旧句柄必须失效'
  );

  // 新取的句柄可用
  const fresh = host.getService('service.store', 'plugin.consumer');
  assert.equal(fresh.read(), 'v1', '重新取用的句柄应可用');
});

test('★ A→B→A 往返仍按注册代次区分旧句柄，不依赖可切换的 active provider', async () => {
  const host = makeHost({ 'service.round_trip': { access: 'public' } });
  const changes = [];
  let value = 'A';
  // ★ channel 私有 ⇒ 经插件公开的 watchService 观察
  (await addPublisher(host)).watchService('service.round_trip', change => changes.push(change));

  host.registerPlugin({
    id: 'plugin.round_trip.provider',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.round_trip']
  }, {
    async activate(ctx) {
      const captured = value;
      ctx.provideService('service.round_trip', { read: () => captured });
    }
  });
  host.registerPlugin({
    id: 'plugin.round_trip.consumer',
    version: '1.0.0',
    apiVersion: '1.0.0'
  }, { async activate() {} });

  await host.boot();
  const handleA1 = host.getService('service.round_trip', 'plugin.round_trip.consumer');
  assert.equal(handleA1.read(), 'A');

  await host.deactivatePlugin('plugin.round_trip.provider');
  value = 'B';
  await host.activatePlugin('plugin.round_trip.provider');
  const handleB = host.getService('service.round_trip', 'plugin.round_trip.consumer');
  assert.equal(handleB.read(), 'B');

  await host.deactivatePlugin('plugin.round_trip.provider');
  value = 'A';
  await host.activatePlugin('plugin.round_trip.provider');
  const handleA2 = host.getService('service.round_trip', 'plugin.round_trip.consumer');
  assert.equal(handleA2.read(), 'A');

  assert.throws(() => handleA1.read(), err => err.code === 'service_unavailable');
  assert.throws(() => handleB.read(), err => err.code === 'service_unavailable');
  assert.equal(handleA2.read(), 'A');
  assert.deepEqual(
    changes.filter(change => change.action === 'registered').map(change => change.epoch),
    [1, 2, 3],
    '同一提供者回到同一实现值时，注册身份仍必须有独立代次'
  );
});

test('★ 一个名字一个提供者：第二个提供者被拒，且既有句柄不受影响', async () => {
  // ★「一个名字一个提供者」取代了旧的「切换 singleton active provider 后旧句柄失效」。
  //
  // 为什么旧语义被删掉：选主是【全局可变单点】——被调用时所有持有该服务句柄的
  //   消费者一起失效，包括正在跑长任务的其它 agent。「一个 agent 的动作改变
  //   另一个 agent 的世界」在核心层不可接受，并发越多被打断概率越高。
  //
  // 新语义：一个服务名只允许一个提供者，撞名即拒（同 ID 重注册仍放行）。
  // 三个独立来源收敛到这条规则：
  //   Cordis `reflect.ts:189` / OpenClaw "One owner per responsibility" / Codex·cline 撞名即拒
  const host = makeHost({ 'service.switchable': { access: 'public' } });

  host.registerPlugin({
    id: 'plugin.provider.a',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.switchable']
  }, {
    async activate(ctx) {
      ctx.provideService('service.switchable', { read: () => 'a' });
    }
  });

  host.registerPlugin({
    id: 'plugin.consumer',
    version: '1.0.0',
    apiVersion: '1.0.0',
    dependencies: { 'plugin.provider.a': '^1.0.0' }
  }, { async activate() {} });

  await host.boot();
  const handle = host.getService('service.switchable', 'plugin.consumer');
  assert.equal(handle.read(), 'a');

  // 第二个提供者在 boot 之后才登场（模拟"后来又装了一个抢同名服务的插件"）
  host.registerPlugin({
    id: 'plugin.provider.b',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.switchable']
  }, {
    async activate(ctx) {
      ctx.provideService('service.switchable', { read: () => 'b' });
    }
  });

  // 第二个提供者必须被拒绝，而不是静默覆盖/选主
  await assert.rejects(
    () => host.activatePlugin('plugin.provider.b'),
    hasCode('provider_conflict', /is already provided by plugin 'plugin\.provider\.a'/),
    '★ 撞名必须抛错 —— 静默行为会把"两个插件抢同一服务"这种逻辑错误掩盖成"看起来正常"'
  );

  // ★ 关键：被拒绝的注册不得扰动既有提供者 —— 它的句柄仍须可用
  assert.equal(
    handle.read(),
    'a',
    '★ 第三方撞名失败不得影响既有提供者的句柄（旧实现在这里会让句柄静默失效）'
  );
});

test('★ 服务易主：原提供者注销后由他人接手，原句柄必须失效而新句柄可用', async () => {
  // 场景：插件热替换 / 提供者交接。
  //
  // 危险点：句柄包装的是【旧实现的裸对象引用】。服务名虽然还活着（换人了），
  //   旧句柄绝不能因此"复活" —— 否则已停用的插件仍能拿着它继续操作世界。
  //   这条只靠「服务名还在不在」判断不出来，必须靠【提供者身份 + 实现代次】。
  const host = makeHost({ 'service.handover': { access: 'public' } });

  host.registerPlugin({
    id: 'plugin.first',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.handover']
  }, {
    async activate(ctx) {
      ctx.provideService('service.handover', { who: () => 'first' });
    }
  });
  host.registerPlugin({
    id: 'plugin.consumer',
    version: '1.0.0',
    apiVersion: '1.0.0'
  }, { async activate() {} });

  await host.boot();
  const staleHandle = host.getService('service.handover', 'plugin.consumer');
  assert.equal(staleHandle.who(), 'first', '初始句柄应指向 first');

  // first 注销 —— 此时服务名下一时无主
  await host.deactivatePlugin('plugin.first');

  // 交接：新插件接手同名服务
  host.registerPlugin({
    id: 'plugin.second',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.handover']
  }, {
    async activate(ctx) {
      ctx.provideService('service.handover', { who: () => 'second' });
    }
  });
  await host.activatePlugin('plugin.second');

  assert.equal(
    host.getService('service.handover', 'plugin.consumer').who(),
    'second',
    '接手后的新句柄应可用'
  );
  assert.throws(
    () => staleHandle.who(),
    (error) => error?.code === 'service_unavailable',
    '★ 服务易主后旧句柄必须失效 —— 绝不能因为"服务名还活着"就让旧实现复活'
  );
});

test('句柄包装必须用原对象作 this（不得破坏私有字段与内置槽）', async () => {
  // 实现内部用 this 读写自己的状态；若包装时 this 指向 Proxy 就会出问题
  const { captured } = await setupHandleScenario({
    _count: 0,
    bump() { this._count += 1; return this._count; }
  });

  assert.equal(captured.handle.bump(), 1);
  assert.equal(captured.handle.bump(), 2, 'this 必须绑定原对象，状态才能正确累加');
});

test('冻结的服务实现在包装后仍可调用（Proxy 不变量：不得抛 TypeError）', async () => {
  const host = makeHost({ 'service.frozen': { access: 'public' } });

  host.registerPlugin({
    id: 'plugin.provider',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.frozen']
  }, {
    async activate(ctx) {
      // Object.freeze ⇒ 属性变成「自有 + 不可写 + 不可配置」
      ctx.provideService('service.frozen', Object.freeze({ read: () => 'frozen-value' }));
    }
  });

  host.registerPlugin({
    id: 'plugin.consumer',
    version: '1.0.0',
    apiVersion: '1.0.0',
    dependencies: { 'plugin.provider': '^1.0.0' }
  }, { async activate() {} });

  await host.boot();

  const handle = host.getService('service.frozen', 'plugin.consumer');
  assert.equal(
    handle.read(),
    'frozen-value',
    '冻结属性必须原样返回 —— 替换成包装函数会违反 Proxy 不变量并抛 TypeError'
  );
});

// ───────────────────────── 作用域所有权（越权注销）─────────────────────────

test('★ 篡改 ctx.scope.ownerId 不得改变注销结果（自己的实现必须被摘净）', async () => {
  // 缺陷背景：EffectScope 的 ownerId 曾是【公开可写字段】，而 dispose() 读它来调
  //   host.unregisterService(name, this.ownerId) —— 注销依据是一个插件能改的字符串。
  //   实测后果：插件把自己伪装成别的插件后，注销会打到【别人的】实现上，
  //   而自己的实现反而残留成幽灵（跨插件边界被击穿 + 自己漏清理，两头都错）。
  //
  // 新实现：归属事实记在宿主自己的 providerScopes 表里（键是 scope 对象身份），
  //   注销时按"这个 scope 是不是我"反查 ⇒ 改字符串不再有任何作用。
  const host = makeHost({ 'service.hijack': { access: 'public' } });
  let captured = null;

  host.registerPlugin({
    id: 'plugin.hijacker',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.hijack']
  }, {
    async activate(ctx) {
      ctx.provideService('service.hijack', { who: () => 'hijacker' });
      captured = ctx;
    }
  });
  host.registerPlugin({
    id: 'plugin.consumer',
    version: '1.0.0',
    apiVersion: '1.0.0'
  }, { async activate() {} });

  await host.boot();
  assert.equal(host.getInternalService('service.hijack').who(), 'hijacker');

  // ★ 攻击动作：把自己伪装成另一个插件
  captured.scope.ownerId = 'plugin.victim';

  await host.deactivatePlugin('plugin.hijacker');

  assert.throws(
    () => host.getInternalService('service.hijack'),
    hasCode('no_provider'),
    '★ 篡改 ownerId 后自己的实现仍必须被摘净 —— 注销依据必须是 scope 身份，'
      + '而不是一个可被改写的字符串（旧实现会残留成幽灵，本断言即变红）'
  );
});

// ───────────────────────── 动作超时 ─────────────────────────

test('registerAction 的单条 timeoutMs 真正生效（不再被静默丢弃）', async () => {
  const host = new CordiumHost({ actionTimeoutMs: 30000 });   // 宿主默认上限很长
  host.registerPlugin({
    id: 'plugin.slow',
    version: '1.0.0',
    apiVersion: '1.0.0'
  }, {
    async activate(ctx) {
      ctx.registerAction('slow.action', {
        timeoutMs: 50,                       // ★ 单条覆盖
        handler: () => new Promise(() => {}) // 永不 resolve
      });
    }
  });
  await host.boot();

  const started = Date.now();
  await assert.rejects(
    () => host.dispatchAction('plugin.slow', 'slow.action'),
    (err) => err.code === 'action_timeout'
  );
  const elapsed = Date.now() - started;

  assert.ok(
    elapsed < 5000,
    `单条 timeoutMs 必须覆盖宿主默认值（实际 ${elapsed}ms；若被忽略会等满 30s）`
  );
});

test('超时以稳定错误码 action_timeout 返回给调用方', async () => {
  const host = new CordiumHost();
  host.registerPlugin({
    id: 'plugin.hang',
    version: '1.0.0',
    apiVersion: '1.0.0'
  }, {
    async activate(ctx) {
      ctx.registerAction('hang.action', { timeoutMs: 30, handler: () => new Promise(() => {}) });
    }
  });
  await host.boot();

  await assert.rejects(
    () => host.dispatchAction('plugin.hang', 'hang.action'),
    (err) => {
      assert.equal(err.code, 'action_timeout', '必须是稳定错误码，调用方靠它程序化区分');
      return true;
    }
  );
});

test('超时只是停止等待，不代表取消执行（现状记录，非能力验收）', async () => {
  // ⚠️ 本测试【记录当前语义】，不是要求系统取消。
  //    若将来真的引入取消框架，本测试应当【变红并被改写】——
  //    那是预期的红，不是回归。
  const host = new CordiumHost();
  let handlerFinished = false;

  host.registerPlugin({
    id: 'plugin.late',
    version: '1.0.0',
    apiVersion: '1.0.0'
  }, {
    async activate(ctx) {
      ctx.registerAction('late.action', {
        timeoutMs: 30,
        handler: () => new Promise((resolve) => {
          setTimeout(() => { handlerFinished = true; resolve('done-late'); }, 120);
        })
      });
    }
  });
  await host.boot();

  await assert.rejects(() => host.dispatchAction('plugin.late', 'late.action'));

  assert.equal(handlerFinished, false, '超时当下处理器确实还没跑完');

  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(
    handlerFinished,
    true,
    '★ 超时之后处理器仍然跑完了 —— 证明执行未被取消（这正是「停止等待 ≠ 取消执行」）'
  );
});

test('超时必须在审计里与普通失败可区分（outcome=timeout）', async () => {
  const host = new CordiumHost();
  host.registerPlugin({
    id: 'plugin.audit',
    version: '1.0.0',
    apiVersion: '1.0.0'
  }, {
    async activate(ctx) {
      ctx.registerAction('audit.timeout', { timeoutMs: 30, handler: () => new Promise(() => {}) });
      ctx.registerAction('audit.error', { timeoutMs: 1000, handler: () => { throw new Error('业务爆炸'); } });
    }
  });
  await host.boot();

  await assert.rejects(() => host.dispatchAction('plugin.audit', 'audit.timeout'));
  await assert.rejects(() => host.dispatchAction('plugin.audit', 'audit.error'),
    err => hasCode('action_failed')(err) && err.cause?.message === '业务爆炸');

  const timeoutLog = host.getDiagnostics().recentLogs.find(log => log.details?.outcome === 'timeout');
  assert.ok(timeoutLog, '超时必须留下 outcome=timeout 的审计记录');
  assert.equal(
    timeoutLog.details.note,
    'handler may still be running',
    '必须注明处理器可能还在跑 —— 调用方据此判断是否需要幂等兜底'
  );

  const errorLog = host.getDiagnostics().recentLogs.find(log => log.details?.outcome === 'error');
  assert.equal(errorLog, undefined, '普通业务失败不得被记成超时（两者必须可区分）');
});

// ★ 句柄失效判定此前只按 id 查消费者 ⇒ 同 id 重新激活后，上一次激活拿到的旧句柄复活。
test('★ 消费者停用再激活：上一次激活拿到的旧句柄不得复活', async () => {
  const host = new CordiumHost();
  host.declareServiceContract('svc.d3', { access: 'public' });
  host.registerPlugin(
    { id: 'prov', version: '1.0.0', apiVersion: '1.0.0', provides: ['svc.d3'] },
    { activate(ctx) { ctx.provideService('svc.d3', { ping: () => 'pong' }); } }
  );
  let ctxRef = null;
  host.registerPlugin(
    { id: 'cons', version: '1.0.0', apiVersion: '1.0.0' },
    { activate(ctx) { ctxRef = ctx; } }
  );
  await host.boot();
  const old = ctxRef.getService('svc.d3');
  assert.equal(old.ping(), 'pong', '前置条件：本次激活内可用');

  await host.deactivatePlugin('cons');
  assert.throws(() => old.ping(), hasCode('service_unavailable'));

  await host.activatePlugin('cons');
  assert.throws(() => old.ping(), hasCode('service_unavailable', /earlier activation/),
    '★ 旧句柄属于已结束的那次激活，不得随同 id 重新激活而复活');
  assert.equal(ctxRef.getService('svc.d3').ping(), 'pong', '正向对照：新激活重新取的句柄可用');
});
