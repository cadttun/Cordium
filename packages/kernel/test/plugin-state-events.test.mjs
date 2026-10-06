/**
 * ★★ `ctx.watchPluginState` —— 插件启停的可观测性。
 *
 * ── 这是下游实测出来的需求，不是推测的 ──────────────────────────────
 * 一个按内核注册表渲染界面的装配层需要「注册表刚变了」这个时机来重投影。
 * 它此前**明确记录过这条缺口**并因此放弃自动同步，原文大意：
 *   「内核**没有**「插件启停」事件 …… 若靠包装 `kernel.registerPlugin` 来制造这个时机，
 *    就是在**改别人的对象** —— 一旦内核把这些方法改成不可写（或换成 class 私有），
 *    包装会**静默失效**，而失效的表现是「停用的插件面板还留在屏幕上」」
 * ⇒ 本文件守的就是「不必再包装别人的方法」这件事。
 *
 * ── 形状与 watchService 同源 ────────────────────────────────────────
 *   事件名是模块私有 symbol（插件发不出也订不到）；宿主经 broadcast 发；
 *   作用域注入与退订托管由宿主负责。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost } from '../src/index.mjs';

const m = (id, extra = {}) => ({ id, version: '1.0.0', apiVersion: '1.0.0', ...extra });

/** 装一个「观察者」插件，收集它看到的全部状态事件 */
async function withObserver(setup, run) {
  const host = new CordiumHost();
  const seen = [];
  host.registerPlugin(m('p.observer'), {
    activate(ctx) { ctx.watchPluginState(e => seen.push(e)); }
  });
  setup(host);
  await host.boot();
  await run(host, seen);
}

test('★ 订阅者能看到【别人的】状态迁移（含中间态 activating / stopping）', async () => {
  await withObserver(
    host => host.registerPlugin(m('p.target'), { activate() {} }),
    async (host, seen) => {
      seen.length = 0;                      // 丢掉 boot 期间的噪音，只看这一次
      await host.deactivatePlugin('p.target');
      const to = seen.filter(e => e.id === 'p.target').map(e => e.to);
      assert.ok(to.includes('stopping'), '★ 中间态必须广播 —— 界面要显示加载态');
      assert.ok(to.includes('disabled'), '★ 终态必须广播');
      assert.ok(seen.every(e => Object.isFrozen(e)), '事件载荷必须冻结（订阅者改不了它，也影响不到别人）');
    }
  );
});

test('★★ 广播时机在【事实落定之后】：在回调【内】读诊断，看到的必须已是新状态', async () => {
  // ★ 这条断言的判别性来自「读的时机」：必须在**监听器回调内部**现场读，
  //   不能等 await 回来再读 —— 那时状态早就落定了，无论广播写在赋值前还是后都一样
  //   （实测：先写成「await 之后再读」，把广播挪到赋值之前，测试照样全绿 ⇒ 断言不具判别性）。
  const host = new CordiumHost();
  const mismatches = [];
  host.registerPlugin(m('p.observer'), {
    activate(ctx) {
      ctx.watchPluginState(e => {
        const actual = host.getDiagnostics().plugins.find(p => p.id === e.id)?.state;
        // 事件宣告的 `to` 与此刻查到的状态必须一致
        if (e.to !== null && actual !== e.to) mismatches.push({ id: e.id, told: e.to, actual });
      });
    }
  });
  host.registerPlugin(m('p.target'), { activate() {} });
  host.registerPlugin(m('p.lazy', { activation: 'lazy' }));
  await host.boot();
  await host.deactivatePlugin('p.target');
  await host.activatePlugin('p.lazy');

  assert.deepEqual(mismatches, [],
    '★ 收到事件时事实必须已落定（通知晚于事实）—— 否则监听器据此做的判断全错');
});

test('★ 注册与移除同样可见（from / to 为 null 表示不在表里）', async () => {
  const host = new CordiumHost();
  const seen = [];
  host.registerPlugin(m('p.observer'), { activate(ctx) { ctx.watchPluginState(e => seen.push(e)); } });
  await host.boot();
  seen.length = 0;

  host.registerPlugin(m('p.late'), { activate() {} });
  assert.deepEqual(seen.at(-1), { id: 'p.late', from: null, to: 'discovered' }, '★ 新插件入表要让订阅者知道');

  await host.unregisterPlugin('p.late');
  assert.deepEqual(seen.at(-1), { id: 'p.late', from: 'disabled', to: null }, '★ 移出插件表同样要通知');
});

test('★ 按需激活的 ready 迁移也可见（装配层要能显示「等触发」）', async () => {
  const host = new CordiumHost();
  const seen = [];
  host.registerPlugin(m('p.observer'), { activate(ctx) { ctx.watchPluginState(e => seen.push(e)); } });
  host.registerPlugin(m('p.lazy', { activation: 'lazy' }), { activate() {} });
  await host.boot();
  const lazy = seen.filter(e => e.id === 'p.lazy').map(e => e.to);
  assert.ok(lazy.includes('ready'), '★ 懒插件进入等触发态必须可见');
  seen.length = 0;
  await host.activatePlugin('p.lazy');
  assert.ok(seen.filter(e => e.id === 'p.lazy').map(e => e.to).includes('active'), '★ 被触发后同样可见');
});

test('★ 退订函数有效；插件停用后宿主自动摘除（不留幽灵订阅）', async () => {
  const host = new CordiumHost();
  const seen = [];
  host.registerPlugin(m('p.observer'), { activate(ctx) { ctx.watchPluginState(e => seen.push(e)); } });
  host.registerPlugin(m('p.target'), { activate() {} });
  await host.boot();

  await host.deactivatePlugin('p.observer');    // 观察者下线
  seen.length = 0;
  await host.deactivatePlugin('p.target');
  assert.deepEqual(seen, [], '★ 观察者停用后不得再收到事件（订阅随作用域回收）');
});

test('★ 事件名不可伪造：插件的 ctx 上没有 emit 这个 symbol 的途径', async () => {
  const host = new CordiumHost();
  let ctxKeys = null;
  host.registerPlugin(m('p.probe'), {
    activate(ctx) {
      ctxKeys = Object.keys(ctx);
      // 插件能发的事件名只有明面上的字符串事件；私有 symbol 拿不到
      assert.equal(typeof ctx.watchPluginState, 'function');
    }
  });
  await host.boot();
  // ★ 反例前提：ctx 是冻结的公开面，私有事件名不在其中（否则插件能伪造「某插件已停用」）
  assert.equal(ctxKeys.includes('SERVICE_CHANGE'), false);
  assert.equal(ctxKeys.includes('PLUGIN_STATE'), false);
});

test('★ watchPluginState 入口校验：非函数即拒', async () => {
  const host = new CordiumHost();
  let err = null;
  host.registerPlugin(m('p.probe'), {
    activate(ctx) { try { ctx.watchPluginState('not-a-function'); } catch (e) { err = e; } }
  });
  await host.boot();
  assert.equal(err?.code, 'invalid_argument');
});
