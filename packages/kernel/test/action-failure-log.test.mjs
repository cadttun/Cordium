/**
 * ★★ 动作处理器失败进审计 —— 调用方把错误吞掉时，「这个处理器在坏」仍然留得下来。
 *
 * 守的口径（action-registry.mjs 的 dispatch）：
 *   · 处理器抛错 ⇒ 一条 warn 级审计，details 带 outcome='error' / action / ownerId / callerPluginId
 *     以及原始错误的码与位置；错误本身照旧只抛给调用方，形状不变；
 *   · 只记一次（OpenTelemetry 错误记录约定：同一个异常不重复记录）：嵌套派发里只在最先发生的那一层记，
 *     内层已记过的失败（action_failed / 超时 / 拒绝 / 过载）冒到外层不再记；
 *   · warn 不是 error：不进 recentErrors（那 100 槽留给激活失败这类真错误）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, ErrorCode, HOST_CALLER } from '../src/index.mjs';

const m = (id) => ({ id, version: '1.0.0', apiVersion: '1.0.0' });
const logsOf = (host, outcome) => host.getDiagnostics().recentLogs.filter(l => l.details?.outcome === outcome);
const who = l => ({ action: l.details.action, ownerId: l.details.ownerId, callerPluginId: l.details.callerPluginId });

/**
 * 一条嵌套派发链：`layers[0]` 是最内层。第 i 层的插件 `p.l<i>` 注册 `act.l<i>`，
 * 处理器拿到 `inner(name?)` —— 缺省派发第 i-1 层。最外层由宿主派发。
 */
async function chain(layers, setup = () => {}) {
  const host = new CordiumHost();
  setup(host);
  layers.forEach((layer, i) => {
    host.registerPlugin(m(`p.l${i}`), {
      activate(ctx) {
        const inner = (name = `act.l${i - 1}`) => ctx.dispatchAction(name);
        ctx.registerAction(`act.l${i}`, { ...layer.options, handler: () => layer.handler(inner) });
      }
    });
  });
  await host.boot();
  return { host, top: () => host.dispatchActionAsHost(`act.l${layers.length - 1}`) };
}

test('★★ 处理器抛错、调用方把错误吞掉 ⇒ 仍留一条 warn 审计（谁的处理器、谁调的、原始错误在哪一行）', async () => {
  const host = new CordiumHost();
  let callerCtx;
  host.registerPlugin(m('p.owner'), {
    activate(ctx) { ctx.registerAction('act.boom', { handler: () => { throw new Error('boom'); } }); }
  });
  host.registerPlugin(m('p.caller'), { activate(ctx) { callerCtx = ctx; } });
  await host.boot();

  const err = await callerCtx.dispatchAction('act.boom').catch(e => e);
  assert.equal(err.code, ErrorCode.ACTION_FAILED, '★ 错误照旧只给调用方，形状不变');
  assert.equal(err.pluginId, 'p.owner');
  assert.equal(err.cause.message, 'boom');

  const logs = logsOf(host, 'error');
  assert.equal(logs.length, 1);
  const [log] = logs;
  assert.equal(log.level, 'warn');
  assert.deepEqual(who(log), { action: 'act.boom', ownerId: 'p.owner', callerPluginId: 'p.caller' });
  assert.match(log.message, /act\.boom.*p\.owner.*p\.caller.*boom/);
  assert.match(log.details.at, /action-failure-log\.test\.mjs:\d+:\d+$/, '★ 位置指向处理器抛错的那一行，不是内核里记日志的那一行');
  assert.equal(host.getDiagnostics().recentErrors.length, 0, '★ warn 级：不占错误日志的槽位');
});

test('★ 宿主自己派发失败 ⇒ callerPluginId 记 HOST_CALLER', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.owner'), {
    activate(ctx) { ctx.registerAction('act.boom', { handler: () => { throw new Error('boom'); } }); }
  });
  await host.boot();
  await assert.rejects(host.dispatchActionAsHost('act.boom'), { code: ErrorCode.ACTION_FAILED });
  assert.deepEqual(logsOf(host, 'error').map(who), [{ action: 'act.boom', ownerId: 'p.owner', callerPluginId: HOST_CALLER }]);
});

test('★ 原始错误自带的 code 进 details.code —— 读的人据此分出「业务拒绝」与「真坏了」', async () => {
  const host = new CordiumHost();
  host.registerPlugin(m('p.owner'), {
    activate(ctx) {
      ctx.registerAction('act.reject', { handler: () => { throw Object.assign(new Error('bad input'), { code: 'E_VALIDATION' }); } });
    }
  });
  await host.boot();
  await host.dispatchActionAsHost('act.reject').catch(() => {});
  const [log] = logsOf(host, 'error');
  assert.equal(log.details.code, 'E_VALIDATION');
  assert.match(log.message, /\[E_VALIDATION\]/);
});

test('★★ 嵌套派发、外层原样往外抛 ⇒ 只在最先失败的那一层记一次', async () => {
  const { host, top } = await chain([
    { handler: () => { throw new Error('root cause'); } },
    { handler: (inner) => inner() }
  ]);
  const err = await top().catch(e => e);
  assert.equal(err.code, ErrorCode.ACTION_FAILED, '外层调用方照旧收到 action_failed');
  assert.equal(err.cause.cause.message, 'root cause', '原因链完整：外层信封 → 内层信封 → 原始错误');
  assert.deepEqual(logsOf(host, 'error').map(who), [{ action: 'act.l0', ownerId: 'p.l0', callerPluginId: 'p.l1' }]);
});

