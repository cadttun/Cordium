/**
 * @file packages/kernel/test/lifecycle-gates.test.mjs
 * @description 「写侧生命周期」门禁
 *
 * ── 这批缺陷的共同形状 ──────────────────────────────────────────────
 * 内核的**读侧**很扎实（快照、闭包注入、逐层冻结、scope 身份反查都有测试钉住），
 * 但**写侧**此前几乎没有生命周期门禁：插件的 scope 一旦停用，
 * 「往宿主表里登记」的几条路仍然敞着。于是有了一整类后果 ——
 *
 *   · **清理闸门被插件改写** ⇒ 宿主以为停用完成，实际服务槽与监听器全都还在；
 *   · **已停用的 ctx 还能登记** ⇒ 服务名被幽灵永久占死（正当提供者 activate 抛错
 *     → boot 整体回滚 → 整机起不来），UI 贡献永久残留；
 *   · **生命周期迁移可交错** ⇒ activate 钩子跑两遍、scope 槽被覆盖、旧 scope 泄漏；
 *   · **二次 boot 失败拆健康插件**；**旧 error 残留**；**宿主通知到不了作用域订阅者**。
 *
 * ── 一条贯穿的判据 ──────────────────────────────────────────────────
 * **已停用的插件不得再改世界，也不得再观察世界。**
 * 这不是「插件不可信」的假设 —— 插件本来就是同进程内不受沙箱约束的代码；
 * 它防的是**生命周期错位**：一个已经被判定停用的对象，绝不该还持有活的副作用。
 *
 * ★ 每条测试都要能判别它守护的那段新代码 —— 删掉对应实现必须变红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost } from '../src/index.mjs';
import { pluginState, uiItem } from './fixtures/inspect.mjs';
import { addPublisher } from './fixtures/publisher.mjs';

function makeHost(contracts = { 'service.s': { access: 'public' }, 'service.t': { access: 'public' } }) {
  const host = new CordiumHost();
  host.declareServiceContracts(contracts);
  return host;
}

/** 造插件并返回被捕获的 ctx（停用后用它试探各条登记路径） */
async function hostWithStaleCtx() {
  const host = makeHost();
  const cap = {};
  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0', provides: ['service.s'] },
    { async activate(ctx) { cap.ctx = ctx; ctx.provideService('service.s', { who: () => 'A' }); } }
  );
  await host.boot();
  await host.deactivatePlugin('plugin.a');
  return { host, cap };
}

// ═══════════════ ① 清理闸门不可由插件改写 ═══════════════

test('★ 插件不得改写 scope.active —— 否则 dispose 会静默跳过全部清理', async () => {
  const host = makeHost({ 'service.s': { access: 'public' } });
  let thrown = null;
  let scopeRef = null;

  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0', provides: ['service.s'] },
    { async activate(ctx) {
        scopeRef = ctx.scope;
        ctx.provideService('service.s', { who: () => 'A' });
        try { ctx.scope.active = false; } catch (err) { thrown = err; }
      } }
  );
  await host.boot();

  assert.ok(thrown instanceof TypeError, '★ 写 active 必须抛 TypeError（严格模式下只读 getter）—— 否则闸门被静默关上');
  assert.equal(scopeRef.active, true, '闸门必须仍然有效');

  await host.deactivatePlugin('plugin.a');
  assert.throws(
    () => host.getInternalService('service.s'),
    hasCode('no_provider'),
    '★ 停用必须真正把服务槽摘干净（改造前这里还能取到幽灵实现）'
  );
});

test('★ 已停用插件的监听器不得再收到事件（不得继续观察世界）', async () => {
  const host = makeHost();
  const seen = [];
  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) { ctx.on('demo/e', v => seen.push(v)); } }
  );
  host.registerPlugin(
    // ★ 原先 b 依赖 a（只为钉激活顺序）。级联停用后，停 a 会连带停 b、
    //   且 a 不在时 b 不得再激活 —— 与本用例要的「一个仍活着的发布者」冲突。按注册顺序已足够。
    { id: 'plugin.b', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate() {} }
  );
  await host.boot();
  await host.deactivatePlugin('plugin.a');

  await host.activatePlugin('plugin.b');   // 同一条通道，由仍然活着的插件发布
  (await addPublisher(host)).emit('demo/e', 'after-disable');
  assert.deepEqual(seen, [], '★ 停用后监听器必须已摘除（改造前会照收）');
});

