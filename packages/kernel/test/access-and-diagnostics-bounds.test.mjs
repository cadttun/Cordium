/**
 * @file packages/kernel/test/access-and-diagnostics-bounds.test.mjs
 * @description 回归门禁：access 成员校验 / Symbol 作用域键 / 诊断有界
 *
 * ── 守的三件事（均由实测驱动）──
 *   ① `access` 拼错一个字母 ⇒ **静默 fail-open**（等同 public）⇒ 加成员校验
 *   ② `scopeKey` 是 Symbol 时进模板字面量 ⇒ **TypeError**（错误路径变噪音）⇒ 包 String()
 *   ③ `manifestDiagnostics` 是唯一**无上限**的诊断容器 ⇒ 加环形 + **丢弃计数**
 *
 * ★ 三条的共同性质：**失败时没有声音**。本文件就是给它们装上门铃。
 * ★ 每条测试都必须能判别它守护的代码 —— 删掉对应修复必须变红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost, SERVICE_ACCESS_VALUES } from '../src/index.mjs';
import { isValidServiceAccess } from '../src/internal.mjs';
import { contractInfo } from './fixtures/inspect.mjs';

const SVC = 'service.demo';

// ═════════════════════ ① access 成员校验 ═════════════════════

test('★ 合法 access 值集必须是【冻结数组】而非 Set', () => {
  // 为什么专门测"是数组"：`Object.freeze(new Set())` 是**浅冻结**，
  // .add() 仍然有效 —— 那会让"值集不可变"变成一句空话。
  assert.ok(Array.isArray(SERVICE_ACCESS_VALUES), '值集必须是数组（Set 的 freeze 挡不住 add）');
  assert.ok(Object.isFrozen(SERVICE_ACCESS_VALUES), '值集必须被冻结');
  assert.throws(() => { SERVICE_ACCESS_VALUES.push('sneaky'); }, TypeError,
    '冻结数组必须拒绝 push —— 否则插件能给自己加一个 access 级别');
});

test('★ isValidServiceAccess 必须能判别拼错值（判别力自检）', () => {
  for (const v of ['public', 'declared', 'sensitive', 'internal']) {
    assert.equal(isValidServiceAccess(v), true, `${v} 是合法级别`);
  }
  for (const bad of ['sensitve', 'PUBLIC', '', 'unknown']) {
    assert.equal(isValidServiceAccess(bad), false, `${bad} 不是合法级别`);
  }
});

test('★★ access 拼错必须抛错 —— 禁止静默 fail-open', () => {
  // 修复前：'sensitve' 被原样落表，而 #assertServiceAccess 的三条 if 都不匹配
  //         ⇒ **静默等同 public**（最严格的意图落成最宽松的行为）。
  const host = new CordiumHost();
  assert.throws(
    () => host.declareServiceContract(SVC, { access: 'sensitve' }),
    hasCode('invalid_contract'),
    '拼错的 access 必须响亮拒绝，不能静默降级'
  );
});

test('★★ 被拒绝的契约不得落表（门禁必须早于副作用）', () => {
  // 同形已出现三次（registerAction / registerService / ctx.ui.registerContribution）
  // —— 都是「先写表后清理」留下幽灵条目。本测试钉住"别再来第四次"。
  const host = new CordiumHost();
  try { host.declareServiceContract(SVC, { access: 'bogus' }); } catch { /* 预期 */ }
  assert.equal((contractInfo(host, SVC) !== undefined), false,
    '门禁必须在写表之前 —— 抛错后不得留下半成品契约');
});

test('★ 缺省 access 仍取最严格（不得因加强校验而破坏既有契约）', () => {
  // 既有口径：忘记声明 ≠ 放行 ⇒ 缺省 SENSITIVE。
  // 加强校验时最容易顺手改坏的就是这条。
  const host = new CordiumHost();
  host.declareServiceContract('service.absent', {});
  assert.equal(contractInfo(host, 'service.absent').access, 'sensitive',
    '不传 access 必须落到最严格的 sensitive');

  host.declareServiceContract('service.nullish', { access: null });
  assert.equal(contractInfo(host, 'service.nullish').access, 'sensitive',
    'access: null 等同于未声明（不是"非法值"）');
});

test('★ 四个合法级别都必须放行（校验不得误伤）', () => {
  const host = new CordiumHost();
  for (const level of ['public', 'declared', 'sensitive', 'internal']) {
    assert.doesNotThrow(
      () => host.declareServiceContract('service.' + level, { access: level }),
      `${level} 是合法级别，不得被拒`
    );
  }
});

// ═════════════════════ ② Symbol 作用域键不得进模板字面量 ═════════════════════

test('★ 前提自检：Symbol 进模板字面量确实抛 TypeError（语言的刻意设计）', () => {
  // 若这条不成立，说明运行环境变了 —— 下面的测试也就失去意义。
  assert.throws(() => { const _ = `scope '${Symbol('x')}'`; }, TypeError,
    'Symbol 不能隐式转字符串（ECMA-262 刻意设计）');
});

// ★ registerService 私有化后，「两个插件在同一个 Symbol 作用域撞名」从公开 API【不可达】——
//   privateScope() 每次都是新 symbol、ctx 身份由闭包绑定，别的插件进不了这一格。
//   host.mjs 里的 String(scopeKey) 仍保留（防御纵深，代价为零）；
//   本组改测【可达】的两件事：私有作用域互不撞名、字符串作用域撞名仍抛业务错误。

