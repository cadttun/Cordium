/**
 * @file packages/kernel/test/channel.test.mjs
 * @description 信息中转层（MessageChannel）的门禁
 *
 * 本层是内核里【只负责搬运消息】的那一层：零业务、零 token。
 * 测试重点不是「功能能跑」，而是**分发语义的确定性**：
 *   顺序、快照、隔离、停留/传输/变换各自可判别。
 *
 * ★ 每条测试都要能判别它守护的代码 —— 删掉对应实现必须变红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { MessageChannel, isBailed, DispatchMode, CordiumHost } from '../src/index.mjs';
import { listenerCount } from './fixtures/inspect.mjs';
import { addPublisher } from './fixtures/publisher.mjs';

// ───────────────────────── 注册语义 ─────────────────────────

test('subscribe 是【同步】的：先订阅再发布必达（不得有首次握手竞态）', () => {
  // 依据：Qwen Code EventBus 官方文档明确把「注册是同步的」列为设计点 ——
  //   "by the time subscribe() returns, the subscriber is already attached,
  //    so a publish() that races with the consumer's first next() is still delivered."
  // 若注册被改成异步（例如微任务里才挂载），本断言即变红。
  const channel = new MessageChannel();
  const seen = [];
  channel.subscribe('demo/ping', () => seen.push(1));

  channel.emit('demo/ping');   // 紧跟其后发布，不得漏
  assert.deepEqual(seen, [1], '订阅返回后必须立即可被通知到');
});

test('退订是幂等的，且 listenerCount 正确回落', () => {
  const channel = new MessageChannel();
  const off = channel.subscribe('demo/x', () => {});
  assert.equal(channel.listenerCount('demo/x'), 1);

  assert.equal(off(), true, '首次退订应成功');
  assert.equal(off(), false, '重复退订应返回 false，而不是抛错');
  assert.equal(channel.listenerCount('demo/x'), 0);
  assert.deepEqual(channel.eventNames(), [], '监听器清零后事件名也应被清掉');
});

test('prepend 决定优先级：插队首者先收到', () => {
  const channel = new MessageChannel();
  const order = [];
  channel.subscribe('demo/order', () => order.push('normal-1'));
  channel.subscribe('demo/order', () => order.push('normal-2'));
  channel.subscribe('demo/order', () => order.push('high'), { prepend: true });

  channel.emit('demo/order');
  assert.deepEqual(order, ['high', 'normal-1', 'normal-2'], 'prepend 必须插到队首');
});

test('非法入参必须报错，不得静默接受', () => {
  const channel = new MessageChannel();
  assert.throws(() => channel.subscribe('', () => {}), hasCode('invalid_argument'));
  assert.throws(() => channel.subscribe('demo/x', 'not-a-function'), hasCode('invalid_argument'));
});

// ───────────────────────── emit（广播，不等回执）─────────────────────────

test('★ emit：单个监听器抛错【不得阻断】其他监听器', () => {
  // 否则一个坏插件就能静默吃掉所有人的通知 —— 这是"广播"最容易被写错的地方。
  const channel = new MessageChannel();
  const seen = [];
  channel.onListenerError = () => {};   // 静音，专测"不阻断"这一条

  channel.subscribe('demo/boom', () => { throw new Error('监听器炸了'); });
  channel.subscribe('demo/boom', () => seen.push('still-ran'));

  channel.emit('demo/boom');
  assert.deepEqual(seen, ['still-ran'], '前一个监听器抛错后，后面的仍必须收到');
});

test('emit：监听器异常必须经由 onListenerError 上报（不得静默吞掉）', () => {
  const channel = new MessageChannel();
  const reported = [];
  channel.onListenerError = (name, error) => reported.push([name, error.message]);

  channel.subscribe('demo/report', () => { throw new Error('具体原因'); });
  channel.emit('demo/report');

  assert.deepEqual(reported, [['demo/report', '具体原因']], '必须带事件名与原始错误上报');
});

test('★ emit：遍历用快照 —— 发布过程中退订不得导致漏发或重发', () => {
  const channel = new MessageChannel();
  const seen = [];
  const offSecond = channel.subscribe('demo/snapshot', () => seen.push('first'));
  channel.subscribe('demo/snapshot', () => {
    seen.push('second');
    offSecond();                 // 发布过程中退订「first」
  });
  channel.subscribe('demo/snapshot', () => seen.push('third'));

  channel.emit('demo/snapshot');
  // 快照 = 发布开始那一刻的三个人；退订只影响【下一次】发布。
  assert.deepEqual(seen, ['first', 'second', 'third'], '本次发布仍应通知快照内的全部监听器');

  seen.length = 0;
  channel.emit('demo/snapshot');
  assert.deepEqual(seen, ['second', 'third'], '下一次发布时被退订者不应再收到');
});

// ───────────────────────── serial（第一个有回应的赢）─────────────────────────

test('serial：串行询问，【第一个有回应的赢】，后面的人不再被问', () => {
  const channel = new MessageChannel();
  const asked = [];
  channel.subscribe('demo/handle', () => { asked.push('a'); return undefined; });
  channel.subscribe('demo/handle', () => { asked.push('b'); return 'B 接管'; });
  channel.subscribe('demo/handle', () => { asked.push('c'); return 'C 接管'; });

  return channel.serial('demo/handle').then(result => {
    assert.equal(result, 'B 接管', '应返回第一个非空回应');
    assert.deepEqual(asked, ['a', 'b'], '★ 第三个监听器【不该】被问到 —— 这是"短路"的核心');
  });
});

test('serial：全部无回应时返回 undefined（不得误报成功）', async () => {
  const channel = new MessageChannel();
  channel.subscribe('demo/none', () => undefined);
  channel.subscribe('demo/none', () => null);
  assert.equal(await channel.serial('demo/none'), undefined);
});

test('isBailed：只有非空且非 false 才算拦截', () => {
  assert.equal(isBailed(undefined), false);
  assert.equal(isBailed(null), false);
  assert.equal(isBailed(false), false);
  assert.equal(isBailed(0), true, '0 是合法回应，不得被当成"没回应"');
  assert.equal(isBailed(''), true, '空串是合法回应');
  assert.equal(isBailed({}), true);
});

// ───────────────────────── parallel（等全部）─────────────────────────

test('parallel：等全部完成；失败 ⇒ listener_failed，原始错误一条不丢地挂在 cause.errors', async () => {
  const channel = new MessageChannel();
  const done = [];
  channel.subscribe('demo/par', async () => { await Promise.resolve(); done.push('a'); });
  channel.subscribe('demo/par', async () => { done.push('b'); throw new Error('b 失败'); });
  channel.subscribe('demo/par', async () => { done.push('c'); });

  await assert.rejects(
    () => channel.parallel('demo/par'),
    (error) => {
      // 与其它失败同一口径 —— 按 code 分支；细节在标准 cause 上
      assert.equal(error.code, 'listener_failed');
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.length, 1);
      assert.equal(error.cause.errors[0].message, 'b 失败', '插件自抛的原始错误必须原样保留');
      return true;
    }
  );
  assert.deepEqual(done.sort(), ['a', 'b', 'c'], '★ 一个失败不得影响其他跑完（allSettled 语义）');
});

// ───────────────────────── waterfall（停留 / 传输 / 变换）─────────────────────────

test('★ waterfall：没人拦截时走兜底实现', () => {
  const channel = new MessageChannel();
  const result = channel.waterfall('demo/wf', 'payload', (x) => `兜底:${x}`);
  assert.equal(result, '兜底:payload');
});

test('★ waterfall 可【停留】：不调 next() 即拦下，兜底不再执行', () => {
  const channel = new MessageChannel();
  let fallbackRan = false;
  channel.subscribe('demo/stop', (x, next) => {
    if (x === 'block-me') return '被拦下了';   // 不调 next ⇒ 停留
    return next();
  });

  const blocked = channel.waterfall('demo/stop', 'block-me', () => { fallbackRan = true; return '兜底'; });
  assert.equal(blocked, '被拦下了');
  assert.equal(fallbackRan, false, '★ 拦截后兜底【绝不能】再执行');

  const passed = channel.waterfall('demo/stop', 'let-me-go', () => '兜底');
  assert.equal(passed, '兜底', '不拦的时候应正常透传');
});

test('★ waterfall 可【变换】：改完参数再往下传', () => {
  const channel = new MessageChannel();
  channel.subscribe('demo/transform', (text, next) => next(`${text} → 补了上下文`));
  const result = channel.waterfall('demo/transform', '原文', (t) => `最终:${t}`);
  assert.equal(result, '最终:原文 → 补了上下文');
});

test('waterfall 可【传输】：多个中间件按注册顺序依次接力', () => {
  const channel = new MessageChannel();
  const trace = [];
  channel.subscribe('demo/chain', (v, next) => { trace.push('A-进'); const r = next(); trace.push('A-出'); return r; });
  channel.subscribe('demo/chain', (v, next) => { trace.push('B-进'); const r = next(); trace.push('B-出'); return r; });

  const result = channel.waterfall('demo/chain', 'x', () => { trace.push('兜底'); return 'done'; });
  assert.equal(result, 'done');
  // 洋葱模型：进 A → 进 B → 兜底 → 出 B → 出 A
  assert.deepEqual(trace, ['A-进', 'B-进', '兜底', 'B-出', 'A-出']);
});

test('★★ waterfall：next() 调用两次必须抛错（Koa 的经典陷阱）', () => {
  // 依据：Koa 官方指南专门用一个反例讲这个问题；
  //   静默产生诡异行为比直接报错难查得多。
  const channel = new MessageChannel();
  channel.subscribe('demo/double', (x, next) => {
    next();
    return next();      // ★ 第二次必须炸
  });

  assert.throws(
    () => channel.waterfall('demo/double', 'x', () => '兜底'),
    hasCode('invalid_usage'),
    '★ 重复调用 next() 必须显式抛错，不得静默继续'
  );
});

test('waterfall：缺少兜底函数必须报错（不能"没人收尾"）', () => {
  const channel = new MessageChannel();
  assert.throws(
    () => channel.waterfall('demo/noinner', 'x'),
    hasCode('invalid_argument')
  );
});

// ───────────────────────── 诊断面 ─────────────────────────

test('DispatchMode 导出完整且冻结（供诊断与测试引用）', () => {
  assert.deepEqual(
    Object.keys(DispatchMode).sort(),
    ['EMIT', 'PARALLEL', 'SERIAL', 'WATERFALL']
  );
  assert.throws(() => { DispatchMode.EMIT = 'hacked'; }, TypeError, '枚举必须冻结');
});

// ───────────────────────── 作用域放行规则 ─────────────────────────
// 放行表：
//   "an untagged listener is admitted; a tagged listener is admitted iff its tag
//    is the dispatch key or an ancestor of it; key === undefined admits untagged listeners only."
// 并且方向是：**注册视图向下继承，事件放行向上延伸**。

test('★ 作用域放行：无 tag 监听器一律全局可见', () => {
  const channel = new MessageChannel();
  const seen = [];
  channel.subscribe('demo/s', () => seen.push('untagged'));

  channel.dispatch('emit', 'demo/s', 'agent:a', []);
  channel.dispatch('emit', 'demo/s', undefined, []);

  assert.deepEqual(seen, ['untagged', 'untagged'], '无 tag ⇒ 任何 key 都放行');
});

test('★ 作用域放行：同 key 放行，不同 key 不放行（这就是多 agent 隔离）', () => {
  const channel = new MessageChannel();
  const seen = [];
  channel.subscribe('demo/s', () => seen.push('A'), { scopeLabel: 'agent:a' });

  channel.dispatch('emit', 'demo/s', 'agent:a', []);   // 同 key ✅
  channel.dispatch('emit', 'demo/s', 'agent:b', []);   // 别的 agent ❌

  assert.deepEqual(seen, ['A'], '★ agent A 的监听器只该收到 agent:a 的事件');
});

test('★★ 作用域放行【向上延伸】：祖先 tag 能收后代事件，反之不行', () => {
  // 官方原文："a listener tagged with an ancestor receives a descendant key's events, never the reverse"
  const channel = new MessageChannel();
  channel.declareScope('agent:a', 'preset:p');     // agent:a 的祖先是 preset:p

  const seen = [];
  channel.subscribe('demo/s', () => seen.push('preset-listener'), { scopeLabel: 'preset:p' });
  channel.subscribe('demo/s', () => seen.push('agent-listener'), { scopeLabel: 'agent:a' });

  // 派发给后代 agent:a
  channel.dispatch('emit', 'demo/s', 'agent:a', []);
  assert.deepEqual(
    seen.sort(),
    ['agent-listener', 'preset-listener'],
    '★ 祖先的监听器必须能收到后代的事件'
  );

  // 反向：派发给祖先 preset:p ⇒ 后代 agent:a 的监听器【不该】收到
  seen.length = 0;
  channel.dispatch('emit', 'demo/s', 'preset:p', []);
  assert.deepEqual(seen, ['preset-listener'], '★ 后代监听器不得收到祖先的事件（方向不可逆）');
});

test('★ 作用域放行：派发 key 为 undefined 时【只放行无 tag】的监听器', () => {
  const channel = new MessageChannel();
  const seen = [];
  channel.subscribe('demo/s', () => seen.push('untagged'));
  channel.subscribe('demo/s', () => seen.push('tagged'), { scopeLabel: 'agent:a' });

  channel.dispatch('emit', 'demo/s', undefined, []);

  assert.deepEqual(seen, ['untagged'], '★ 全局派发不得误伤作用域内的监听器');
});

test('declareScope：防环 + 幂等（bindScopeParent 别名已删除）', () => {
  const channel = new MessageChannel();
  channel.declareScope('a', 'p');
  channel.declareScope('a', 'p');   // 幂等
  assert.equal(channel.scopeParentOf('a'), 'p');

  channel.declareScope('b', 'a');
  assert.throws(
    () => channel.declareScope('a', 'b'),
    hasCode('scope_cycle'),
    '★ 成环必须抛错 —— 否则放行的祖先链遍历会死循环'
  );
  assert.throws(() => channel.declareScope('x', 'x'), hasCode('scope_cycle'));
  assert.throws(() => channel.declareScope('', 'p'), hasCode('invalid_argument'));
  // 顶层键也必须入表：parent 传 null 是合法声明（不是"没有关系"）
  const ch2 = new MessageChannel();
  ch2.declareScope('top', null);
  assert.equal(ch2.scopeParentOf('top'), null, '顶层键要留下记录 —— 否则会被第三方追溯挂父级');
  assert.throws(
    () => ch2.declareScope('top', 'someone'),
    hasCode('scope_conflict', /already declared with parent '\(top-level\)'/),
    '★ 已有位置的键不得被改写（含顶层）'
  );
});

test('★ 事件名不惧原型链污染（Cordis issue #50 的同类陷阱）', () => {
  // Cordis 曾有此 bug：`_hooks['__proto__']` 会命中原型而非监听器数组。
  // 本层用 Map 存事件名 ⇒ 天然免疫，但必须有门禁锁住这个性质（防止将来被改成普通对象）。
  const channel = new MessageChannel();
  const seen = [];
  channel.subscribe('__proto__', () => seen.push('proto'));
  channel.subscribe('constructor', () => seen.push('ctor'));

  channel.emit('__proto__');
  channel.emit('constructor');

  assert.deepEqual(seen.sort(), ['ctor', 'proto'], '★ 特殊名字必须当普通事件名处理');
});

// ───────────────────────── 与宿主接线：注册即效果 ─────────────────────────

/** 建一个最小宿主 */
function makeHost() {
  return new CordiumHost();
}

