/**
 * @file packages/kernel/test/host-events.test.mjs
 * @description ★★ 装配层事件入口 `host.events` 的门禁。
 *
 * ── 治的病 ──────────────────────────────────────────────────────────
 *   把 `#channel` 私有化的那次改动（本意：**不让插件绕过作用域隔离**）关掉了装配层的入口，
 *   但**装配层不是插件** —— 它没有 ctx，却合法地需要「以根作用域发布 / 订阅」。
 *   私有化把这一格一并关掉了 ⇒ 消费方读 `host.channel` 得 `undefined`
 *   ⇒ 事件端口恒为 `null` ⇒ 整条事件机制在产线**静默失效**。
 *
 * ── 本门禁守什么（判据全为【运行时】）─────────────────────────────────
 *   ① 形状：`host.events` 只有 emit / waterfall / subscribe 三件，且冻结
 *   ② emit 是【根作用域】语义 —— 根 ctx 插件收得到，**作用域**插件的标签监听器收不到
 *      （★ 判别性对照：证明它是「根派发」而非「广播」）
 *   ③ waterfall 走中间件：插件可变换，兜底收到变换后的值；无监听器 ⇒ 兜底收原参
 *   ④ subscribe 是无标签监听器：插件的根 emit 收得到，**作用域** emit 也收得到（放行表语义）
 *   ⑤ 退订函数真的摘掉监听器
 *   ⑥ name 非字符串 ⇒ invalid_argument（与宿主其余公开方法同一道入口门）
 *   ⑦ 监听器出错时归属记 `HOST_CALLER`（审计认得出是宿主自己挂的）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, HOST_CALLER, ErrorCode } from '../src/index.mjs';

test('★ host.events 形状：只有 emit / waterfall / subscribe，且冻结', () => {
  const host = new CordiumHost();
  assert.deepEqual(Object.keys(host.events).sort(), ['emit', 'subscribe', 'waterfall']);
  assert.ok(Object.isFrozen(host.events), '装配层入口必须冻结（宿主交出去的一切不可变）');
});

test('★ emit 是【根作用域】派发：根 ctx 插件收得到，作用域标签监听器收不到', async () => {
  const host = new CordiumHost();
  const rootSeen = [];
  let scopedSeen = 0;
  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0' },
    {
      activate(ctx) {
        ctx.on('brain/status', payload => rootSeen.push(payload));          // 根：无标签
        ctx.scoped('agent').on('brain/status', () => { scopedSeen += 1; }); // 作用域：有标签
      }
    }
  );
  await host.boot();

  host.events.emit('brain/status', { phase: 'thinking' });
  assert.deepEqual(rootSeen, [{ phase: 'thinking' }], '根 ctx 的无标签监听器必须收得到');
  assert.equal(scopedSeen, 0, '★ 判别性对照：作用域标签的监听器【不得】收到根派发（否则是广播，不是根派发）');
});

test('★ waterfall 走中间件：插件变换 → 兜底收变换后的值', async () => {
  const host = new CordiumHost();
  host.registerPlugin(
    { id: 'plugin.mw', version: '1.0.0', apiVersion: '1.0.0' },
    { activate(ctx) { ctx.on('brain/pre', (entry, next) => next({ ...entry, n: entry.n + 1 })); } }
  );
  await host.boot();

  const out = host.events.waterfall('brain/pre', { n: 1 }, e => e);
  assert.equal(out.n, 2, '兜底必须收到监听器变换后的值');
});

test('★ waterfall 无监听器 ⇒ 兜底收到【原参数】（透传，非空值）', async () => {
  const host = new CordiumHost();
  await host.boot();
  assert.equal(host.events.waterfall('nobody/listens', 21, x => x * 2), 42);
});

test('★ subscribe 是无标签监听器：插件的根 emit 与作用域 emit 都收得到', async () => {
  const host = new CordiumHost();
  const got = [];
  host.events.subscribe('brain/status', payload => got.push(payload));
  host.registerPlugin(
    { id: 'plugin.emit', version: '1.0.0', apiVersion: '1.0.0' },
    {
      activate(ctx) {
        ctx.emit('brain/status', { from: 'root' });
        ctx.scoped('agent').emit('brain/status', { from: 'scoped' });
      }
    }
  );
  await host.boot();
  assert.deepEqual(got, [{ from: 'root' }, { from: 'scoped' }],
    '无标签监听器按放行表应收到任何派发键的事件（装配层=全局观察者）');
});

test('★ subscribe 返回的退订函数真的摘掉监听器', async () => {
  const host = new CordiumHost();
  const got = [];
  const off = host.events.subscribe('brain/status', payload => got.push(payload));
  assert.equal(off(), true, '首次退订应返回 true');
  assert.equal(off(), false, '重复退订应返回 false（幂等）');
  host.events.emit('brain/status', { after: 'off' });
  assert.deepEqual(got, [], '退订后不得再收到事件');
});

test('★ name 非字符串 ⇒ invalid_argument（入口门，不让它流进通道炸成裸 TypeError）', () => {
  const host = new CordiumHost();
  const isInvalidArg = err => err.code === ErrorCode.INVALID_ARGUMENT;
  assert.throws(() => host.events.emit(123, {}), isInvalidArg, 'emit');
  assert.throws(() => host.events.waterfall(null, () => {}), isInvalidArg, 'waterfall');
  assert.throws(() => host.events.subscribe({}, () => {}), isInvalidArg, 'subscribe');
});

test('★ 监听器出错归属记 HOST_CALLER：审计认得出是宿主自己挂的', () => {
  const host = new CordiumHost();
  host.events.subscribe('brain/status', () => { throw new Error('boom'); });
  host.events.emit('brain/status', {});
  const hit = host.getDiagnostics().recentLogs.some(l => l.message.includes(`'${HOST_CALLER}'`));
  assert.ok(hit, `监听器出错必须带 owner='${HOST_CALLER}' 进审计（实际日志：`
    + JSON.stringify(host.getDiagnostics().recentLogs.map(l => l.message)) + '）');
});