test('★ 已释放的 scope 上 trackTimer 必须被拒（否则定时器只进 Set、永不被清）', async () => {
  // ★ 这条专门守 scope.mjs 的 #assertActive：host 侧的三条登记门禁盖不到 trackTimer
  //   （定时器是纯 scope 内部资源），所以它是这条路径上唯一的守卫。
  const host = makeHost();
  let scope = null;
  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) { scope = ctx.scope; } }
  );
  await host.boot();
  await host.deactivatePlugin('plugin.a');

  assert.throws(() => scope.trackTimer(setTimeout(() => {}, 1000)), hasCode('scope_disposed'));
  assert.throws(() => scope.trackService('service.s'), hasCode('scope_disposed'));
  assert.throws(() => scope.trackUIContribution('panel.x'), hasCode('scope_disposed'));
});

test('scope 的资源集合交付的是【快照】—— 对返回的集合动手影响不到内部', async () => {
  const host = makeHost();
  let scope = null;
  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) { scope = ctx.scope; ctx.scope.trackService('service.s'); } }
  );
  await host.boot();

  // 门禁要求：services 仍是 Set（见 scope-isolation.test.mjs）
  assert.ok(scope.services instanceof Set);
  const before = scope.services.size;
  scope.services.clear();
  scope.disposers.clear();
  assert.equal(scope.services.size, before, '★ 对快照 clear() 不得掏空内部集合');
});

// ═══════════════ ② 已停用的 ctx 不得再登记 ═══════════════

test('★ 已停用的 ctx 调 provideService 必须被拒（否则服务名被幽灵永久占死）', async () => {
  const { host, cap } = await hostWithStaleCtx();

  assert.throws(
    () => cap.ctx.provideService('service.t', { who: () => 'GHOST' }),
    hasCode('scope_disposed'),
    '★ 停用后登记服务必须硬拒 —— 改造前它会【静默成功】'
  );
  // 反面：正当提供者必须仍能注册（说明拒绝的是"已停用"，不是"一律拒绝"）
  host.registerPlugin(
    { id: 'plugin.b', version: '1.0.0', apiVersion: '1.0.0', provides: ['service.t'] },
    { async activate(ctx) { ctx.provideService('service.t', { who: () => 'B' }); } }
  );
  await host.activatePlugin('plugin.b');
  assert.equal(host.getInternalService('service.t').who(), 'B', '正当提供者必须不受影响');
});

test('★ 已停用的 ctx 调 registerAction 必须被拒，且不得留下无 disposer 的 handler', async () => {
  const { host, cap } = await hostWithStaleCtx();

  assert.throws(() => cap.ctx.registerAction('act', { handler: () => 'GHOST' }), hasCode('scope_disposed'));
  // 公开观察点：让一个活插件去派发它 —— 残留的 handler 会被执行并返回 'GHOST'
  host.registerPlugin({ id: 'plugin.caller', version: '1.0.0', apiVersion: '1.0.0' }, { async activate() {} });
  await host.activatePlugin('plugin.caller');
  await assert.rejects(
    host.dispatchAction('plugin.caller', 'act', {}),
    hasCode('action_not_found'),
    '★ 动作表里不得残留 handler —— 改造前「先写表、后登记且不回滚」会永久留一条'
  );
});

test('★ 已停用的 ctx 调 registerUI 必须被拒（否则贡献列表永久多一条筛不掉的项）', async () => {
  const { host, cap } = await hostWithStaleCtx();

  assert.throws(() => cap.ctx.registerUIContribution({ id: 'panel.ghost' }), hasCode('scope_disposed'));
  assert.equal((uiItem(host, 'panel.ghost') !== undefined), false);
});

