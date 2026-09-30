/**
 * @file packages/kernel/test/scope-isolation-service.test.mjs
 * @description 作用域隔离的门禁 —— 服务侧与信息侧
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────
 * 「选主」被删掉之后，一个服务名在全局只能有一个实现。而多 agent 协作需要的恰恰是
 * **同一个服务名，在不同 agent 手里是不同实现**（各自的工作流、各自的模型、各自的工具集）。
 * 作用域隔离就是那个替代方案：
 *
 *   服务侧 —— 同名服务的实现按作用域分槽；解析先走调用方作用域链（就近优先），
 *             链上没有才回退全局。⇒ 全局是兜底，作用域实现绝不外泄。
 *   信息侧 —— 订阅按作用域打标签，派发按调用方作用域放行。
 *             **注册视图向下继承，事件放行向上延伸**。
 *
 * ── 三条必须锁死的性质 ────────────────────────────────────────────
 *   ① **隔离是双向的** —— 既要验「别的作用域看不见我」，也要验「我该看见的看得见」。
 *      只验单向会把「干脆什么都取不到」误判成隔离生效。
 *   ② **默认路径零行为变更** —— 不带作用域的调用必须与改造前完全一致。
 *   ③ **归属判据不可伪造** —— 作用域键只能由宿主闭包注入，不是插件能传的参数。
 *
 * ★ 每条测试都要能判别它守护的那段新代码 —— 删掉对应实现必须变红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost, MessageChannel } from '../src/index.mjs';
import { scopeParentOf } from './fixtures/inspect.mjs';

const SERVICE = 'service.store';

function makeHost() {
  const host = new CordiumHost();
  host.declareServiceContracts({ [SERVICE]: { access: 'public' } });
  return host;
}

/** 造一个「在指定作用域提供实现」的提供者插件 */
function provider(id, tag, scopeLabel) {
  return {
    manifest: { id, version: '1.0.0', apiVersion: '1.0.0', provides: [SERVICE] },
    entry: {
      async activate(ctx) {
        const target = scopeLabel === null ? ctx : ctx.scoped(scopeLabel);
        target.provideService(SERVICE, { who: () => tag });
      }
    }
  };
}

/** 注册一个消费者；dependencies 保证它一定在提供者之后激活 */
function consumer(id, deps, body) {
  return {
    manifest: {
      id,
      version: '1.0.0',
      apiVersion: '1.0.0',
      dependencies: Object.fromEntries(deps.map(d => [d, '^1.0.0']))
    },
    entry: { async activate(ctx) { body(ctx); } }
  };
}

/** 造一个「只为跑一段 activate」的插件（依赖用 dependencies 钉死激活顺序） */
function bare(id, body, deps = []) {
  return {
    manifest: {
      id,
      version: '1.0.0',
      apiVersion: '1.0.0',
      dependencies: Object.fromEntries(deps.map(d => [d, '^1.0.0']))
    },
    entry: { async activate(ctx) { body(ctx); } }
  };
}

/** 取服务，失败时把错误信息当值返回 —— 免得每个用例都写一遍 try/catch */
function probe(getter) {
  try {
    return getter();
  } catch (error) {
    return { error: error.message, code: error.code };
  }
}

// ═══════════════════════════ 服务侧：隔离 ═══════════════════════════

test('★ 两个作用域各自提供同名服务，互不可见（隔离的根本承诺）', async () => {
  const host = makeHost();
  const got = {};

  for (const p of [provider('plugin.a', 'A', 'agent:a'), provider('plugin.b', 'B', 'agent:b')]) {
    host.registerPlugin(p.manifest, p.entry);
  }

  const c = consumer('plugin.consumer', ['plugin.a', 'plugin.b'], ctx => {
    got.a = probe(() => ctx.scoped('agent:a').getService(SERVICE));
    got.b = probe(() => ctx.scoped('agent:b').getService(SERVICE));
    got.global = probe(() => ctx.getService(SERVICE));
  });
  host.registerPlugin(c.manifest, c.entry);

  await host.boot();

  assert.equal(got.a.who(), 'A', 'agent:a 必须拿到 A 的实现');
  assert.equal(got.b.who(), 'B', 'agent:b 必须拿到 B 的实现 —— 双向都要验，否则「都取不到」会伪装成隔离成功');
  assert.equal(got.global.code, 'no_provider',
    '★ 无作用域调用【不得】拿到任何作用域实现 —— 否则隔离形同虚设'
  );
});

