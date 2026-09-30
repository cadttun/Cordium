// 插件动作执行上限回归测试（⚠️ 只是超时，不是隔离）
//
// 缺陷背景：dispatchAction 此前只有权限校验（"能不能调用"），
// 没有执行上限（"会不会把宿主拖死"）。第三方插件处理器若永不 resolve
// ——死循环 await、外部依赖挂起——dispatchAction 就永久挂起，连带卡住调用方。
//
// 修复：给每个动作加执行上限，超时以明确错误返回（而非静默）。
// 这与 packages/plugins/src/ecosystem.mjs 的 callWithTimeout 是同一能力，
// 现已在生产路径（Kernel Host）落地，不再只是零引用的遗留模块。
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost } from '../src/host.mjs';

const PLUGIN_ID = 'plugin.demo';

/** 注册一个业务插件，并在其 activate 中注册若干动作。 */
async function makeHostWith(actions, options = {}) {
  const host = new CordiumHost(options);
  host.declarePermissions(['knowledge.write']);   // ★ 权限名须由宿主登记
  host.registerPlugin({
    id: PLUGIN_ID,
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: []
  }, {
    activate(ctx) {
      for (const [name, spec] of Object.entries(actions)) {
        ctx.registerAction(name, { handler: spec.handler, requiredPermission: spec.requiredPermission });
      }
    }
  });
  await host.boot();
  return host;
}

test('正常动作照常返回', async () => {
  const host = await makeHostWith({
    'demo.echo': { handler: payload => `echo:${payload}` }
  });
  assert.equal(await host.dispatchAction(PLUGIN_ID, 'demo.echo', 'hi'), 'echo:hi');
});

test('永不 resolve 的动作必须超时失败，不得永久挂起', async () => {
  const host = await makeHostWith(
    { 'demo.hang': { handler: () => new Promise(() => {}) } },
    { actionTimeoutMs: 60 }
  );

  const started = Date.now();
  await assert.rejects(
    () => host.dispatchAction(PLUGIN_ID, 'demo.hang'),
    hasCode('action_timeout'),
    '挂起的处理器必须以超时错误返回'
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `超时应在设定时限附近生效（实际 ${elapsed}ms）`);
});

test('处理器抛错 ⇒ action_failed 信封（原错误原样在 cause），不被超时机制掩盖', async () => {
  const host = await makeHostWith(
    { 'demo.boom': { handler: () => { throw new Error('业务错误：数据非法'); } } },
    { actionTimeoutMs: 1000 }
  );

  await assert.rejects(
    () => host.dispatchAction(PLUGIN_ID, 'demo.boom'),
    err => hasCode('action_failed')(err) && err.cause instanceof Error && err.cause.message === '业务错误：数据非法',
    '真实业务错误必须带码送达、原错误在 cause，不能被包装成超时'
  );
});

test('异步 reject 同样套 action_failed 信封，原错误在 cause', async () => {
  const host = await makeHostWith(
    { 'demo.reject': { handler: async () => { throw new Error('异步失败'); } } },
    { actionTimeoutMs: 1000 }
  );
  await assert.rejects(() => host.dispatchAction(PLUGIN_ID, 'demo.reject'),
    err => hasCode('action_failed')(err) && err.cause?.message === '异步失败');
});

test('权限不足仍优先于执行（不得因加了超时而放松鉴权）', async () => {
  const host = await makeHostWith(
    { 'demo.secret': { handler: () => 'secret', requiredPermission: 'knowledge.write' } },
    { actionTimeoutMs: 1000 }
  );

  await assert.rejects(
    () => host.dispatchAction(PLUGIN_ID, 'demo.secret'),
    hasCode('access_denied'),
    '鉴权必须仍然生效'
  );
});

test('已完成的慢动作若在上限内返回，不应被误判为超时', async () => {
  const host = await makeHostWith(
    {
      'demo.slow': {
        handler: async () => {
          await new Promise(resolve => setTimeout(resolve, 30));
          return 'done';
        }
      }
    },
    { actionTimeoutMs: 500 }
  );

  assert.equal(await host.dispatchAction(PLUGIN_ID, 'demo.slow'), 'done');
});

test('actionTimeoutMs 为 0 表示不限制（显式选择退出隔离）', async () => {
  const host = await makeHostWith(
    {
      'demo.unbounded': {
        handler: async () => {
          await new Promise(resolve => setTimeout(resolve, 60));
          return 'completed';
        }
      }
    },
    { actionTimeoutMs: 0 }
  );

  assert.equal(await host.dispatchAction(PLUGIN_ID, 'demo.unbounded'), 'completed');
});

test('默认上限为非零有限值（缺省即受保护）', async () => {
  const host = new CordiumHost();
  assert.ok(
    Number.isFinite(host.defaultActionTimeoutMs) && host.defaultActionTimeoutMs > 0,
    '默认必须有执行上限——否则"忘了配"就等于没有隔离'
  );
});

// ── 超时取值边界：> 2³¹-1 会被 Node 静默改成 1ms ⇒ 每次立即超时 ──

test('宿主 actionTimeoutMs 超过定时器上限 / Infinity ⇒ invalid_option（不再静默变 1ms 或回退默认）', () => {
  for (const bad of [2 ** 31, 1e12, Infinity, 'abc', NaN]) {
    assert.throws(() => new CordiumHost({ actionTimeoutMs: bad }), hasCode('invalid_option'), String(bad));
  }
  assert.equal(new CordiumHost({ actionTimeoutMs: 2 ** 31 - 1 }).defaultActionTimeoutMs, 2 ** 31 - 1);
  assert.equal(new CordiumHost({ actionTimeoutMs: -1 }).defaultActionTimeoutMs, -1, '负数 = 不限，原样保留');
});

test('单条 registerAction 的 timeoutMs 非法 ⇒ invalid_argument（此前静默回退宿主默认值）', async () => {
  for (const bad of [0, -5, NaN, Infinity, 2 ** 31, '100']) {
    const host = new CordiumHost();
    let caught = null;
    host.registerPlugin({ id: PLUGIN_ID, version: '1.0.0', apiVersion: '1.0.0' }, {
      activate(ctx) {
        try { ctx.registerAction('demo.bad', { handler: () => 1, timeoutMs: bad }); } catch (err) { caught = err; }
      }
    });
    await host.boot();
    assert.equal(caught?.code, 'invalid_argument', `timeoutMs=${String(bad)}`);
    await assert.rejects(host.dispatchAction(PLUGIN_ID, 'demo.bad'), hasCode('action_not_found'));
  }
});
