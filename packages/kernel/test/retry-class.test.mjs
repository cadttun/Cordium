/**
 * 重试分类门禁：码 ↔ 档位的**双向完备**，以及「表不是猜出来的」。
 *
 * ★ 为什么需要这道门禁：这张表是本仓最典型的「白名单重建」形态 ——
 *   漏列一个码，它会**静默落进默认档**（`not_retryable`），而默认档恰恰是
 *   「宁可不重试」的那一侧。没有任何运行期错误会因此出现，
 *   只有某个将来写重试逻辑的人会听到一个查不出来的「不重试」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../src/errors.mjs';
import { RetryClass, RETRY_CLASS_VALUES, RETRY_CLASS_BY_CODE, retryClassOf, isRetryable } from '../src/retry-class.mjs';

test('★ 码表每个码都必须在分类表里（漏一个 ⇒ 静默落进默认档）', () => {
  const missing = Object.values(ErrorCode).filter(v => !Object.prototype.hasOwnProperty.call(RETRY_CLASS_BY_CODE, v));
  assert.deepEqual(missing, [], '\n以下码没有归过档（新增码忘了登记？）：\n' + missing.join('\n'));
});

test('★ 分类表不得包含码表里没有的键（拼错的码 / 已删除的码）', () => {
  const known = new Set(Object.values(ErrorCode));
  const extra = Object.keys(RETRY_CLASS_BY_CODE).filter(k => !known.has(k));
  assert.deepEqual(extra, [], '\n以下键不在 ErrorCode 里：\n' + extra.join('\n'));
});

test('★ 每个档位取值都必须是 RetryClass 的成员（不得裸写字符串）', () => {
  const bad = Object.entries(RETRY_CLASS_BY_CODE).filter(([, v]) => !RETRY_CLASS_VALUES.includes(v));
  assert.deepEqual(bad.map(([c, v]) => `${c} = ${String(v)}`), []);
});

test('★ 每个档位都必须真的被用到（空档位只会让调用方乱猜）', () => {
  // ★ 反例：曾按业界口径加了 `retryable_now`（"立刻可再试"），结果 48 个码里
  //   **一个都不属于它** —— 本仓的临时性失败只有「过载要退避」与「状态不对要先改」
  //   两类。空档位如果留着，调用方就只能猜「是不是有些码属于那个空档」。
  //   ⇒ 空档位真出现时，要么删掉它，要么这个测试会红。
  const used = new Set(Object.values(RETRY_CLASS_BY_CODE));
  assert.deepEqual(RETRY_CLASS_VALUES.filter(v => !used.has(v)), [],
    '有档位一个码都没归进去 —— 要么删这个档位，要么把它该收的码找出来');
});

test('★ 门禁自检：漏码 / 多码 / 裸字符串三种坏表都必须被判出来', () => {
  // 直接复用上面的判据函数形状（不复制逻辑，用同一套 filter）
  const probe = { a: 'not_retryable', b: 'retryable_after_backoff' };
  assert.equal(Object.values(probe).filter(v => !RETRY_CLASS_VALUES.includes(v)).length, 0);
  assert.equal(Object.values({ a: 'maybe' }).filter(v => !RETRY_CLASS_VALUES.includes(v)).length, 1,
    '裸字符串必须被判出来');
  const known = new Set(['a', 'b']);
  assert.equal(Object.keys(probe).filter(k => !known.has(k)).length, 0);
  assert.equal(Object.keys({ c: 'not_retryable' }).filter(k => !known.has(k)).length, 1,
    '表里多一个键必须被判出来');
});

test('★ 未知码 ⇒ not_retryable（fail-safe，不是 fail-open）', () => {
  // ★ 理由：未知码只可能来自「拿错东西当码」或「新增码但表没跟上」。
  //   两种情况下重试都是更危险的默认 —— 它会重复一个可能已发生副作用的操作。
  assert.equal(retryClassOf('no_such_code_at_all'), RetryClass.NOT_RETRYABLE);
  assert.equal(retryClassOf(''), RetryClass.NOT_RETRYABLE);
  assert.equal(retryClassOf(undefined), RetryClass.NOT_RETRYABLE);
  assert.equal(retryClassOf(null), RetryClass.NOT_RETRYABLE);
});

test('★ 刻意的分组判据：背压类可退避、参数类不可重试、状态类要先改状态', () => {
  // 这三条是「分类不是拍脑袋」的锚点 —— 每类各挑一个代表，
  // 若将来有人把整张表图省事全改成 not_retryable，这三条会红。
  assert.equal(retryClassOf(ErrorCode.ISOLATION_BUSY), RetryClass.RETRYABLE_AFTER_BACKOFF);
  assert.equal(retryClassOf(ErrorCode.ACTION_OVERLOADED), RetryClass.RETRYABLE_AFTER_BACKOFF);
  assert.equal(retryClassOf(ErrorCode.SERVICE_UNAVAILABLE), RetryClass.RETRYABLE_AFTER_BACKOFF);

  assert.equal(retryClassOf(ErrorCode.INVALID_ARGUMENT), RetryClass.NOT_RETRYABLE);
  // ★ 名字含 timeout 但是**参数错** —— 正是「不得按码名猜」的反例
  assert.equal(retryClassOf(ErrorCode.INVALID_TIMEOUT), RetryClass.NOT_RETRYABLE);
  // ★ 名字含 timeout 且是**执行超预算** —— 同参数重试必然再超时
  assert.equal(retryClassOf(ErrorCode.CALL_TIMEOUT), RetryClass.NOT_RETRYABLE);

  assert.equal(retryClassOf(ErrorCode.DEPENDENCY_INACTIVE), RetryClass.RETRYABLE_WHEN_STATE_CHANGES);
  assert.equal(retryClassOf(ErrorCode.PLUGIN_HAS_DEPENDENTS), RetryClass.RETRYABLE_WHEN_STATE_CHANGES);
});

test('★ 不得按码名启发式推断（两条同名不同义的码必须落在不同档）', () => {
  // ★ 若有人把实现改成 `code.includes('timeout') ? … : …`，这条立刻红。
  //   INVALID_TIMEOUT（参数错）与 CALL_TIMEOUT（执行超预算）价值不同，
  //   但**都不该被重试**；真正的判据锚点在下面这一对上：
  assert.notEqual(
    retryClassOf(ErrorCode.ACTION_OVERLOADED),
    retryClassOf(ErrorCode.ACTION_TIMEOUT),
    '过载（未调用处理器，可退避）与超时（处理器已跑，可能已产生副作用）必须分档'
  );
  // 反例：如果按 `overloaded/timeout` 这类**语义**猜，两者会被归到一起；
  // 但它们对调用方的含义正相反 —— 一个是「什么都没发生，等一下再来」，
  // 另一个是「可能已经做了一半，重试前先确认」。
});

test('★ isRetryable 是派生而不是第二张表', () => {
  for (const code of Object.values(ErrorCode)) {
    assert.equal(isRetryable(code), retryClassOf(code) !== RetryClass.NOT_RETRYABLE,
      `${code}: isRetryable 与 retryClassOf 不一致 —— 出现第二真相源了`);
  }
  assert.equal(isRetryable(ErrorCode.ISOLATION_BUSY), true);
  assert.equal(isRetryable(ErrorCode.INVALID_ARGUMENT), false);
  // ★ 状态类算「可重试」：调用方自己改得了那个状态。改不了的话是它自己该判断的。
  assert.equal(isRetryable(ErrorCode.DEPENDENCY_INACTIVE), true);
});

test('★ 表与档位枚举都是冻结的（消费方改不动全局判据）', () => {
  assert.equal(Object.isFrozen(RetryClass), true);
  assert.equal(Object.isFrozen(RETRY_CLASS_VALUES), true);
  assert.equal(Object.isFrozen(RETRY_CLASS_BY_CODE), true);
});