test('★ 就近优先：作用域实现压过全局实现，且全局不被污染', async () => {
  const host = makeHost();
  const got = {};

  host.registerPlugin(provider('plugin.global', 'GLOBAL', null).manifest, provider('plugin.global', 'GLOBAL', null).entry);
  const a = provider('plugin.a', 'A', 'agent:a');
  host.registerPlugin(a.manifest, a.entry);

  const c = consumer('plugin.consumer', ['plugin.global', 'plugin.a'], ctx => {
    got.scoped = ctx.scoped('agent:a').getService(SERVICE);
    got.global = ctx.getService(SERVICE);
    // 另一个作用域没有任何实现 ⇒ 回退全局，而不是"什么都没有"
    got.other = probe(() => ctx.scoped('agent:other').getService(SERVICE));
  });
  host.registerPlugin(c.manifest, c.entry);
  await host.boot();

  assert.equal(got.scoped.who(), 'A', '作用域里有实现时必须就近命中');
  assert.equal(got.global.who(), 'GLOBAL', '★ 全局消费者不得被作用域实现串味');
  assert.equal(got.other.who(), 'GLOBAL', '★ 无关作用域回退全局 —— 这是"双向验证"的另一半');
});

test('★ 作用域沿【祖先链】解析：子作用域继承父作用域的层，链外拿不到', async () => {
  const host = makeHost();
  const got = {};

  const p = provider('plugin.p', 'PARENT', 'agent');
  host.registerPlugin(p.manifest, p.entry);

  const c = consumer('plugin.consumer', ['plugin.p'], ctx => {
    got.child = probe(() => ctx.scoped('agent').scoped('agent:child').getService(SERVICE));
    got.sibling = probe(() => ctx.scoped('agent:other').getService(SERVICE));
  });
  host.registerPlugin(c.manifest, c.entry);
  await host.boot();

  assert.equal(got.child.who(), 'PARENT', '★ 子作用域要能看到祖先的层（注册视图向下继承）');
  assert.equal(got.sibling.code, 'no_provider', '★ 但不是随便什么作用域都能蹭到');
});

test('★ 一个作用域停用，不得摘除另一个作用域的实现（跨作用域互不误伤）', async () => {
  const host = makeHost();
  const got = {};

  const a = provider('plugin.a', 'A', 'agent:a');
  const b = provider('plugin.b', 'B', 'agent:b');
  host.registerPlugin(a.manifest, a.entry);
  host.registerPlugin(b.manifest, b.entry);

  // ★ 只依赖 b（仍排在两者之后，a 先于 b 注册）。若也依赖 a，
  //   级联停用会在停 a 时连带停掉消费者本身，测不到「B 不受牵连」。
  const c = consumer('plugin.consumer', ['plugin.b'], ctx => {
    got.b = () => probe(() => ctx.scoped('agent:b').getService(SERVICE));
    got.a = () => probe(() => ctx.scoped('agent:a').getService(SERVICE));
  });
  host.registerPlugin(c.manifest, c.entry);
  await host.boot();

  assert.equal(got.b().who(), 'B');

  await host.deactivatePlugin('plugin.a');

  assert.equal(got.b().who(), 'B', '★ 停用 A 不得牵连 B —— 这正是「按 scope 对象身份反查」要保证的');
  assert.equal(got.a().code, 'no_provider', 'A 自己那份必须被摘干净（不是残留成幽灵）');
});

test('★ 同一个作用域内撞名【仍然拒绝】—— 隔离没有放松「一个 owner」', async () => {
  const host = makeHost();
  let violation = null;

  const a = provider('plugin.a', 'A', 'agent:a');
  host.registerPlugin(a.manifest, a.entry);

  const b = {
    manifest: { id: 'plugin.b', version: '1.0.0', apiVersion: '1.0.0', provides: [SERVICE] },
    entry: {
      async activate(ctx) {
        try {
          ctx.scoped('agent:a').provideService(SERVICE, { who: () => 'B' });
        } catch (error) {
          violation = error.message;
        }
      }
    }
  };
  host.registerPlugin(b.manifest, b.entry);
  await host.boot();

  assert.match(violation ?? '', /already provided by plugin 'plugin\.a' in scope 'agent:a'/,
    '★ 作用域实现也必须走同一个撞名检查 —— 否则它就成了绕开「一个 owner」的后门');
});