test('★★ 注册即效果：插件卸载后，它注册的监听器【必须自动摘除】', async () => {
  // 这是「插件作者不需要写清理代码」这条承诺的核心断言。
  // 依据 Cordis 官方文档："Event listener: removed automatically on unload"；
  // 其源码 events.ts:288-301 的 ctx.on → register → ctx.effect 即此模式。
  // 若把 host.mjs 里 `scope.addDisposer(off)` 那一行删掉，本断言即变红。
  const host = makeHost();
  const seen = [];

  host.registerPlugin(
    { id: 'plugin.listener', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) { ctx.on('demo/ping', () => seen.push('listener')); } }
  );
  await host.boot();
  const pub = await addPublisher(host);

  assert.equal(listenerCount(host, 'demo/ping'), 1, '激活后监听器应在册');
  pub.emit('demo/ping');
  assert.deepEqual(seen, ['listener'], '激活期间应能收到');

  await host.deactivatePlugin('plugin.listener');

  assert.equal(
    listenerCount(host, 'demo/ping'),
    0,
    '★ 卸载后监听器必须已被自动摘除 —— 插件作者不该需要写任何清理代码'
  );
  pub.emit('demo/ping');
  assert.deepEqual(seen, ['listener'], '卸载后不得再收到任何通知');
});