test('★ 三层链同理：只记最内层', async () => {
  const { host, top } = await chain([
    { handler: () => { throw new Error('deep'); } },
    { handler: (inner) => inner() },
    { handler: (inner) => inner() }
  ]);
  await top().catch(() => {});
  assert.deepEqual(logsOf(host, 'error').map(l => l.details.ownerId), ['p.l0']);
});

test('★ 处理器把内层失败包一层再抛（带 cause）⇒ 仍是同一个失败，只记一次', async () => {
  const { host, top } = await chain([
    { handler: () => { throw new Error('root cause'); } },
    { handler: async (inner) => { try { await inner(); } catch (e) { throw new Error('wrapped', { cause: e }); } } }
  ]);
  await top().catch(() => {});
  assert.deepEqual(logsOf(host, 'error').map(l => l.details.ownerId), ['p.l0']);
});

test('★ 处理器吞掉内层失败、另抛一个不带 cause 的新错误 ⇒ 那是它自己的失败，两层各记一条', async () => {
  const { host, top } = await chain([
    { handler: () => { throw new Error('inner'); } },
    { handler: async (inner) => { await inner().catch(() => {}); throw new Error('outer'); } }
  ]);
  await top().catch(() => {});
  assert.deepEqual(logsOf(host, 'error').map(l => l.details.ownerId), ['p.l0', 'p.l1']);
});

test('★ 内层超时冒到外层 ⇒ 只有内层那条 timeout，外层不补 error', async () => {
  const { host, top } = await chain([
    { options: { timeoutMs: 20 }, handler: () => new Promise(() => {}) },
    { handler: (inner) => inner() }
  ]);
  const err = await top().catch(e => e);
  assert.equal(err.code, ErrorCode.ACTION_FAILED);
  assert.equal(err.cause.code, ErrorCode.ACTION_TIMEOUT);
  assert.deepEqual(logsOf(host, 'timeout').map(who), [{ action: 'act.l0', ownerId: 'p.l0', callerPluginId: 'p.l1' }]);
  assert.equal(logsOf(host, 'error').length, 0);
});

test('★ 内层权限拒绝冒到外层 ⇒ 只有那条 denied，外层不补 error', async () => {
  const { host, top } = await chain([
    { options: { requiredPermission: 'perm.x' }, handler: () => 'never' },
    { handler: (inner) => inner() }
  ], h => h.declarePermissions(['perm.x']));
  const err = await top().catch(e => e);
  assert.equal(err.cause.code, ErrorCode.ACCESS_DENIED);
  const denied = logsOf(host, 'denied');
  assert.deepEqual(denied.map(who), [{ action: 'act.l0', ownerId: 'p.l0', callerPluginId: 'p.l1' }]);
  assert.equal(denied[0].details.requiredPermission, 'perm.x');
  assert.equal(logsOf(host, 'error').length, 0);
});

test('★ 处理器派发了不存在的动作 ⇒ 源头没有处理器可记，由发起它的那一层记一条（码保留）', async () => {
  const { host, top } = await chain([
    { handler: (inner) => inner('act.missing') }
  ]);
  await top().catch(() => {});
  const logs = logsOf(host, 'error');
  assert.deepEqual(logs.map(who), [{ action: 'act.l0', ownerId: 'p.l0', callerPluginId: HOST_CALLER }]);
  assert.equal(logs[0].details.code, ErrorCode.ACTION_NOT_FOUND);
});

test('★ 怪值也照记，且记日志本身不得再抛（字符串 / null / undefined / cause 是抛错的 getter / cause 自环）', async () => {
  const selfCause = new Error('self');
  selfCause.cause = selfCause;
  const throwingCause = new Error('getter');
  Object.defineProperty(throwingCause, 'cause', { get() { throw new Error('no cause for you'); } });
  const odd = { str: 'plain string', nul: null, und: undefined, getter: throwingCause, cycle: selfCause };

  const host = new CordiumHost();
  host.registerPlugin(m('p.odd'), {
    activate(ctx) {
      for (const [name, value] of Object.entries(odd)) ctx.registerAction(`odd.${name}`, { handler: () => { throw value; } });
    }
  });
  await host.boot();
  for (const name of Object.keys(odd)) {
    await assert.rejects(host.dispatchActionAsHost(`odd.${name}`), { code: ErrorCode.ACTION_FAILED });
  }
  assert.deepEqual(logsOf(host, 'error').map(l => l.details.action), Object.keys(odd).map(n => `odd.${n}`));
});

test('★★ 递归风暴：过载只在最深一层记一次（限频），冒出来的几十层 action_failed 一条都不记', async () => {
  const host = new CordiumHost({ maxInFlightActions: 50 });
  host.registerPlugin(m('p.rec'), {
    activate(ctx) { ctx.registerAction('act.rec', { handler: () => ctx.dispatchAction('act.rec') }); }
  });
  await host.boot();
  const err = await host.dispatchActionAsHost('act.rec').catch(e => e);
  assert.equal(err.code, ErrorCode.ACTION_FAILED);
  const overloaded = logsOf(host, 'overloaded');
  assert.equal(overloaded.length, 1);
  assert.deepEqual(who(overloaded[0]), { action: 'act.rec', ownerId: 'p.rec', callerPluginId: 'p.rec' });
  assert.equal(logsOf(host, 'error').length, 0);
});