test('★ 同一插件可以在不同作用域各提供一份实现（不触发撞名误报）', async () => {
  // 回归：桶的键是 providerId，若两处共用一个桶，第二份会被误判成撞名。
  const host = makeHost();
  const got = {};

  const m = {
    manifest: { id: 'plugin.multi', version: '1.0.0', apiVersion: '1.0.0', provides: [SERVICE] },
    entry: {
      async activate(ctx) {
        ctx.scoped('agent:a').provideService(SERVICE, { who: () => 'A' });
        ctx.scoped('agent:b').provideService(SERVICE, { who: () => 'B' });
      }
    }
  };
  host.registerPlugin(m.manifest, m.entry);
  const c = consumer('plugin.consumer', ['plugin.multi'], ctx => {
    got.a = ctx.scoped('agent:a').getService(SERVICE);
    got.b = ctx.scoped('agent:b').getService(SERVICE);
  });
  host.registerPlugin(c.manifest, c.entry);
  await host.boot();

  assert.equal(got.a.who(), 'A');
  assert.equal(got.b.who(), 'B', '同一个插件的两份作用域实现必须各归各的桶');
});

test('★ 作用域实现的句柄同样会失效（生命周期一致，不因作用域而豁免）', async () => {
  const host = makeHost();
  const captured = {};

  const a = provider('plugin.a', 'A', 'agent:a');
  host.registerPlugin(a.manifest, a.entry);
  const c = consumer('plugin.consumer', ['plugin.a'], ctx => {
    captured.handle = ctx.scoped('agent:a').getService(SERVICE);
  });
  host.registerPlugin(c.manifest, c.entry);
  await host.boot();

  assert.equal(captured.handle.who(), 'A');
  await host.deactivatePlugin('plugin.a');

  assert.throws(
    () => captured.handle.who(),
    err => err.code === 'service_unavailable' && /was unregistered/.test(err.message),
    '★ 停用后旧句柄必须报 service_unavailable —— 作用域实现不得成为生命周期检查的盲区'
  );
});

test('★ 作用域实现也受 declared 门禁约束：要声明【解析到的那一个】提供者的依赖', async () => {
  const host = new CordiumHost();
  host.declareServiceContracts({ [SERVICE]: { access: 'declared' } });
  const got = {};

  const g = {
    manifest: { id: 'plugin.global', version: '1.0.0', apiVersion: '1.0.0', provides: [SERVICE] },
    entry: { async activate(ctx) { ctx.provideService(SERVICE, { who: () => 'GLOBAL' }); } }
  };
  host.registerPlugin(g.manifest, g.entry);

  const a = provider('plugin.a', 'A', 'agent:a');
  host.registerPlugin(a.manifest, a.entry);

  // 只声明对 plugin.a 的依赖 —— 于是作用域内合法、全局非法
  const c = consumer('plugin.consumer', ['plugin.a'], ctx => {
    got.scoped = probe(() => ctx.scoped('agent:a').getService(SERVICE));
    got.global = probe(() => ctx.getService(SERVICE));
  });
  host.registerPlugin(c.manifest, c.entry);
  await host.boot();

  assert.equal(got.scoped.who(), 'A', '声明了作用域提供者 ⇒ 作用域内应当放行');
  assert.equal(got.global.code, 'access_denied');
  assert.match(
    got.global.error ?? '',
    /did not declare a dependency on provider 'plugin\.global'/,
    '★ 门禁必须查【真正会服务你的那个提供者】：查全局槽会把作用域调用方误判成未声明依赖'
  );
});

test('getInternalService 支持按作用域取实现（装配代码用）', async () => {
  const host = makeHost();
  host.registerPlugin(provider('plugin.global', 'GLOBAL', null).manifest, provider('plugin.global', 'GLOBAL', null).entry);
  const a = provider('plugin.a', 'A', 'agent:a');
  host.registerPlugin(a.manifest, a.entry);
  await host.boot();

  assert.equal(host.getInternalService(SERVICE).who(), 'GLOBAL', '不传作用域 ⇒ 全局，与原行为一致');
  assert.equal(host.getInternalService(SERVICE, 'agent:a').who(), 'A');
});

// ═══════════════════════════ 信息侧：ctx.scoped 接线 ═══════════════════════════