test('★ 已卸载的 scope 上订阅必须【抛错】，不得静默挂上', async () => {
  // 否则「已卸载的插件还能挂监听器」—— 生命周期边界被击穿，
  // 与 ownerId 那类缺陷同源。
  const host = makeHost();
  let deactivateCtx = null;

  host.registerPlugin(
    { id: 'plugin.leak', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) { deactivateCtx = ctx; } }
  );
  await host.boot();
  await host.deactivatePlugin('plugin.leak');

  assert.throws(
    () => deactivateCtx.on('demo/late', () => {}),
    hasCode('scope_disposed'),
    '★ 停用后不得再订阅 —— 必须抛错而不是静默接受'
  );
  assert.equal(listenerCount(host, 'demo/late'), 0, '★ 且不得留下孤儿监听器');
});

test('★ 登记失败必须回滚订阅：不得留下没人回收的孤儿监听器', async () => {
  // 这是"泄漏最难查"的那种：功能看着正常，只是监听器数慢慢涨。
  const host = makeHost();
  let deadCtx = null;

  host.registerPlugin(
    { id: 'plugin.rollback', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) { deadCtx = ctx; } }
  );
  await host.boot();
  await host.deactivatePlugin('plugin.rollback');

  const before = listenerCount(host, 'demo/rollback');
  try { deadCtx.on('demo/rollback', () => {}); } catch { /* 预期抛错 */ }
  assert.equal(
    listenerCount(host, 'demo/rollback'),
    before,
    '★ 登记进 scope 失败时，订阅必须被回滚 —— 否则是孤儿监听器'
  );
});