test('★ 插件不得自行释放宿主持有的 scope（状态与资源不得脱钩）', async () => {
  const host = makeHost();
  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) { await ctx.scope.dispose(); } }
  );
  // ★ scope.dispose 需要宿主令牌 ⇒ 插件调用当场抛错（此前是事后检测 scope.active）
  await assert.rejects(
    () => host.boot(),
    hasCode('scope_owned_by_host'),
    '★ 否则宿主会把一个资源已清空的插件标成 ACTIVE，此后既无人回收、它还继续收事件'
  );
});

// ═══════════════ ③ 生命周期迁移不得交错 ═══════════════

test('★ deactivate 与 activate 交错时：不得交错执行，且旧 scope 必须被释放', async () => {
  const host = makeHost();
  const scopes = [];
  const order = [];
  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        scopes.push(ctx.scope);
        order.push('act-in');
        await new Promise(r => setTimeout(r, 20));
        order.push('act-out');
      },
      async deactivate() {
        order.push('deact-in');
        await new Promise(r => setTimeout(r, 40));
        order.push('deact-out');
      }
    }
  );
  await host.boot();

  const p1 = host.deactivatePlugin('plugin.a');
  const p2 = host.activatePlugin('plugin.a');
  await Promise.all([p1, p2]);

  assert.deepEqual(
    order,
    ['act-in', 'act-out', 'deact-in', 'deact-out', 'act-in', 'act-out'],
    '★ 两次迁移必须【顺序各自跑完】—— 改造前 activate 钩子会跑两遍且与 deactivate 交错'
  );
  assert.equal(scopes[0].active, false, '★ 第一次的 scope 必须已被释放（改造前它会被覆盖后无人 dispose ⇒ 永久泄漏）');
  assert.equal(scopes[1].active, true, '新一轮 scope 必须是活的');
  // ★ 宿主记录必须指向【新】scope：下一次停用释放的必须是 scopes[1]（若仍指向旧 scope，新 scope 会永久泄漏）
  await host.deactivatePlugin('plugin.a');
  assert.equal(scopes[1].active, false, 'record.scope 必须指向新一轮的 scope —— 停用时它必须被释放');
});

test('★ 空闲时生命周期方法必须【同步起步】（不得整体推迟成微任务）', async () => {
  // 回归：第一版串行化把方法体无条件推迟一个微任务，导致 record.state 不再是同步生效的。
  //       上层应用在装配后紧跟的同步代码据此读状态 ⇒ 误判插件启停（实测）。
  const host = makeHost();
  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate() {}, async deactivate() { await new Promise(r => setTimeout(r, 10)); } }
  );
  await host.boot();

  const p = host.deactivatePlugin('plugin.a');
  assert.equal(
    pluginState(host, 'plugin.a'), 'stopping',
    '★ 调用返回的【那一刻】state 就应已是 stopping —— 这是同步起步的可判别证据'
  );
  await p;
  assert.equal(pluginState(host, 'plugin.a'), 'disabled');
});

// ═══════════════ ④ boot / 诊断 / 通知 ═══════════════

test('★ 二次 boot 失败不得把【本来健康】的插件一起拆掉', async () => {
  const host = makeHost();
  for (const id of ['plugin.a', 'plugin.b']) {
    host.registerPlugin({ id, version: '1.0.0', apiVersion: '1.0.0' }, { async activate() {} });
  }
  await host.boot();
  assert.equal(pluginState(host, 'plugin.a'), 'active');

  host.registerPlugin(
    { id: 'plugin.c', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate() { throw new Error('boom'); } }
  );
  // 保留报文断言：插件自抛的错误须原样透传（非 CordiumError、无 code），报文即被测对象
  await assert.rejects(() => host.boot(), /boom/);  // 保留报文断言：插件自抛的错误须原样透传，报文即被测对象

  assert.equal(pluginState(host, 'plugin.a'), 'active', '★ a 必须仍是 active（改造前会被回滚成 disabled）');
  assert.equal(pluginState(host, 'plugin.b'), 'active', '★ b 同理');
  assert.equal(pluginState(host, 'plugin.c'), 'failed');
});