test('★ ctx.scoped 的 on 打上作用域标签：只收本作用域（及其祖先）的事件', async () => {
  const host = makeHost();
  const seen = { a: [], b: [], root: [] };

  const l = bare('plugin.listener', ctx => {
    ctx.scoped('agent:a').on('demo/tick', v => seen.a.push(v));
    ctx.scoped('agent:b').on('demo/tick', v => seen.b.push(v));
    // 根 ctx 订阅 = 无标签 ⇒ 按官方语义「无标签一律放行」，应当听到所有作用域的事件
    ctx.on('demo/tick', v => seen.root.push(v));
  });
  host.registerPlugin(l.manifest, l.entry);

  const e = bare('plugin.emitter', ctx => {
    ctx.scoped('agent:a').emit('demo/tick', 1);
    ctx.scoped('agent:b').emit('demo/tick', 2);
    ctx.emit('demo/tick', 3);        // 根派发
  }, ['plugin.listener']);
  host.registerPlugin(e.manifest, e.entry);
  await host.boot();

  assert.deepEqual(seen.a, [1], '★ agent:a 只该收到自己那份，根派发(3)与 agent:b 的(2)都不该进来');
  assert.deepEqual(seen.b, [2], '★ agent:b 同理 —— 双向都要验，否则「谁都收不到」会伪装成隔离成功');
  assert.deepEqual(seen.root, [1, 2, 3], '★ 无标签监听器一律放行（含根派发与所有作用域派发）—— 「不订阅作用域」仍是通吃，未被隔离误伤');
});

test('★ 事件放行【向上延伸】：父作用域收得到子作用域的事件，反之不行', async () => {
  const host = makeHost();
  const seen = { parent: [], child: [] };

  const l = bare('plugin.listener', ctx => {
    // ★ 先建出父子关系：scoped('agent').scoped('agent:child')
    ctx.scoped('agent').scoped('agent:child');
    ctx.scoped('agent').on('demo/x', v => seen.parent.push(v));
    ctx.scoped('agent:child').on('demo/x', v => seen.child.push(v));
  });
  host.registerPlugin(l.manifest, l.entry);

  const e = bare('plugin.emitter', ctx => {
    ctx.scoped('agent').scoped('agent:child').emit('demo/x', 'from-child');
  }, ['plugin.listener']);
  host.registerPlugin(e.manifest, e.entry);
  await host.boot();

  assert.deepEqual(seen.parent, ['from-child'], '★ 祖先 tag 的监听器要收得到后代的事件（放行向上延伸）');
  assert.deepEqual(seen.child, ['from-child']);
});

test('★ 事件放行【不可逆】：子作用域收不到父作用域的事件', async () => {
  const host = makeHost();
  const seen = { parent: [], child: [] };

  const l = bare('plugin.listener', ctx => {
    ctx.scoped('agent').scoped('agent:child');
    ctx.scoped('agent').on('demo/x', v => seen.parent.push(v));
    ctx.scoped('agent:child').on('demo/x', v => seen.child.push(v));
  });
  host.registerPlugin(l.manifest, l.entry);

  const e = bare('plugin.emitter', ctx => {
    ctx.scoped('agent').emit('demo/x', 'from-parent');
  }, ['plugin.listener']);
  host.registerPlugin(e.manifest, e.entry);
  await host.boot();

  assert.deepEqual(seen.parent, ['from-parent']);
  assert.deepEqual(seen.child, [], '★ 方向不可逆：这是放行规则的硬性一条，反过来就是越界收听');
});

test('★ 插件自报 scopeLabel 必须被忽略（归属判据只能由宿主闭包注入）', async () => {
  const host = makeHost();
  const seen = { victimSecret: [], ownScope: [] };

  // ★ 间谍必须从【自己的作用域】订阅，本测试才有判别力：
  //   若从根 ctx 订阅，它本来就是「无标签监听器」，按官方语义一律放行，
  //   于是无论伪造成功与否它都听得到 —— 那样这条测试只是在给既有行为鼓掌。
  const spy = bare('plugin.spy', ctx => {
    ctx.scoped('agent:other').on('demo/secret', v => seen.victimSecret.push(v), {
      scopeLabel: 'agent:victim'        // 试图把自己打成受害者的标签以旁听
    });
    ctx.scoped('agent:other').on('demo/other', v => seen.ownScope.push(v));
  });
  host.registerPlugin(spy.manifest, spy.entry);

  const victim = bare('plugin.victim', ctx => {
    ctx.scoped('agent:victim').emit('demo/secret', 'classified');
    ctx.scoped('agent:other').emit('demo/other', 'legit');
  }, ['plugin.spy']);
  host.registerPlugin(victim.manifest, victim.entry);
  await host.boot();

  assert.deepEqual(
    seen.victimSecret, [],
    '★ 自报的作用域标签必须被宿主覆盖 —— 否则隔离用一个参数就能绕开'
  );
  assert.deepEqual(
    seen.ownScope, ['legit'],
    '★ 正向对照：它自己那条作用域的事件必须照收 —— 否则「收不到」可能只是因为监听器根本没挂上'
  );
});

