/**
 * ★★ 按需激活（`manifest.activation: 'lazy'`）。
 *
 * 缺口背景：`boot()` 此前**必然激活全部已登记插件**，不存在「已登记但未运行」这个状态。
 *   VS Code 有 `activationEvents`、OSGi 有 `Bundle-ActivationPolicy: lazy`、
 *   Chrome SW 靠事件唤醒 —— 「静态声明 + 动态加载」这套范式缺了动态那一半。
 *
 * ★★ 本内核的触发点为什么只有两个（**契约约束，不是取舍**）：
 *   `getService` / `emit` / `waterfall` 都**同步返回**，而激活是异步的。
 *   把激活挂到服务取用或事件派发上，就得把它们改成 async —— 那等于换一个框架。
 *   只有本来就 `async` 的 `dispatchAction` 能承载激活。
 *   对照：OSGi 能靠类加载驱动（Java 的 `Class.forName` 可阻塞等待）；
 *   VS Code 靠 `onCommand`（它的扩展宿主本就是异步消息通道）。**形态不同，不能照抄。**
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, LifecycleState } from '../src/index.mjs';

const m = (id, extra = {}) => ({ id, version: '1.0.0', apiVersion: '1.0.0', ...extra });
const stateOf = (host, id) => host.getDiagnostics().plugins.find(p => p.id === id).state;
const hasCode = code => err => err.code === code;

// ═══════════════ 基本语义 ═══════════════

test('★ 缺省即 eager：不写 activation 的插件 boot 时照旧全部激活（现有行为逐字不变）', async () => {
  const host = new CordiumHost();
  const ran = [];
  host.registerPlugin(m('p.a'), { activate: () => ran.push('a') });
  host.registerPlugin(m('p.b'), { activate: () => ran.push('b') });
  await host.boot();
  assert.deepEqual(ran.sort(), ['a', 'b'], '缺省行为不得改变 —— 这是向后兼容的底线');
  assert.equal(stateOf(host, 'p.a'), 'active');
});

test('★ lazy 插件 boot 时停在 ready，activate 不跑', async () => {
  const host = new CordiumHost();
  let ran = false;
  host.registerPlugin(m('p.lazy', { activation: 'lazy' }), { activate: () => { ran = true; } });
  await host.boot();
  assert.equal(ran, false, '★ boot 不得跑 lazy 插件的 activate —— 这正是按需激活的意义');
  assert.equal(stateOf(host, 'p.lazy'), LifecycleState.READY);
});

test('★ eager 与 lazy 混装：eager 照常跑，lazy 停在 ready', async () => {
  const host = new CordiumHost();
  const ran = [];
  host.registerPlugin(m('p.eager'), { activate: () => ran.push('eager') });
  host.registerPlugin(m('p.lazy', { activation: 'lazy' }), { activate: () => ran.push('lazy') });
  await host.boot();
  assert.deepEqual(ran, ['eager']);
  assert.equal(stateOf(host, 'p.eager'), 'active');
  assert.equal(stateOf(host, 'p.lazy'), 'ready');
});

// ═══════════════ 触发点 ①：显式激活 ═══════════════

test('★ 触发点① 显式 activatePlugin：ready → active，且 activate 只跑一次', async () => {
  const host = new CordiumHost();
  let count = 0;
  host.registerPlugin(m('p.lazy', { activation: 'lazy' }), { activate: () => { count += 1; } });
  await host.boot();
  await host.activatePlugin('p.lazy');
  assert.equal(stateOf(host, 'p.lazy'), 'active');
  assert.equal(count, 1);
  await host.activatePlugin('p.lazy');      // 再触发一次
  assert.equal(count, 1, '已 active ⇒ 不得重跑 activate（幂等）');
});

test('★ 触发点① 的 ready 插件依赖了另一个 ready 插件 ⇒ 依赖被连带拉起', async () => {
  const host = new CordiumHost();
  host.declareServiceContracts({ svc: { access: 'public' } });   // 服务名须由宿主声明
  const ran = [];
  host.registerPlugin(m('p.provider', { activation: 'lazy', provides: ['svc'] }), {
    activate(ctx) { ran.push('provider'); ctx.provideService('svc', { ping: () => 'pong' }); }
  });
  host.registerPlugin(m('p.consumer', { activation: 'lazy', dependencies: { 'p.provider': '^1.0.0' } }), {
    activate(ctx) { ran.push('consumer'); ctx.getService('svc'); }
  });
  await host.boot();
  await host.activatePlugin('p.consumer');
  assert.deepEqual(ran, ['provider', 'consumer'], '★ 必须【先】拉起依赖，否则 consumer 会因 dependency_inactive 失败');
  assert.equal(stateOf(host, 'p.provider'), 'active');
  assert.equal(stateOf(host, 'p.consumer'), 'active');
});

// ═══════════════ 触发点 ②：首次派发动作 ═══════════════

test('★★ 触发点② 首次派发一个未命中动作 ⇒ 拉起懒插件后重试成功', async () => {
  const host = new CordiumHost();
  host.declarePermissions(['perm.x']);
  host.registerPlugin(m('p.tool', { activation: 'lazy', permissions: ['perm.x'] }), {
    activate(ctx) {
      ctx.registerAction('tool.run', { requiredPermission: 'perm.x', handler: p => `ran:${p}` });
    }
  });
  host.registerPlugin(m('p.caller', { permissions: ['perm.x'] }), { activate() {} });
  await host.boot();
  assert.equal(stateOf(host, 'p.tool'), 'ready');

  // ★ 这就是「用户点了一个命令」的场景：命令的处理器住在懒插件里
  const result = await host.dispatchAction('p.caller', 'tool.run', 'payload');
  assert.equal(result, 'ran:payload', '★ 首次派发必须能唤醒懒插件并成功');
  assert.equal(stateOf(host, 'p.tool'), 'active');
});

test('★ 触发点② 热路径零代价：动作已命中 ⇒ 不碰任何懒插件', async () => {
  const host = new CordiumHost();
  let lazyRan = false;
  host.registerPlugin(m('p.eager'), {
    activate(ctx) { ctx.registerAction('hot.action', { handler: () => 'hit' }); }
  });
  host.registerPlugin(m('p.lazy', { activation: 'lazy' }), { activate: () => { lazyRan = true; } });
  await host.boot();
  // 命中路径：不得为了这次派发去唤醒任何懒插件
  assert.equal(await host.dispatchAction('p.eager', 'hot.action', null), 'hit');
  assert.equal(lazyRan, false, '★ 命中的派发是热路径，不得付出唤醒代价');
  assert.equal(stateOf(host, 'p.lazy'), 'ready', '命中路径下懒插件必须纹丝不动');
});

test('★ 触发点② 没有懒插件可拉时，保持原来的 action_not_found 语义', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.a'), { activate() {} });
  await host.boot();
  await assert.rejects(() => host.dispatchAction('p.a', 'ghost.action', null),
    hasCode('action_not_found'), '★ 不得因为「试过唤醒」就把这个码换掉');
});

test('★ 懒插件激活失败 ⇒ 不吞掉，进 failed 且原因在日志里；原 action_not_found 照常报', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.bad', { activation: 'lazy' }), {
    activate() { throw new Error('boom in lazy'); }
  });
  host.registerPlugin(m('p.caller'), { activate() {} });
  await host.boot();
  await assert.rejects(() => host.dispatchAction('p.caller', 'whatever', null), hasCode('action_not_found'));
  assert.equal(stateOf(host, 'p.bad'), 'failed', '★ 失败的懒插件必须可见（VS Code / OSGi 都以此为坑）');
  const d = host.getDiagnostics();
  // ★ 失败本身由内层以 error 级记录（进专用错误缓冲）——这正是「失败必须可见」的落点
  assert.ok(d.recentErrors.some(l => l.message.includes("Plugin 'p.bad' failed to activate")),
    '★ 失败原因必须进错误日志 —— 「失败不可见」是本仓明令要避的坑');
  // ★ 外层补一条 warn，说明【是什么把它拉起来的】（触发原因），供排障
  assert.ok(d.recentLogs.some(l => l.level === 'warn' && l.message.includes('Failed to activate lazy plugin')),
    '★ 必须留下「因何被触发」的上下文');
});

// ═══════════════ 与既有生命周期机制的配合 ═══════════════

test('★ 懒插件被显式停用 ⇒ disabled，boot 不再把它拉起来（用户意图优先）', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.lazy', { activation: 'lazy' }));
  await host.boot();
  await host.deactivatePlugin('p.lazy');
  assert.equal(stateOf(host, 'p.lazy'), LifecycleState.DISABLED,
    '★ ready → disabled 是允许的（否则用户根本无法停用一个懒插件）');
  await host.boot();
  assert.equal(stateOf(host, 'p.lazy'), LifecycleState.DISABLED, 'boot 不得覆盖用户意图');
});

test('★ ready 的插件依赖一个 eager 插件：boot 后 ready，触发时依赖已就绪', async () => {
  const host = new CordiumHost();
  host.declareServiceContracts({ svc: { access: 'public' } });
  host.registerPlugin(m('p.iface', { provides: ['svc'] }), {
    activate(ctx) { ctx.provideService('svc', { ping: () => 'pong' }); }
  });
  const got = [];
  host.registerPlugin(m('p.lazy', { activation: 'lazy', dependencies: { 'p.iface': '^1.0.0' } }), {
    activate(ctx) { got.push(ctx.getService('svc').ping()); }   // ctx 是冻结的，只能往外部数组里记
  });
  await host.boot();
  assert.equal(stateOf(host, 'p.lazy'), 'ready');
  await host.activatePlugin('p.lazy');
  assert.equal(stateOf(host, 'p.lazy'), 'active');
  assert.deepEqual(got, ['pong'], '★ 触发时它的 eager 依赖必须已经就绪');
});

test('★ 懒插件的依赖被停用 ⇒ 懒插件退回 disabled（它是活的，要被级联看到）', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.provider'));
  host.registerPlugin(m('p.lazy', { activation: 'lazy', dependencies: { 'p.provider': '^1.0.0' } }));
  await host.boot();
  await host.deactivatePlugin('p.provider');
  assert.equal(stateOf(host, 'p.lazy'), LifecycleState.DISABLED,
    '★ ready 算「活着」⇒ 级联停用必须找得到它，否则会留下「依赖已下线却仍在等触发」的插件');
});

test('★ 级联恢复：提供者回来后，被级联停用的懒插件回到 ready（不是自动激活）', async () => {
  const host = new CordiumHost();
  let lazyRan = false;
  host.registerPlugin(m('p.provider'));
  host.registerPlugin(m('p.lazy', { activation: 'lazy', dependencies: { 'p.provider': '^1.0.0' } }),
    { activate: () => { lazyRan = true; } });
  await host.boot();
  await host.deactivatePlugin('p.provider');
  assert.equal(stateOf(host, 'p.lazy'), 'disabled');
  await host.activatePlugin('p.provider');
  assert.equal(stateOf(host, 'p.lazy'), LifecycleState.READY,
    '★ 回到 ready 而不是 active —— 它本来只是「还没触发」，提供者回来不构成触发');
  assert.equal(lazyRan, false, '★ 恢复不得顺手跑它的 activate');
});

test('★ 依赖懒插件的 eager 插件在 boot 时被跳过（依赖没跑过 activate 不能上线）', async () => {
  const host = new CordiumHost();
  let eagerRan = false;
  host.registerPlugin(m('p.lazy', { activation: 'lazy' }));
  host.registerPlugin(m('p.eager', { dependencies: { 'p.lazy': '^1.0.0' } }), {
    activate() { eagerRan = true; }
  });
  await host.boot();
  assert.equal(eagerRan, false, '★ 依赖没上线，急切插件不得抢先跑');
  // ⚠️ 断言消息此前写的是「停在原地**等依赖被触发**」—— 那句话**没有任何机制兑现**：
  //   懒依赖后来被触发时，**没有任何东西会把这个急切插件拉起来**
  //   （`#resumeCascaded` 只管「被级联停用」的，`#activateAllReady` 只扫 `ready`，而它是 `discovered`）。
  //   要它上线必须显式 `activatePlugin` —— 见下面那条回归①b 的注释。
  //   ⇒ 这里如实写成「停在 discovered，且不会自动上线」，并把「为什么」交给诊断面回答
  //     （`unresolvedDependencies` 会报 `{ id: <懒依赖>, reason: 'not_running' }`）。
  assert.equal(stateOf(host, 'p.eager'), LifecycleState.DISCOVERED,
    '停在 discovered，且**不会**在懒依赖被触发时自动上线（要显式 activatePlugin）');
  assert.deepEqual(host.getDiagnostics().plugins.find(p => p.id === 'p.eager').unresolvedDependencies,
    [{ id: 'p.lazy', reason: 'not_running' }],
    '★ 「它为什么没起来」必须能从快照里读出来，而不是只躺在日志里');
});

// ═══════════════ 诊断 ═══════════════

test('★ 诊断快照带出 activation 字段（投影从契约表派生，自动跟）', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.lazy', { activation: 'lazy' }));
  host.registerPlugin(m('p.eager'));
  await host.boot();
  const d = host.getDiagnostics().plugins;
  assert.equal(d.find(p => p.id === 'p.lazy').activation, 'lazy');
  assert.equal(d.find(p => p.id === 'p.eager').activation, 'eager');
});

// ════════════════════════════════════════════════════════════════════════════
// ★★ 三处缺陷的判别性回归 —— 由【独立对抗性核验】发现，全部经本机复现后才修。
//    共同形状：**对一个「已经是活的」或「只是还没到时候」的插件做了无条件改写**。
// ════════════════════════════════════════════════════════════════════════════

test('★★ 回归①：二次 boot 不得把【已激活】的懒插件打回 ready', async () => {
  // 复现（修复前）：boot(); activatePlugin('p.lazy'); boot();
  //   ⇒ state 从 active 变回 ready，但 scope 未释放、服务仍在表里。
  //   再触发会**重跑 activate** ⇒ 带 registerAction 的插件抛 duplicate_action。
  const host = new CordiumHost();
  host.declareServiceContracts({ svc: { access: 'public' } });
  let runs = 0;
  host.registerPlugin(m('p.lazy', { activation: 'lazy', provides: ['svc'] }), {
    activate(ctx) { runs += 1; ctx.provideService('svc', { ping: () => 1 }); }
  });
  await host.boot();
  await host.activatePlugin('p.lazy');
  assert.equal(stateOf(host, 'p.lazy'), 'active');

  await host.boot();                      // ★ 二次 boot

  assert.equal(stateOf(host, 'p.lazy'), 'active', '★ 已激活的懒插件不得被 boot 打回 ready（假停用）');
  assert.equal(runs, 1, '★ 不得重跑 activate');
  // 正向对照：服务确实还在（否则上面的断言可能只是因为「什么都没发生」而恰好成立）
  assert.equal(host.getDiagnostics().services.find(s => s.name === 'svc').providerCount, 1);
});

test('★★ 回归①b：二次 boot 不得把【依赖已激活懒插件】的 eager 插件打回 discovered', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.lazy', { activation: 'lazy' }));
  host.registerPlugin(m('p.eager', { dependencies: { 'p.lazy': '^1.0.0' } }), { activate() {} });
  await host.boot();
  await host.activatePlugin('p.lazy');    // 触发 ⇒ 依赖就绪
  await host.activatePlugin('p.eager');   // 显式拉起（boot 那次它被跳过了）
  assert.equal(stateOf(host, 'p.eager'), 'active');

  await host.boot();
  assert.equal(stateOf(host, 'p.eager'), 'active', '★ 不得把一个正在跑的插件打回 discovered');
});

test('★★ 回归②：lazy 依赖 lazy —— 依赖方必须进 ready，且触发点②能拉起两者', async () => {
  // 复现（修复前）：lazy B 依赖 lazy A ⇒ boot 后 B 停在 `discovered`
  //   ⇒ #activateAllReady 只扫 ready、永远看不到它 ⇒ 连它注册的动作都派发不到。
  //   「按需激活」在最常见的形态（提供者也是懒的）下直接失效。
  const host = new CordiumHost();
  const ran = [];
  host.registerPlugin(m('p.a', { activation: 'lazy' }), { activate() { ran.push('a'); } });
  host.registerPlugin(m('p.b', { activation: 'lazy', dependencies: { 'p.a': '^1.0.0' } }), {
    activate(ctx) { ran.push('b'); ctx.registerAction('b.run', { handler: () => 'ok' }); }
  });
  host.registerPlugin(m('p.caller'), { activate() {} });
  await host.boot();

  assert.equal(stateOf(host, 'p.b'), LifecycleState.READY,
    '★ 依赖也是懒的 ⇒ 它只是【还不能跑】，不是永远起不来 —— 必须进 ready 而不是 discovered');

  const result = await host.dispatchAction('p.caller', 'b.run', {});
  assert.equal(result, 'ok', '★ 触发点②必须能穿透「懒依赖懒」');
  assert.deepEqual(ran, ['a', 'b'], '★ 先拉起依赖');
});

test('★ 回归②b：急切插件依赖懒插件 ⇒ boot 不失败、不跑 activate，依赖就绪后可显式激活', async () => {
  // ⚠️ 期望值订正（我第一版写错过）：急切插件此时停在 `discovered`，**不是** `ready` ——
  //   `ready` 在本设计里的语义是「**懒**、等被触发」，把它用在急切插件上是语义错位。
  //   真正要守的是三件事：boot 不失败 / 不跑 activate / 依赖就绪后能起来。
  const host = new CordiumHost();
  let eagerRan = false;
  host.registerPlugin(m('p.lazy', { activation: 'lazy' }));
  host.registerPlugin(m('p.eager', { dependencies: { 'p.lazy': '^1.0.0' } }), {
    activate() { eagerRan = true; }
  });
  // ★ boot 不得因为「依赖是懒的、还没跑」而失败 —— 那只是"还没到时候"，不是错误
  await host.boot();
  assert.equal(eagerRan, false, '依赖没跑过 activate，急切插件不得抢先上线');
  assert.equal(stateOf(host, 'p.eager'), LifecycleState.DISCOVERED,
    '停在原地等依赖（`discovered` 是「还没轮到」，与 lazy 的「等触发」不同）');

  // 依赖被触发后，它可以起来
  await host.activatePlugin('p.lazy');
  await host.activatePlugin('p.eager');
  assert.equal(eagerRan, true, '★ 依赖就绪后必须能起来（这条才是判据）');
  assert.equal(stateOf(host, 'p.eager'), 'active');
});

test('★★ 回归③：提供者恢复时，不得把【已被触发的】懒插件重写回 ready', async () => {
  const host = new CordiumHost();
  let runs = 0;
  host.registerPlugin(m('p.provider'));
  // ★ 真正要守的不变量：`stoppedByCascade` 的语义是「**只是被连累，恢复原样**」——
  //   一个**已经激活过**的懒插件被连累停掉后，恢复时必须回到 **`active`（重新激活）**，
  //   而不是 `ready`。写成 `ready` 是「假停用」：状态说「等触发」，但它的 scope 其实已经
  //   在级联停用时被释放、动作已被摘除 —— 于是这个插件**再也不会自己回来**。
  //   （第一版我把判据写成「状态是 active 或 ready 都算过」，太宽松，撤掉修复照样绿。）
  host.registerPlugin(m('p.lazy', { activation: 'lazy', dependencies: { 'p.provider': '^1.0.0' } }), {
    activate(ctx) { runs += 1; ctx.registerAction('lazy.act', { handler: () => 'ok' }); }
  });
  await host.boot();
  await host.activatePlugin('p.lazy');
  assert.equal(runs, 1);
  assert.equal(await host.dispatchAction('p.lazy', 'lazy.act', null), 'ok', '正向对照：动作已在表里');

  await host.deactivatePlugin('p.provider');
  assert.equal(stateOf(host, 'p.lazy'), 'disabled', '已激活的懒插件被级联停用 ⇒ disabled');
  await host.activatePlugin('p.provider');        // ← `#resumeCascaded` 在这里跑

  assert.equal(stateOf(host, 'p.lazy'), 'active',
    '★ 被连累的【已激活过的】懒插件必须恢复成 active，不是退回 ready（否则它永远不会自己回来）');
  assert.equal(runs, 2, '★ 它确实被停用过（scope 已释放）⇒ 恢复是一次正常的重新激活');
  // ★ 最硬的判据：恢复后动作仍可用，且不撞名
  assert.equal(await host.dispatchAction('p.lazy', 'lazy.act', null), 'ok',
    '★ 若恢复成了 ready 而没重新激活，这里会 action_not_found');
});

test('★ 回归的判别性前提：三个用例都建立在「懒插件确实能进 ready」之上（否则恒真）', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.plain-lazy', { activation: 'lazy' }));
  await host.boot();
  assert.equal(stateOf(host, 'p.plain-lazy'), LifecycleState.READY);
  assert.equal(LifecycleState.READY, 'ready');
});