test('ctx.once：只触发一次，且触发后自动摘除', async () => {
  const host = makeHost();
  const seen = [];

  host.registerPlugin(
    { id: 'plugin.once', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) { ctx.once('demo/once', (...a) => seen.push(a[0])); } }
  );
  await host.boot();

  const pub = await addPublisher(host);
  pub.emit('demo/once', 1);
  pub.emit('demo/once', 2);

  assert.deepEqual(seen, [1], 'once 只应触发一次');
  assert.equal(listenerCount(host, 'demo/once'), 0, '触发后应自动摘除');
});

test('★ 监听器泄漏守卫：超限时上报审计日志（不抛错、不拒绝注册）', async () => {
  // 依据 Node.js EventEmitter 的 maxListeners 思路 —— 它是**检测器，不是硬限制**。
  // 合法的"挂很多监听器"是可能的，硬拦会误伤；但静默增长会掩盖真泄漏。
  const host = makeHost();
  // ★ channel 私有后不能再调低上限 ⇒ 按默认上限 200 挂 201 个。

  host.registerPlugin(
    { id: 'plugin.flood', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        for (let i = 0; i < 201; i += 1) ctx.on('demo/flood', () => {});
      }
    }
  );
  await host.boot();

  assert.equal(listenerCount(host, 'demo/flood'), 201, '不得拒绝注册');
  assert.ok(
    host.getDiagnostics().recentLogs.some(l => l.message.includes('possible listener leak')),
    '★ 超限必须留下审计记录 —— 否则泄漏是静默的'
  );
});