test('★ 重新激活成功后必须清掉上一次的失败痕迹（诊断不得自相矛盾）', async () => {
  const host = makeHost();
  let first = true;
  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate() { if (first) { first = false; throw new Error('首次失败'); } } }
  );
  await assert.rejects(() => host.activatePlugin('plugin.a'));
  await host.activatePlugin('plugin.a');

  const entry = host.getDiagnostics().plugins.find(p => p.id === 'plugin.a');
  assert.equal(entry.state, 'active');
  assert.equal(entry.error, null, '★ active 的插件不得还挂着旧 error（改造前会误导排障）');
});

test('★ 服务变更通知必须送达【作用域内】的订阅者', async () => {
  // 改造前用 channel.emit ⇒ 派发键 undefined ⇒ 按官方放行表只放行无标签监听器，
  // 于是作用域内的订阅者永远收不到，而代码注释却承诺「消费者据此重新适配」。
  // ★ 通知改走宿主私有 symbol，插件只能经 watchService 订阅（原测试直接订字符串名，正是伪造通知的漏洞路径）。
  const host = makeHost({ 'service.s': { access: 'public' } });
  const got = { root: 0, scoped: 0 };

  host.registerPlugin(
    { id: 'plugin.watch', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) {
        ctx.watchService('service.s', () => got.root++);
        ctx.scoped('agent:x').watchService('service.s', () => got.scoped++);
      } }
  );
  await host.boot();

  host.registerPlugin(
    { id: 'plugin.prov', version: '1.0.0', apiVersion: '1.0.0', provides: ['service.s'] },
    { async activate(ctx) { ctx.provideService('service.s', {}); } }
  );
  await host.activatePlugin('plugin.prov');

  assert.equal(got.root, 1, '根订阅者必须收到');
  assert.equal(got.scoped, 1, '★ 作用域订阅者同样必须收到（宿主级通知不该被作用域过滤掉）');
});

test('★ 插件不能伪造服务变更通知，也不能绕过 watchService 旁听', async () => {
  const host = makeHost({ 'service.s': { access: 'public' } });
  const seen = [];
  const raw = [];
  let attacker = null;
  host.registerPlugin(
    { id: 'plugin.watch', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) {
        ctx.watchService('service.s', ch => seen.push(ch.action));
        ctx.on('internal/service', ch => raw.push(ch));   // 旧的字符串名：不得再收到宿主通知
      } }
  );
  host.registerPlugin(
    { id: 'plugin.evil', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) { attacker = ctx; } }
  );
  await host.boot();

  attacker.emit('internal/service', { name: 'service.s', providerId: 'x', action: 'unregistered', epoch: 1, scopeKey: null });
  assert.deepEqual(seen, [], '★ 伪造的通知不得送达 watcher');
  raw.length = 0;   // 上面那条是插件自己 emit 的普通事件，旁听者收到它是正常的

  host.registerPlugin(
    { id: 'plugin.prov', version: '1.0.0', apiVersion: '1.0.0', provides: ['service.s'] },
    { async activate(ctx) { ctx.provideService('service.s', {}); } }
  );
  await host.activatePlugin('plugin.prov');
  assert.deepEqual(seen, ['registered'], '真实通知照常送达');
  assert.deepEqual(raw, [], '★ 宿主通知不走字符串事件名 ⇒ ctx.on 旁听不到');
});

test('broadcast 只交给宿主 —— 插件 ctx 上不得有这个「发给所有人」的喇叭', async () => {
  const host = makeHost();
  let ctxRef = null;
  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) { ctxRef = ctx; } }
  );
  await host.boot();

  for (const key of ['broadcast', 'channel', 'emitGlobal']) {
    assert.equal(ctxRef[key], undefined, `ctx.${key} 不得可达（那会推翻作用域隔离）`);
  }
});