test('★ 卸载插件后，它的作用域监听器自动摘除（注册即效果）', async () => {
  const host = makeHost();
  const seen = [];

  const l = bare('plugin.listener', ctx => {
    ctx.scoped('agent:a').on('demo/x', v => seen.push(v));
  });
  host.registerPlugin(l.manifest, l.entry);

  const e = bare('plugin.emitter', ctx => {
    ctx.scoped('agent:a').emit('demo/x', 'first');
  });   // ★ 不再依赖 listener（按注册顺序已在其后）；否则级联停用下 listener 停用后 emitter 无法重新激活
  host.registerPlugin(e.manifest, e.entry);
  await host.boot();
  assert.deepEqual(seen, ['first'], '前置条件：卸载前必须收得到');

  await host.deactivatePlugin('plugin.listener');
  await host.deactivatePlugin('plugin.emitter');
  await host.activatePlugin('plugin.emitter');   // 重新激活，再发一次

  assert.deepEqual(seen, ['first'], '★ 已卸载的监听器不得再收到事件（作用域监听器同样走 disposer 托管）');
});

test('★ 作用域位置不得被改写 —— declareScope 层：改嫁必须报错', () => {
  // ★ 本条测的是 MessageChannel 的 declareScope 层 ⇒ 直接测通道本身（host.channel 已私有）
  const ch = new MessageChannel();
  ch.declareScope('sub', 'a');

  assert.throws(
    () => ch.declareScope('sub', 'b'),
    hasCode('scope_conflict', /already declared with parent 'a'/),
    '★ 静默改嫁会让事件诡异地流进另一个作用域，且现场无任何报错 —— 宁可红也不给假绿'
  );
  // 幂等：同一对重复声明不算改嫁
  ch.declareScope('sub', 'a');
  assert.equal(ch.scopeParentOf('sub'), 'a');
});

test('★★ 第三方不得把别人的【顶层】作用域追溯挂到自己底下（核心洞）', async () => {
  const host = makeHost();
  const got = {};

  // plugin.b 在 team 作用域里放一份「只有 team 看得见」的实现
  const b = provider('plugin.b', 'TEAM-PRIVATE', 'team');
  host.registerPlugin(b.manifest, b.entry);

  // plugin.a 只是普通地用 scoped('writer') —— 它【从没听说过 team】
  const a = consumer('plugin.a', ['plugin.b'], ctx => { ctx.scoped('writer'); });
  host.registerPlugin(a.manifest, a.entry);
  await host.boot();

  // ★ 探测必须走【纯按键解析】（getInternalService(name, scopeKey)），
  //   不能再调一次 ctx.scoped('writer') —— 那会重新声明一次，把父级写回 null，
  //   反而"顺手修好"了攻击（实测：这样构造的测试对漏洞变体不判别）。
  const resolveByKey = () => {
    try { return host.getInternalService(SERVICE, 'writer').who(); }
    catch (error) { return { error: error.message, code: error.code }; }
  };

  got.before = resolveByKey();
  assert.equal(got.before.code, 'no_provider', '前置条件：writer 本来够不到 team 的东西');

  // 攻击：把 writer 挂到 team 下
  const atk = bare('plugin.atk', ctx => { ctx.scoped('team').scoped('writer'); }, ['plugin.b']);
  host.registerPlugin(atk.manifest, atk.entry);
  await host.activatePlugin('plugin.atk');

  assert.equal(scopeParentOf(host, 'writer'), null, '★★ writer 的位置不得被改写（必须仍是顶层）');
  got.after = resolveByKey();
  assert.equal(got.after.code, 'no_provider',
    '★★ 攻击之后 writer 仍然够不到 team —— 位置在首次创建时定死，加入者不能改写'
  );
});