test('ctx.emit / waterfall 经宿主转发可用（插件之间能真正通信）', async () => {
  const host = makeHost();
  const got = [];

  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0', provides: ['service.a'] },
    { async activate() {} }
  );
  host.registerPlugin(
    { id: 'plugin.b', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        ctx.on('demo/ask', (q, next) => (q === '你好' ? '世界' : next()));
        ctx.on('demo/broadcast', v => got.push(v));
      }
    }
  );
  host.registerPlugin(
    { id: 'plugin.c', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        ctx.emit('demo/broadcast', 'from-c');
        got.push(ctx.waterfall('demo/ask', '你好', () => '兜底'));
        got.push(ctx.waterfall('demo/ask', '未命中', () => '兜底'));
      }
    }
  );

  await host.boot();
  // 拓扑顺序不确定，但 emit 是即时的 —— 用轮询式断言不稳，改为直接再发一次
  (await addPublisher(host)).emit('demo/broadcast', 'after-boot');

  assert.ok(got.includes('from-c'), '广播应送达 b');
  assert.ok(got.includes('after-boot'), '广播应送达 b');
  assert.ok(got.includes('世界'), '★ waterfall 应被 b 拦截并给出回应');
  assert.ok(got.includes('兜底'), '★ 未命中时应走兜底实现');
});