// ══════════════════════════════════════════════════════════════════════
// ★★ **接收侧**门禁（与上面那条【发送侧】门禁配对）
//
// 缺陷：`#subscribeForPlugin` 此前把 `options.global` **原样透传**给 channel，
//   而 `#admit` 的第一行是 `if (record.global) return true;` —— **一律放行**。
//   ⇒ 插件只要写 `ctx.on(name, fn, { global: true })`，
//     就能收到**任意作用域**的事件，**作用域隔离被整条绕过**。
//
// ★ 上面那条测试堵的是【发送侧】（`ctx.broadcast` 不可达）；
//   本条堵的是【接收侧】—— 同一个「发给所有人」的能力**换了个方向又开了一次**。
//
// ★ 修法：像 `scopeLabel` 一样，由宿主在 `#subscribeForPlugin` 里**覆盖为 `false`**
//   —— 插件 ctx 上**不存在**「全局订阅」这个选项（不是靠拦截，是靠没有这个能力）。
//
// ⚠️ 攻击的**前提**（实测确认）：攻击者必须在**某个作用域内**。
//   根作用域插件的 `scopeLabel` 是 `null`，而 `#admit` 对 `scopeLabel === null`
//   本来就是直接放行（untagged 全局可见）—— 那种情况不需要 `global` 也能收到，
//   不属本门禁的范围。所以下面的测试**把攻击者放进作用域**。
// ══════════════════════════════════════════════════════════════════════

test('★★ 接收侧门禁：ctx.on 的 {global:true} 不得成为旁听他人作用域的后门', async () => {
  const host = makeHost();
  const got = { victim: [], attacker: [] };
  let emitSecret = null;

  // 受害者：在【自己的作用域】里收发秘密事件
  host.registerPlugin(
    { id: 'plugin.victim', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        const scoped = ctx.scoped('agent:victim');
        scoped.on('secret/e', (v) => got.victim.push(v));
        emitSecret = () => scoped.emit('secret/e', 'VICTIM-DATA');
      }
    }
  );

  // 攻击者：在【另一个作用域】里，试图用 global:true 旁听
  host.registerPlugin(
    { id: 'plugin.attacker', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        const scoped = ctx.scoped('agent:attacker');
        scoped.on('secret/e', (v) => got.attacker.push(v), { global: true });
      }
    }
  );

  await host.boot();
  emitSecret();

  assert.deepEqual(got.victim, ['VICTIM-DATA'], '受害者自己的监听器必须照常收到（不得误伤正常路径）');
  assert.deepEqual(
    got.attacker,
    [],
    '★★ 攻击者【不得】收到 —— {global:true} 不得绕过作用域隔离'
  );
});

test('★★ 接收侧反例：同样位置、【不传】global 的监听器同样收不到（证明上面那条不是恒真）', async () => {
  // ★ 验收标准必须双向可判别。
  //   若把这条测试写成「传了 global 收不到」而不给对照组，
  //   一旦将来作用域放行规则整体失效（攻击者也收不到），测试仍会全绿 —— 那是假绿。
  //   本条的对照组同时钉住「受害者收得到」，两条合起来才说明放行规则**精确**。
  const host = makeHost();
  const got = { victim: [], attacker: [] };
  let emitSecret = null;

  host.registerPlugin(
    { id: 'plugin.victim', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        const scoped = ctx.scoped('agent:victim');
        scoped.on('secret/e', (v) => got.victim.push(v));
        emitSecret = () => scoped.emit('secret/e', 'VICTIM-DATA');
      }
    }
  );
  host.registerPlugin(
    { id: 'plugin.attacker', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        const scoped = ctx.scoped('agent:attacker');
        scoped.on('secret/e', (v) => got.attacker.push(v));   // ← 不传 global
      }
    }
  );

  await host.boot();
  emitSecret();

  assert.deepEqual(got.victim, ['VICTIM-DATA'], '对照组：受害者收得到 ⇒ 说明事件确实发出去了');
  assert.deepEqual(got.attacker, [], '对照组：不传 global 也收不到 ⇒ 隔离本来就在生效');
});