test('★★ 两个插件各自 privateScope() 提供同名服务：互不撞名、各取各的', async () => {
  const host = new CordiumHost();
  host.declareServiceContracts({ [SVC]: { access: 'public' } });
  const got = {};
  for (const id of ['plugin.a', 'plugin.b']) {
    host.registerPlugin(
      { id, version: '1.0.0', apiVersion: '1.0.0', provides: [SVC] },
      { activate(ctx) { got[id] = ctx.privateScope(); got[id].provideService(SVC, { who: () => id }); } }
    );
  }
  await host.boot();
  assert.equal(got['plugin.a'].getService(SVC).who(), 'plugin.a');
  assert.equal(got['plugin.b'].getService(SVC).who(), 'plugin.b');
});

test('★★ 作用域内撞名必须抛【业务错误】，且报出作用域', async () => {
  const host = new CordiumHost();
  host.declareServiceContracts({ [SVC]: { access: 'public' } });
  let caught = null;
  for (const id of ['plugin.a', 'plugin.b']) {
    host.registerPlugin(
      { id, version: '1.0.0', apiVersion: '1.0.0', provides: [SVC] },
      {
        activate(ctx) {
          try { ctx.scoped('team').provideService(SVC, { who: () => id }); }
          catch (err) { caught = err; }
        }
      }
    );
  }
  await host.boot();

  assert.ok(caught, '同作用域内第二个提供者必须被拒');
  assert.notEqual(caught.constructor.name, 'TypeError',
    '必须是业务错误 —— 引擎级 TypeError 会把排障引向错误方向');
  assert.match(caught.message, /already provided by plugin 'plugin\.a'/,
    '必须保留原本那条「一个名字一个提供者」的提示');
  assert.match(caught.message, /in scope 'team'/, '必须报出撞名的作用域');
});

// ═════════════════════ ③ Manifest 诊断有界 ═════════════════════

const diag = (i) => ({ path: 'kernel', pluginId: 'plugin.p' + i, fields: ['f' + i] });

test('★★ manifestDiagnostics 必须【有界】（曾是唯一无上限的诊断容器）', () => {
  const host = new CordiumHost({ maxManifestDiagnostics: 10 });
  for (let i = 0; i < 500; i++) host.recordManifestDiagnostic(diag(i));

  const snapshot = host.getDiagnostics();
  assert.equal(snapshot.manifestDiagnostics.length, 10,
    '诊断必须被截断到上限 —— 否则每次 getDiagnostics() 都会全量拷贝无界数组');
});

test('★★ 丢弃必须【记账】—— 禁止静默丢证据', () => {
  // 本容器的设计意图是"不被冲掉的证据"。若只加环形而不记账，
  // 就把「没有记录」变成了「没有发生」 —— 正是本项目明确反对的那种失效。
  const host = new CordiumHost({ maxManifestDiagnostics: 10 });
  for (let i = 0; i < 500; i++) host.recordManifestDiagnostic(diag(i));

  const snapshot = host.getDiagnostics();
  assert.equal(snapshot.manifestDiagnosticsDropped, 490,
    '被丢弃的条数必须可查（500 推入 - 10 留存 = 490）');
});

test('★ 丢弃策略是【丢最旧、留最新】（新证据诊断价值更高）', () => {
  const host = new CordiumHost({ maxManifestDiagnostics: 10 });
  for (let i = 0; i < 500; i++) host.recordManifestDiagnostic(diag(i));

  const kept = host.getDiagnostics().manifestDiagnostics;
  assert.equal(kept[0].pluginId, 'plugin.p490', '留存段应从 p490 开始（最旧的被丢）');
  assert.equal(kept[kept.length - 1].pluginId, 'plugin.p499', '最新一条必须留存');
});

test('★ 未超限时不得丢弃、不得记账（不能误伤正常路径）', () => {
  const host = new CordiumHost({ maxManifestDiagnostics: 10 });
  for (let i = 0; i < 3; i++) host.recordManifestDiagnostic(diag(i));

  const snapshot = host.getDiagnostics();
  assert.equal(snapshot.manifestDiagnostics.length, 3);
  assert.equal(snapshot.manifestDiagnosticsDropped, 0, '正常路径下丢弃计数必须为 0');
});

test('★ 默认上限存在且为正数（不得默认无界）', () => {
  const host = new CordiumHost();
  assert.ok(Number.isInteger(host.maxManifestDiagnostics) && host.maxManifestDiagnostics > 0,
    '必须有一个正的默认上限 —— 默认无界等于没修');
});

test('★ 空 fields / null 仍被忽略（既有语义不变）', () => {
  const host = new CordiumHost();
  host.recordManifestDiagnostic({ path: 'kernel', pluginId: 'p', fields: [] });
  host.recordManifestDiagnostic(null);
  assert.equal(host.getDiagnostics().manifestDiagnostics.length, 0);
  assert.equal(host.getDiagnostics().manifestDiagnosticsDropped, 0,
    '被忽略的无效输入不算"丢弃"（它从未进入证据集）');
});