test('★★ 事件侧同样不得被追溯：顶层 writer 的事件不得流进 team 的监听器', async () => {
  const host = makeHost();
  const seen = [];

  const p = bare('plugin.p', ctx => { ctx.scoped('writer').on('demo/e', () => seen.push('writer')); });
  host.registerPlugin(p.manifest, p.entry);
  await host.boot();

  const l = bare('plugin.l', ctx => { ctx.scoped('team').on('demo/e', () => seen.push('team')); }, ['plugin.p']);
  host.registerPlugin(l.manifest, l.entry);
  await host.activatePlugin('plugin.l');

  // 攻击：把 writer 挂到 team 下（writer 已是顶层 ⇒ 位置不可改写）
  const atk = bare('plugin.atk', ctx => { ctx.scoped('team').scoped('writer'); }, ['plugin.p']);
  host.registerPlugin(atk.manifest, atk.entry);
  await host.activatePlugin('plugin.atk');
  assert.equal(scopeParentOf(host, 'writer'), null, 'writer 必须仍是顶层');

  const e = bare('plugin.e', ctx => { ctx.scoped('writer').emit('demo/e'); }, ['plugin.atk']);
  host.registerPlugin(e.manifest, e.entry);
  await host.activatePlugin('plugin.e');

  assert.ok(seen.includes('writer'), '正向对照：writer 自己的监听器必须收到 —— 否则「没人收到」会伪装成隔离成功');
  assert.ok(!seen.includes('team'), `★ team 监听器不得收到顶层 writer 的事件（实收 ${JSON.stringify(seen)}）`);
});

test('★★ privateScope 与 scoped 必须【同守】生命周期门禁', async () => {
  const host = makeHost();
  let ctxRef = null;
  host.registerPlugin(
    { id: 'plugin.p', version: '1.0.0', apiVersion: '1.0.0' },
    { async activate(ctx) { ctxRef = ctx; } }
  );
  await host.boot();
  await host.deactivatePlugin('plugin.p');

  assert.throws(
    () => ctxRef.scoped('x'),
    hasCode('scope_disposed'),
    '前置条件：scoped() 在停用后必须拒绝（它靠 addDisposer 这个既有关卡）'
  );
  assert.throws(
    () => ctxRef.privateScope(),
    hasCode('scope_disposed'),
    '★ privateScope() 也必须拒绝 —— 它既不登记声明也不挂 disposer，不显式检查就会静默放行'
  );
});

/**
 * ⚠️ 前提锚点 —— 它守护的是【运行环境前提】，**不是新增代码**。
 *
 * ★ 已实测：把 `#privateChildren` 从 WeakMap 改回强 Map（即退回泄漏写法），
 *   本文件**一条都不会红** —— WeakMap 不可枚举，泄漏与不泄漏在行为上不可区分。
 *   ⇒ 这条不是「判别性门禁」，只是把实现所依赖的语言前提**钉在明面上**：
 *     换了引擎/降了版本时，它会第一时间红，而不是等到内存慢慢涨。
 */
test('前提锚点：私有作用域父键依赖 ES2023「非注册 symbol 可作 WeakMap 键」', () => {
  const sym = Symbol('private');
  assert.equal(new WeakMap([[sym, 1]]).has(sym), true, '非注册 symbol 必须能作 WeakMap 键');
  assert.throws(
    () => new WeakMap([[Symbol.for('registered'), 1]]),
    TypeError,
    '★ 边界：注册 symbol（Symbol.for）不可作 WeakMap 键 —— 实现必须用 Symbol(...) 而非 Symbol.for(...)'
  );
});