// ───────────────────────── 服务变更广播（internal/service）─────────────────────────

test('★ 服务注册/注销必须通过通道广播（消费者据此重新适配）', async () => {
  // 为什么要广播：消费者若在 activate() 里按当时情况做了决定（缓存、连接、订阅），
  //   提供者变了它无从知晓。广播让它有机会重新适配。
  //   注意本层【只通知、不自动重启】—— 自动重载会随时打断正在跑的工作，
  //   那正是「选主」被删掉的原因。
  const host = makeHost();
  const events = [];
  host.registerPlugin(
    { id: 'plugin.provider', version: '1.0.0', apiVersion: '1.0.0', provides: ['service.demo'] },
    { async activate(ctx) { ctx.provideService('service.demo', { ping: () => 'pong' }); } }
  );
  host.declareServiceContracts({ 'service.demo': { access: 'public' } });
  // ★ channel 私有 ⇒ 经插件公开的 watchService 观察（同一条 internal/service 广播）
  (await addPublisher(host)).watchService('service.demo', e => events.push(e));
  await host.boot();

  assert.deepEqual(
    events,
    [{ name: 'service.demo', providerId: 'plugin.provider', scopeKey: null, action: 'registered', epoch: 1 }],
    '★ 注册必须广播，且载荷只带"够判断"的轻信息'
  );

  await host.deactivatePlugin('plugin.provider');

  assert.deepEqual(
    events[1],
    { name: 'service.demo', providerId: 'plugin.provider', scopeKey: null, action: 'unregistered', epoch: 1 },
    '★ 注销同样必须广播'
  );
});

// ⚠️ 这里曾有「注销【不存在的】提供者不得广播」，**已删除**。
//   它直接调 `host.unregisterService(名, 从未注册的 id)`；私有化后唯一调用方是按 scope 反查的释放路径，
//   只会对【确实登记过】的条目调用 ⇒ 「注销不存在者」从公开 API 构造不出来。`if (had)` 保留为防御纵深。

test('scopeAncestors：从自身沿祖先链向上（含自身），返回只读快照', () => {
  const ch = new MessageChannel();
  ch.ensureScope('team');
  ch.ensureScope('task', 'team');
  ch.ensureScope('step', 'task');
  assert.deepEqual(ch.scopeAncestors('step'), ['step', 'task', 'team']);
  assert.deepEqual(ch.scopeAncestors('team'), ['team'], '顶层键只产出自己');
  assert.deepEqual(ch.scopeAncestors('ghost'), ['ghost'], '未声明的键只产出自己（与 scopeParentOf 返回 undefined 同口径）');
  assert.deepEqual(ch.scopeAncestors(null), [], 'null（全局）没有祖先链');
  const snap = ch.scopeAncestors('step');
  snap.push('evil');
  assert.deepEqual(ch.scopeAncestors('step'), ['step', 'task', 'team'], '返回值是快照，改它不影响树');
});
