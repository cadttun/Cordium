/**
 * 枚举成员校验门禁：`log.level`（固定集）与 `ui.type`（注册制）。
 *
 * 缺陷背景（本仓同形第三次）：**冻结不等于校验** —— 拼错的值不会报错，会**静默落成最宽松的那个**。
 *   · `ServiceAccess` 拼错 ⇒ 静默等同 `public`（已修）
 *   · `PluginKind` 拼错 ⇒ 静默落成 `business`（已修）
 *   · `log.level` 拼错 ⇒ **不进 recentErrors、不带栈、零报错**（本文件守）
 *   · `ui.type` 拼错 ⇒ 消费方分派里 `else if (item.slot)` 兜底，**静默落进 panels**（本文件守）
 *
 * ★ 依据：RFC 9413《Maintaining Robust Protocols》§2 明确推翻「宽进」
 *   （「an interpretation that advocates for tolerating unexpected inputs is no longer
 *   considered best practice」）；§2.2 进一步指出宽容**不利于扩展** ——
 *   要扩展应走**注册表**。pino 的做法同理：核心 level fail-loud，自定义 level 必须注册。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, LOG_LEVEL_VALUES, LifecycleState } from '../src/index.mjs';

const hasCode = (code, re) => err => err.code === code && (!re || re.test(err.message));

// ═══════════════ log.level：固定集 ═══════════════

test('★ log.level 合法值一律收下（正向对照：否则下面的拒绝断言可能只是「什么都不让过」）', async () => {
  const host = new CordiumHost();
  host.registerPlugin({ id: 'p.a', version: '1.0.0', apiVersion: '1.0.0' }, {
    activate(ctx) { for (const level of LOG_LEVEL_VALUES) ctx.log(level, `at ${level}`); }
  });
  await host.boot();
  const logged = host.getDiagnostics().recentLogs.filter(l => l.message.includes('at '));
  assert.equal(logged.length, LOG_LEVEL_VALUES.length, '每一个合法级别都必须真的写进日志（不是被静默丢掉）');
  assert.deepEqual([...new Set(logged.map(l => l.level))].sort(), [...LOG_LEVEL_VALUES].sort());
});

test('★ log.level 拼错 ⇒ 写表之前抛 invalid_argument，且不得留下任何日志条目', () => {
  const host = new CordiumHost();
  // ★ 反例前提：这些值在修之前是【全部照收】的（实测），所以本用例真的有判别性
  for (const bad of ['Error', 'err', 'fatal', 'INFO', 42, {}, null, undefined, '']) {
    assert.throws(
      () => host.log(bad, 'should not be recorded'),
      hasCode('invalid_argument', /Log level must be one of/),
      `★ log(${JSON.stringify(bad)}) 必须被拒 —— 拼错的 error 级此前会让出错证据从诊断里消失`
    );
  }
  // ★ 「门禁必须早于副作用」：抛错时不得已经写进环形缓冲
  const d = host.getDiagnostics();
  assert.equal(d.recentLogs.length, 0, '被拒的日志不得留下条目');
  assert.equal(d.recentErrors.length, 0);
  assert.equal(d.errorLogCount, 0);
});

test('★ 拼错的 error 级不再伪装：合法 error 仍会进 recentErrors 且带栈（负向断言的正向对照）', async () => {
  const host = new CordiumHost();
  host.registerPlugin({ id: 'p.b', version: '1.0.0', apiVersion: '1.0.0' }, {
    activate(ctx) { ctx.log('error', '真正的问题'); }
  });
  await host.boot();
  const d = host.getDiagnostics();
  assert.equal(d.errorLogCount, 1, '合法 error 必须进专用错误缓冲（这是它与拼错值的区别所在）');
  assert.ok(d.recentErrors[0].stack, 'error 级必须带栈');
});

// ═══════════════ ui.type：注册制 ═══════════════

test('★ ui.type 未登记值集 ⇒ 不校验（内核不得替消费方猜值集）', async () => {
  const host = new CordiumHost();
  host.registerPlugin({ id: 'p.c', version: '1.0.0', apiVersion: '1.0.0' }, {
    activate(ctx) { ctx.registerUIContribution({ id: 'u1', type: 'whatever-the-app-wants' }); }
  });
  await host.boot();
  assert.equal(host.getUIContributions().length, 1, '未登记值集时必须放行 —— 保持现有行为不变');
});

test('★ ui.type 登记之后：合法值放行、拼错值在【注册那一刻】响亮失败', async () => {
  const host = new CordiumHost();
  host.declareUIContributionTypes(['panel', 'widget', 'theme', 'command']);

  host.registerPlugin({ id: 'p.d', version: '1.0.0', apiVersion: '1.0.0' }, {
    activate(ctx) {
      ctx.registerUIContribution({ id: 'ok', type: 'panel' });          // 正向对照：合法值必须过
      // ★ 反例前提：此形状（type 拼错 + 带 slot）在消费方分派里会静默落进 panels
      assert.throws(
        () => ctx.registerUIContribution({ id: 'bad', type: 'pannel', slot: 'main' }),
        hasCode('invalid_argument', /unknown type "pannel"/),
        '★ 拼错的 type 必须被拒 —— 否则会静默落成最宽松的那个'
      );
    }
  });
  await host.boot();
  assert.deepEqual(host.getUIContributions().map(c => c.id), ['ok'], '被拒的贡献不得进表');
});

test('★ declareUIContributionTypes 自身入口校验', () => {
  const host = new CordiumHost();
  assert.throws(() => host.declareUIContributionTypes('panel'), hasCode('invalid_argument'));
  assert.throws(() => host.declareUIContributionTypes(['']), hasCode('invalid_argument'));
  assert.throws(() => host.declareUIContributionTypes([123]), hasCode('invalid_argument'));
});

// ═══════════════ activation：新字段的成员校验 ═══════════════

test('★ manifest.activation 缺省 ⇒ eager（现有行为逐字不变）', () => {
  const host = new CordiumHost();
  host.registerPlugin({ id: 'p.e', version: '1.0.0', apiVersion: '1.0.0' });
  assert.equal(host.getDiagnostics().plugins[0].activation, 'eager',
    '不写 activation 的插件必须仍是 eager（诊断投影从契约表派生，自动带出该字段）');
});

test('★ manifest.activation 拼错 ⇒ invalid_manifest（不得静默落成 eager）', () => {
  const host = new CordiumHost();
  for (const bad of ['lazzy', 'onDemand', 'LAZY', 42]) {
    assert.throws(
      () => host.registerPlugin({ id: 'p.f', version: '1.0.0', apiVersion: '1.0.0', activation: bad }),
      hasCode('invalid_manifest', /unknown activation/),
      `★ activation: ${JSON.stringify(bad)} 必须被拒 —— 静默落成 eager 的表现是「作者以为按需、实际启动即跑」`
    );
  }
});

test('★ 死枚举已删：VALIDATED / WAITING_DEPENDENCIES 不得回到状态机里', () => {
  // ★ 这两个此前是零赋值 / 零断言 / 零下游的死枚举（随首次提交带进来的残留）。
  //   本用例是【防回归】：若有人把它们加回来，这里变红。
  assert.equal('VALIDATED' in LifecycleState, false, 'VALIDATED 是死枚举，不得回加');
  assert.equal('WAITING_DEPENDENCIES' in LifecycleState, false, 'WAITING_DEPENDENCIES 是死枚举，不得回加');
  // 正向对照：本用例不是「LifecycleState 是空对象」的假绿
  assert.ok(Object.keys(LifecycleState).length >= 5, '状态机本身必须有内容');
});