test('★★ ensureScope 也必须防环（两个登记入口不得有不对称）', () => {
  // 曾有的隐患：declareScope 有防环检查，ensureScope 当时没有。
  // 实测可复现成环 ⇒ #admit 的祖先链遍历没有步数上限 ⇒ 每次派发都死循环。
  const ch = new MessageChannel();

  // ★ 未声明的父键会在子键创建时以【顶层】入表（见 channel #retainParent），
  //   所以 `ensureScope('p','a')` 走的是「加入既有 p、不改写位置」——环在结构上无从产生。
  //   防环检查本身仍由 declareScope / 新建路径守护（下方与 channel.test 的用例）。
  ch.ensureScope('a', 'p');                       // a → p（p 随之以顶层入表）
  const joined = ch.ensureScope('p', 'a');        // 若能改写 ⇒ p→a、a→p 成环
  assert.equal(joined.created, false, 'p 已存在，只能加入');
  assert.equal(ch.scopeParentOf('p'), null, '★ p 的位置不得被改写成 a（否则成环）');

  // 换个顺序同样不成环
  const ch2 = new MessageChannel();
  ch2.ensureScope('x', 'y');
  ch2.ensureScope('y', 'x');
  assert.equal(ch2.scopeParentOf('y'), null);

  // 真正的新建成环路径仍被拦（三节点：q 已在 r 下，再把全新的 r 挂到 q 下不可能 —— r 已入表；
  //   用 declareScope 改写既有键则走「已声明」报错）
  assert.throws(() => ch2.declareScope('y', 'x'), hasCode('scope_cycle'));

  // 正常嵌套不得被误伤
  const ch3 = new MessageChannel();
  ch3.ensureScope('child', 'root');
  ch3.ensureScope('grandchild', 'child');
  assert.equal(ch3.scopeParentOf('grandchild'), 'child', '正常的链必须照常建立');
});

test('★ 祖先链必须永远有限（环一旦可行，遍历就是死循环）', () => {
  const ch = new MessageChannel();
  ch.ensureScope('a', 'b');
  ch.ensureScope('c', 'd');

  const walk = (from, cap = 50) => {
    const seen = [];
    for (let cursor = from; cursor != null && seen.length < cap; cursor = ch.scopeParentOf(cursor)) {
      seen.push(String(cursor));
    }
    return seen;
  };
  // ★ 链里包含【父节点本身】：a → b →（b 自己没声明父级 ⇒ 停）。故长度是 2 而不是 1。
  assert.deepEqual(walk('a'), ['a', 'b'], 'a → b → (顶层) 必须终止');
  assert.deepEqual(walk('c'), ['c', 'd'], 'c → d → (顶层) 必须终止');
  assert.ok(walk('a').length < 50, '★ 只要有环，这条会走到 cap —— 它就是 #admit 的走法');
});

test('★★ 位置冲突要【留痕】而不是静默：onScopeConflict 必须被调用', async () => {
  const host = makeHost();
  // ★ channel 私有 ⇒ 不再替换钩子，改看宿主钩子写下的审计记录
  const reports = () => host.getDiagnostics().recentLogs
    .filter(l => l.message.includes('already declared at')).map(l => l.message);

  const a = consumer('plugin.a', [], ctx => { ctx.scoped('writer'); });   // 建在顶层
  host.registerPlugin(a.manifest, a.entry);
  await host.boot();

  const c = consumer('plugin.c', ['plugin.a'], ctx => { ctx.scoped('team').scoped('writer'); });
  host.registerPlugin(c.manifest, c.entry);
  await host.activatePlugin('plugin.c');

  assert.deepEqual(
    reports(), ["Scope 'writer' is already declared at 'top-level'; the request to place it under 'team' was ignored (a scope position is fixed at first creation — later users can only join, never re-parent)"],
    '★ 请求的层级与实际不符必须上报（照常返回实际那个，但不许静默 —— 否则排查时毫无线索）'
  );
});

test('★ 声明随插件停用释放（引用计数归零才回收），不砖化后来者', async () => {
  const host = makeHost();
  const a = consumer('plugin.a', [], ctx => { ctx.scoped('team').scoped('task:42'); });
  host.registerPlugin(a.manifest, a.entry);
  await host.boot();

  assert.equal(scopeParentOf(host, 'task:42'), 'team', '前置条件：已挂在 team 下');
  await host.deactivatePlugin('plugin.a');
  assert.equal(
    scopeParentOf(host, 'task:42'), undefined,
    '★ 停用后声明必须被释放 —— 否则这个键永久砖化，后来者想用同名 leaf 只能永远拿到旧父级'
  );

  // 反面：释放之后，另一个插件可以用【不同】的父级重新创建它
  const b = consumer('plugin.b', [], ctx => { ctx.scoped('other').scoped('task:42'); });
  host.registerPlugin(b.manifest, b.entry);
  await host.activatePlugin('plugin.b');
  assert.equal(scopeParentOf(host, 'task:42'), 'other', '第二个插件必须拿到自己声明的父级');
});

