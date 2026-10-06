/**
 * ★★ `activate(ctx, config)` 的第二参**只有一种形状**。
 *
 * 缺陷背景（实测，照抄插件指南 §1 即崩）：
 *   · `loadPlugins` 路径经 `entry.mjs` 的 `hostEntry` 传一个**已冻结的对象**；
 *   · `registerPlugin` 路径此前**完全不传第二参** ⇒ `config === undefined`。
 *   ⇒ 同一接口两种形状。照抄指南 §1 的 `activate(ctx, config) { let n = config.start ?? 0 }` 会抛
 *     **裸 `TypeError`**（`instanceof CordiumError === false`、`err.code === undefined`），
 *     而指南 §9 承诺「宿主抛出的一律是 `CordiumError`」⇒ 作者按文档写的 catch 分支接不住。
 *
 * ★ 修法与依据：第二参**一律**传 —— 没有配置时传 `{}`（冻结单例）。
 *   依据是**语言规范**而非偏好：`function activate(ctx, config = {})` 的默认参数
 *   在【传 undefined】时同样生效 ⇒ `(ctx, undefined)` 与 `(ctx, {})` 对任何遵循语言约定的
 *   插件**逐字等价**；受影响的只有「假定第二参一定存在」的写法 —— 而那正是会崩的写法。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost } from '../src/index.mjs';

const manifest = id => ({ id, version: '1.0.0', apiVersion: '1.0.0' });

/** 注册一个插件、boot、返回它 activate 收到的第二参 */
async function captureConfig(entry) {
  let received = Symbol('not-called');
  const host = new CordiumHost();
  host.registerPlugin(manifest('p.probe'), { activate: (ctx, config) => { received = config; } , ...entry });
  await host.boot();
  return received;
}

test('★ registerPlugin 路径：没配置时第二参是 {}，不是 undefined', async () => {
  const received = await captureConfig({});
  assert.notEqual(received, undefined, '★ 第二参不得是 undefined —— 那正是照抄指南即崩的原因');
  assert.deepEqual(received, {}, '没配置时必须是空对象');
});

test('★ 指南 §1 的示例照抄即可运行（本用例就是那段代码）', async () => {
  // 逐字复刻插件指南 §1 的写法，只把「插件注册」换成内核路径：
  //   export function activate(ctx, config) { let n = config.start ?? 0; … }
  let n = -1;
  const host = new CordiumHost();
  host.declareServiceContracts({ counter: { access: 'public' } });
  host.registerPlugin({ ...manifest('demo.counter'), provides: ['counter'] }, {
    activate(ctx, config) {
      n = config.start ?? 0;                       // ★ 此前这里抛裸 TypeError
      ctx.provideService('counter', { current: () => n });
    }
  });
  await host.boot();
  assert.equal(n, 0, '★ 照抄指南必须跑得起来');
  assert.equal(host.getInternalService('counter').current(), 0);
});

test('★ 交付的 config 是【冻结】的，插件改不动它', async () => {
  const received = await captureConfig({});
  assert.ok(Object.isFrozen(received), '★ 冻结 —— 它是共享单例，改它会串给所有插件');
  assert.throws(() => { 'use strict'; received.injected = 'nope'; }, TypeError, '严格模式下写入必须失败');
  assert.equal(received.injected, undefined);
});

test('★ 传了 entry.config 时原样交付（registerPlugin 路径同样尊重它）', async () => {
  const cfg = Object.freeze({ start: 7 });
  const host = new CordiumHost();
  let received;
  host.registerPlugin(manifest('p.withcfg'), { config: cfg, activate(ctx, c) { received = c; } });
  await host.boot();
  assert.equal(received, cfg, '有配置时交付的就是它（不凭空再造一份）');
  assert.equal(received.start, 7);
});