test('★★ 接收侧：privateScope 同样不得被 {global:true} 旁听', async () => {
  // ★ `privateScope()` 是「按身份独占」的那一档，比 `scoped(label)` 更强。
  //   若它被 global 绕过，则「私有作用域」这个承诺整体失效。
  const host = makeHost();
  const got = { victim: [], attacker: [] };
  let emitSecret = null;

  host.registerPlugin(
    { id: 'plugin.victim', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        const priv = ctx.privateScope();
        priv.on('secret/e', (v) => got.victim.push(v));
        emitSecret = () => priv.emit('secret/e', 'PRIVATE-DATA');
      }
    }
  );
  host.registerPlugin(
    { id: 'plugin.attacker', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        const scoped = ctx.scoped('agent:attacker');
        scoped.on('secret/e', (v) => got.attacker.push(v), { global: true });
      }
    }
  );

  await host.boot();
  emitSecret();

  assert.deepEqual(got.victim, ['PRIVATE-DATA'], '私有作用域自己的监听器必须收到');
  assert.deepEqual(got.attacker, [], '★★ privateScope 不得被 {global:true} 旁听');
});

test('★ 清理回调抛错进宿主错误日志（不只打 console），且不阻断其余清理', async () => {
  const host = makeHost();
  const cleaned = [];
  host.registerPlugin({ id: 'plugin.messy', version: '1.0.0', apiVersion: '1.0.0' }, {
    activate(ctx) {
      ctx.scope.addDisposer(() => cleaned.push('first'));
      ctx.scope.addDisposer(() => { throw new Error('cleanup boom'); });
    }
  });
  await host.boot();
  await host.deactivatePlugin('plugin.messy');
  assert.deepEqual(cleaned, ['first'], '一条清理抛错不得挡住其余清理');
  const logged = host.getDiagnostics().recentErrors
    ?? host.getDiagnostics().recentLogs.filter(l => l.level === 'error');
  assert.ok(logged.some(l => /Dispose hook of plugin 'plugin\.messy' threw: cleanup boom/.test(l.message)),
    `必须进宿主日志：${JSON.stringify(logged.map(l => l.message))}`);
});

test('★ ctx 浅冻结：插件不能往 ctx 上加 / 改 / 删属性；scope 不随之冻结，正当路径照常可用', async () => {
  const host = makeHost();
  const seen = {};
  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0', provides: ['service.s'] },
    { activate(ctx) {
        seen.frozen = Object.isFrozen(ctx);
        seen.scopedFrozen = Object.isFrozen(ctx.scoped('team'));
        seen.privateFrozen = Object.isFrozen(ctx.privateScope());
        seen.scopeFrozen = Object.isFrozen(ctx.scope);
        try { ctx.stash = 1; } catch (err) { seen.addErr = err; }
        try { ctx.getService = () => 'forged'; } catch (err) { seen.setErr = err; }
        try { delete ctx.log; } catch (err) { seen.delErr = err; }
        // 反向对照：正当路径照常
        ctx.provideService('service.s', { who: () => 'A' });
        seen.who = ctx.getService('service.s').who();
        ctx.scope.addDisposer(() => {});
      } }
  );
  await host.boot();
  assert.equal(seen.frozen, true, '★ 根 ctx 必须冻结');
  assert.equal(seen.scopedFrozen, true, '★ scoped() 派生的 ctx 同样冻结（同一份定义）');
  assert.equal(seen.privateFrozen, true, '★ privateScope() 派生的 ctx 同样冻结');
  assert.equal(seen.scopeFrozen, false, 'scope 不得被冻（内部有活的 disposer 表）');
  assert.ok(seen.addErr instanceof TypeError, '加属性必须抛 TypeError');
  assert.ok(seen.setErr instanceof TypeError, '改属性必须抛 TypeError');
  assert.ok(seen.delErr instanceof TypeError, '删属性必须抛 TypeError');
  assert.equal(seen.who, 'A');
});