test('★ 仍在被引用时不得被先停用者回收（引用计数）', async () => {
  const host = makeHost();
  const a = consumer('plugin.a', [], ctx => { ctx.scoped('team').scoped('shared'); });
  host.registerPlugin(a.manifest, a.entry);
  await host.boot();

  // ★ 不再依赖 a —— 停 a 会级联停 b，引用计数这条就测不到了
  const b = consumer('plugin.b', [], ctx => { ctx.scoped('team').scoped('shared'); });
  host.registerPlugin(b.manifest, b.entry);
  await host.activatePlugin('plugin.b');   // b 也引用了它

  await host.deactivatePlugin('plugin.a');
  assert.equal(
    scopeParentOf(host, 'shared'), 'team',
    '★ 先停用的创建者不得把仍在被引用的作用域链悄悄拆掉'
  );
});

test('★ ctx.privateScope：每次都是全新一格，谁也蹭不到', async () => {
  const host = makeHost();
  let ctxRef = null;

  host.registerPlugin(
    { id: 'plugin.p', version: '1.0.0', apiVersion: '1.0.0', provides: [SERVICE] },
    { async activate(ctx) { ctxRef = ctx; } }
  );
  await host.boot();

  const s1 = ctxRef.privateScope();
  const s2 = ctxRef.privateScope();
  s1.provideService(SERVICE, { who: () => 's1' });
  s2.provideService(SERVICE, { who: () => 's2' });

  assert.equal(s1.getService(SERVICE).who(), 's1');
  assert.equal(s2.getService(SERVICE).who(), 's2', '★ 两个私有作用域必须互不可见');

  // ★ 同名子标签也不能互相撞（否则私有作用域之间照样会串）
  const c1 = s1.scoped('sub');
  const c2 = s2.scoped('sub');
  c1.provideService(SERVICE, { who: () => 's1-sub' });
  assert.equal(c1.getService(SERVICE).who(), 's1-sub');
  assert.equal(
    c2.getService(SERVICE).who(), 's2',
    '★ 另一私有作用域下的同名子标签必须走【自己的】祖先链（回退到自己的父级 s2），而不是串到 s1-sub'
  );

  // 幂等：同一个私有父键下重复取同名标签，必须还是【同一格】
  assert.equal(
    s1.scoped('sub').getService(SERVICE).who(), 's1-sub',
    '★ 同一个私有父键下重复取同名标签必须幂等 —— 否则它就成了"每次调用都新开一格"'
  );
});

test('★ getDiagnostics 看得见作用域实现（全局槽口径不变），停用后归零', async () => {
  const host = makeHost();
  const a = provider('plugin.a', 'A', 'agent:a');
  const b = provider('plugin.b', 'B', 'agent:b');
  host.registerPlugin(a.manifest, a.entry);
  host.registerPlugin(b.manifest, b.entry);
  await host.boot();
  const svc = () => host.getDiagnostics().services.find(s => s.name === SERVICE);
  assert.equal(svc().scopedProviderCount, 2, '两个作用域实现都必须被计入');
  assert.equal(svc().providerCount, 0, '全局槽口径不变：没有全局实现');
  assert.equal(svc().activeProvider, null);
  await host.deactivatePlugin('plugin.a');
  assert.equal(svc().scopedProviderCount, 1, '停用即注销，计数随之减少');
});

test('★ 两套记账同步归零：停用后作用域服务桶与作用域表一起清空（含私有作用域、嵌套作用域），重新激活后一起回来', async () => {
  const host = makeHost();
  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0', provides: [SERVICE] },
    { activate(ctx) {
        ctx.scoped('team').provideService(SERVICE, { who: () => 'TEAM' });
        ctx.scoped('team').scoped('sub').provideService(SERVICE, { who: () => 'SUB' });
        ctx.privateScope().provideService(SERVICE, { who: () => 'PRIV' });
      } }
  );
  await host.boot();
  const snap = () => {
    const d = host.getDiagnostics();
    return {
      buckets: d.services.find(s => s.name === SERVICE).scopedProviderCount,
      scopes: d.channel.scopes.length
    };
  };
  const live = snap();
  assert.equal(live.buckets, 3, '三个作用域实现都在桶里');
  assert.ok(live.scopes >= 2, `作用域表里至少有 team / sub：${live.scopes}`);

  await host.deactivatePlugin('plugin.a');
  assert.deepEqual(snap(), { buckets: 0, scopes: 0 }, '★ 两套记账必须【同时】归零 —— 任一边残留都是泄漏（幽灵服务 / 作用域键回收不掉）');

  await host.activatePlugin('plugin.a');
  assert.deepEqual(snap(), live, '重新激活后两边一起回到同一形状');
});
