import test from 'node:test';
import assert from 'node:assert/strict';
// ★ 改为直接测【中立模块】—— 被测对象搬了家，测试也应指向它的新家，
//   而不是继续经由 host.mjs（那样测试会被宿主的存在与否干扰）。
import { satisfiesSemVer, parseRange, isValidSemVer } from '../src/semver.mjs';
import {
  SEMVER_FIXTURES,
  SEMVER_VERSIONS,
} from './fixtures/semver-fixtures.mjs';

test('isValidSemVer: 只认规范形式（与 npm semver.valid 的差异见 semver.mjs 已知差异表）', () => {
  for (const ok of ['0.0.0', '1.2.3', '1.2.3-rc.1', '1.2.3-alpha.0.beta', '10.20.30']) {
    assert.equal(isValidSemVer(ok), true, ok);
  }
  // npm semver.valid 会把前三个规范化后放行；本实现要求原串即规范串
  for (const bad of ['v1.2.3', ' 1.2.3', '1.2.3 ', '1.2.3+build.1', '1.2.3-rc.1+b', '1.2', '01.2.3', '1.2.3-01', '', 'latest']) {
    assert.equal(isValidSemVer(bad), false, JSON.stringify(bad));
  }
  for (const nonString of [undefined, null, 123, {}, ['1.2.3']]) {
    assert.equal(isValidSemVer(nonString), false, String(nonString));
  }
});

test('SemVer: 支持标准 ^, ~, >= 及 ^0.x 严格规范', () => {
  assert.equal(satisfiesSemVer('1.2.3', '^1.0.0'), true);
  assert.equal(satisfiesSemVer('2.0.0', '^1.0.0'), false);
  assert.equal(satisfiesSemVer('1.2.5', '~1.2.0'), true);
  assert.equal(satisfiesSemVer('1.3.0', '~1.2.0'), false);
  assert.equal(satisfiesSemVer('2.1.0', '>=1.5.0'), true);
  assert.equal(satisfiesSemVer('1.4.9', '>=1.5.0'), false);

  // ^0.x 边界用例
  assert.equal(satisfiesSemVer('0.1.2', '^0.1.0'), true);
  assert.equal(satisfiesSemVer('0.2.0', '^0.1.0'), false);
  assert.equal(satisfiesSemVer('0.0.3', '^0.0.3'), true);
  assert.equal(satisfiesSemVer('0.0.4', '^0.0.3'), false);
});

// ═══════════════════════════════════════════════════════════════════
// ★★★ 与 npm node-semver 的差分一致性
// 夹具由 semver@7.7.4 生成（见 fixtures 文件头），此处只做【双向】断言：
//   · satisfied 里的  ⇒ 必须 true
//   · 不在 satisfied 里的 ⇒ 必须 false   ← ★ 少了这半，「恒真实现」也能蒙混过关
// ═══════════════════════════════════════════════════════════════════

test('★ 差分夹具：与 node-semver 逐条一致（双向判别）', () => {
  // ★ 旧版的 `assert.equal(checked, FI.length*VER.length)` 是【恒真】的
  //   （checked++ 恰在内层循环每轮执行，结构上不可能不等）⇒ 已删。
  //   改为对「夹具本身的形状」做可判别的断言。
  assert.equal(SEMVER_FIXTURES.length > 0, true, '夹具不得为空（否则本条恒真）');
  assert.equal(SEMVER_VERSIONS.length > 0, true, '版本清单不得为空');

  const failures = [];
  for (const { range, satisfied } of SEMVER_FIXTURES) {
    const expected = new Set(satisfied);
    for (const v of SEMVER_VERSIONS) {
      const want = expected.has(v);
      const got = satisfiesSemVer(v, range);
      if (got !== want) failures.push(`satisfies(${JSON.stringify(v)}, ${JSON.stringify(range)}) 期望 ${want} 实得 ${got}`);
    }
  }
  assert.deepEqual(failures.slice(0, 20), [], `共 ${failures.length} 处与 oracle 不一致`);

  // ★ 判别力自证：true / false 两种期望都必须有，否则可能是「全 true」或「全 false」
  const positives = SEMVER_FIXTURES.reduce((n, c) => n + c.satisfied.length, 0);
  const negatives = SEMVER_FIXTURES.length * SEMVER_VERSIONS.length - positives;
  assert.equal(positives > 0, true, '夹具必须含 true 期望（否则恒假实现也能过）');
  assert.equal(negatives > 0, true, '夹具必须含 false 期望（否则恒真实现也能过）');
  // ★ 「全 true」的 range 必须为零：ANY 之外不该有放行一切的 range
  //   （ANY 类 range 只有 * / '' / x / X / ^x / ^* / `>=1.0.0 || `）
  const allTrue = SEMVER_FIXTURES.filter((c) => c.satisfied.length === SEMVER_VERSIONS.length);
  const KNOWN_ANY = new Set(['*', '', 'x', 'X', '^x', '^*', '>=1.0.0 || ']);
  assert.deepEqual(
    allTrue.map((c) => c.range).filter((r) => !KNOWN_ANY.has(r)),
    [],
    '★ 未知的「全 true」range ⇒ 可能是实现误放行',
  );
  // ★ 「全 false」只允许出现在【合法但夹具版本清单覆盖不到】的 range 上。
  //   ⚠️ 不能一概而论：`1.2.3-alpha.1+build.2` 就是合法的，只是夹具的版本清单里
  //   恰好没有 `1.2.3-alpha.1` ⇒ satisfied=[] 正确。
  //   ⇒ 判据改为「该 range 合法，但 oracle 在【更大版本集】上确实找得到命中」才算真退化。
  const BIG_VERSIONS = [];
  for (let M = 0; M <= 3; M++) for (let m = 0; m <= 3; m++) for (let p = 0; p <= 3; p++) BIG_VERSIONS.push(`${M}.${m}.${p}`);
  BIG_VERSIONS.push('1.2.3-alpha.1', '1.2.3-alpha.2', '1.2.3-alpha.7', '1.2.3-beta.2', '1.2.3-rc.1', '2.0.0-rc.1', '0.0.3-beta');
  const suspicious = SEMVER_FIXTURES
    .filter((c) => c.satisfied.length === 0)
    // 该 range 合法（用 parseRange 判），且在大版本集上 oracle 能命中 ⇒ 夹具覆盖不足
    .filter((c) => {
      try { parseRange(c.range); } catch { return false; }
      return BIG_VERSIONS.some((v) => satisfiesSemVer(v, c.range));
    });
  assert.deepEqual(suspicious.map((c) => c.range), [],
    '★ 合法且可满足的 range 不应在夹具里表现为「全 false」⇒ 说明版本清单有覆盖缺口');
});

test('★ 旧口径的三条 fail-open 已封堵', () => {
  // ① `latest` 是 dist-tag 不是 range ⇒ oracle 判非法，两侧都必须 false
  assert.equal(satisfiesSemVer('1.0.0', 'latest'), false);
  assert.equal(satisfiesSemVer('99.0.0', 'latest'), false);

  // ② `>=1.abc.def` 旧实现 Number('abc')=NaN ⇒ (NaN||0)=0 ⇒ 静默退化成 >=0.0.0（放行一切）
  assert.equal(satisfiesSemVer('2.0.0', '>=1.abc.def'), false);
  assert.equal(satisfiesSemVer('0.0.1', '>=1.abc.def'), false);

  // ③ 整个 ^ 家族对 prerelease 的分歧（旧实现里 `^1.0.0` 会放行 `1.2.3-rc.1`）
  assert.equal(satisfiesSemVer('1.2.3-rc.1', '^1.0.0'), false);
  assert.equal(satisfiesSemVer('2.0.0-rc.1', '>=1.0.0'), false);
});

test('★ 旧口径的三条 fail-closed 已放开（官方 X-range 语义）', () => {
  // 旧实现对这三条是「精确字符串比对」⇒ 一律 false
  assert.equal(satisfiesSemVer('1.2.3', '^1'), true);
  assert.equal(satisfiesSemVer('1.2.3', '~1'), true);
  assert.equal(satisfiesSemVer('1.2.3', '1.2'), true);
  assert.equal(satisfiesSemVer('1.9.9', '1.x'), true);
  assert.equal(satisfiesSemVer('2.0.0', '1.x'), false);
  // ≥ / > 与部分版本号
  assert.equal(satisfiesSemVer('2.0.0', '>1'), true);
  assert.equal(satisfiesSemVer('1.0.1', '>1'), false);
  assert.equal(satisfiesSemVer('2.0.0', '<=1'), false);
});

test('★ 两阶段分层：parseRange 抛错，satisfiesSemVer 吞错', () => {
  // ★ 判据来自 oracle：`>=1.0.0 || ` 合法（空组被 filter 掉，只剩 `*` ⇒ ANY）
  //   —— 直觉上像非法，但 oracle 实为 validRange="*"，以 oracle 为准。
  const illegal = ['latest', 'not a range', '>=garbage', '1.2.3.4', '^abc'];
  const legal = ['>=1.0.0 || ', '1.0.0 || ', '1.0.0 || || 2.0.0'];

  // 阶段一：非法输入必须【抛】——调用方要诊断就拿得到原因
  for (const bad of illegal) {
    assert.throws(() => parseRange(bad), `parseRange(${JSON.stringify(bad)}) 应当抛错`);
  }
  // 阶段二：同一批输入必须【返回 false】——不得把异常漏给调用方
  for (const bad of illegal) {
    assert.doesNotThrow(() => satisfiesSemVer('1.0.0', bad));
    assert.equal(satisfiesSemVer('1.0.0', bad), false);
  }
  // ★ 反例侧：这些「看着像非法」的其实是合法的，parseRange 不得抛
  for (const ok of legal) {
    assert.doesNotThrow(() => parseRange(ok), `parseRange(${JSON.stringify(ok)}) 不应抛错`);
    assert.equal(satisfiesSemVer('1.0.0', ok), true, `${JSON.stringify(ok)} 应放行 1.0.0`);
  }
  // 非字符串 range（旧实现会 TypeError 冒泡）
  assert.equal(satisfiesSemVer('1.0.0', undefined), false);
  assert.equal(satisfiesSemVer('1.0.0', null), false);
  assert.equal(satisfiesSemVer('1.0.0', 42), false);
});

test('★ ANY 与 null set 的边界（旧实现整类塌陷）', () => {
  // ANY：* / '' / x 放行一切【正式版】
  for (const any of ['*', '', 'x', 'X', '^x', '^*']) {
    assert.equal(satisfiesSemVer('1.2.3', any), true, `${JSON.stringify(any)} 应放行 1.2.3`);
    assert.equal(satisfiesSemVer('0.0.1', any), true, `${JSON.stringify(any)} 应放行 0.0.1`);
    // ★ 但放行一切【不等于】放行 prerelease（ANY 不是「带 prerelease 的 comparator」）
    assert.equal(satisfiesSemVer('1.2.3-beta.2', any), false, `${JSON.stringify(any)} 不应放行 prerelease`);
  }
  // null set：`>x` / `<x` / `>x.x.x` 谁都不满足
  // ★ 旧版注释提了 `>x.x.x` 却漏测 ⇒ 补上
  for (const nullSet of ['>x', '<x', '>x.x.x', '<x.x.x', '>X', '<*']) {
    assert.equal(satisfiesSemVer('1.2.3', nullSet), false, `${JSON.stringify(nullSet)} 应拒绝一切`);
    assert.equal(satisfiesSemVer('0.0.0', nullSet), false, `${JSON.stringify(nullSet)} 应拒绝一切（含下界）`);
  }
  // ★ ANY 折叠：`1.2.3 || *` 必须整条归为 ANY（去重早于判 ANY —— oracle 的 rangeMap 顺序）
  assert.equal(satisfiesSemVer('9.9.9', '1.2.3 || *'), true);
  assert.equal(satisfiesSemVer('9.9.9', '1.2.3 || *.*'), true);
});

test('★ prerelease 门是【按 comparator set】而非全 range', () => {
  // 官方规则：带 prerelease 的版本，只有在**同一组内**存在同 major.minor.patch
  // 且自身带 prerelease 的 comparator 时才可能满足
  assert.equal(satisfiesSemVer('1.2.3-beta.4', '~1.2.3-beta.2'), true);
  assert.equal(satisfiesSemVer('1.2.4-beta.2', '~1.2.3-beta.2'), false);
  assert.equal(satisfiesSemVer('1.2.3-beta.4', '^1.2.3-beta.2'), true);
  assert.equal(satisfiesSemVer('1.2.4-beta.2', '^1.2.3-beta.2'), false);
  assert.equal(satisfiesSemVer('3.4.5-alpha.9', '>1.2.3-alpha.3'), false);

  // ★ 跨组不串门（判据取自 oracle 实测，非推断）：
  //   1.2.3-beta.4 在第 1 组满足（同 1.2.3 且带 prerelease）⇒ 整体 true
  assert.equal(satisfiesSemVer('1.2.3-beta.4', '~1.2.3-beta.2 || 5.0.0'), true);
  //   1.2.6-beta.4 两组都不满足 ⇒ false。
  //   ★ 第 2 组虽含 1.2.6 的 comparator，但那是「正式版 comparator」，
  //     且 prerelease 门的条件是 `>0` —— 它进不了白名单 ⇒ 不构成跨组放行。
  assert.equal(satisfiesSemVer('1.2.6-beta.4', '~1.2.3-beta.2 || 1.2.6-beta.0'), false);
  assert.equal(satisfiesSemVer('1.2.6-beta.4', '~1.2.3-beta.2'), false);
  assert.equal(satisfiesSemVer('1.2.6-beta.4', '1.2.6-beta.0'), false);
});

test('★ 版本串本身的合法性（旧实现完全不校验）', () => {
  assert.equal(satisfiesSemVer('abc', '*'), false);
  assert.equal(satisfiesSemVer('1.2', '*'), false);
  assert.equal(satisfiesSemVer('01.2.3', '*'), false);
  assert.equal(satisfiesSemVer('99999999999999999999.0.0', '*'), false, '超过 MAX_SAFE_INTEGER 应拒绝');
  // `v` 前缀在【版本】位置合法
  assert.equal(satisfiesSemVer('v1.2.3', '1.2.3'), true);
  assert.equal(satisfiesSemVer('1.2.3+build.1', '1.2.3'), true, 'build metadata 不参与比较');

  // ★★★ MAX_LENGTH 必须真正可判别（旧断言恒真：
  //   `1.${'0'.repeat(300)}.0` 是被 RE_FULL 拒的，删掉 MAX_LENGTH 检查仍返回 false）
  //   ⇒ 用【语法合法但长度超界】的输入，才能真正判到长度检查这一层。
  const tooLong = `1.2.3+${'a'.repeat(251)}`; // 总长 257 > MAX_LENGTH(256)
  assert.equal(tooLong.length > 256, true, '前提：该串确实超过 MAX_LENGTH');
  assert.equal(satisfiesSemVer(tooLong, '*'), false, '★ 超长版本串必须被长度检查拒绝（非被语法拒绝）');
  assert.equal(satisfiesSemVer(`1.2.3+${'a'.repeat(250)}`, '*'), true, '刚好 256 字符应通过（边界另一侧）');
});

test('★★★ oracle 的 safeRegex 量化上界', () => {
  // 官方 internal/re.js 的 makeSafeRegex：
  //   '\s*' := '\s{0,1}' ／ '\d*' := '\d{0,256}' ／ '[a-zA-Z0-9-]+' := '…{1,250}'
  // 漏抄这张表的后果【实测】：range 侧 build id 超 250 字符时 oracle 判非法，
  // 而忽略长度的一侧会静默放行 ⇒ fail-open。
  const A = (n) => 'a'.repeat(n);

  // 边界：build id ≤250 合法，≥251 非法（MAX_SAFE_BUILD_LENGTH = MAX_LENGTH - 6）
  assert.equal(satisfiesSemVer('1.2.3', `1.2.3+${A(250)}`), true, 'build id 恰好 250 应合法');
  assert.equal(satisfiesSemVer('1.2.3', `1.2.3+${A(251)}`), false, '★ build id 251 必须判非法（fail-open 红线）');

  // ★ 各种算子形态都必须同样受约束，不得只在裸版本号上生效
  for (const pre of ['', '^', '~', '>=', '<=', '=']) {
    assert.equal(
      satisfiesSemVer('1.2.3', `${pre}1.2.3+${A(251)}`),
      false,
      `★ ${pre}1.2.3+<251> 应判非法（不得因算子前缀绕过长度约束）`,
    );
  }

  // ★ 复合 / hyphen / OR 形态同样
  assert.equal(satisfiesSemVer('1.2.3', `>1.0.0 <2.0.0+${A(251)}`), false);
  assert.equal(satisfiesSemVer('1.2.3', `1.2.3 - 2.0.0+${A(251)}`), false);
  assert.equal(satisfiesSemVer('1.2.3', `1.2.3+${A(251)} || 2.0.0`), false);

  // ★ 对照组：同形态但长度合规 ⇒ 必须正常放行（证明不是「一律拒绝」）
  assert.equal(satisfiesSemVer('1.2.3', `^1.2.3+${A(250)}`), true);
  assert.equal(satisfiesSemVer('1.2.3', `>1.0.0 <2.0.0+${A(250)}`), true);
});

test('★ 判别性自证：夹具真能抓到偏离 oracle 的实现', () => {
  // ★ 本条的旧版只比 `naive` 与夹具、**从不与真实实现比对**
  //   ⇒ 实现全坏掉它仍会通过。⇒ 改为「用一个已知会偏离的替代实现去跑同一套夹具」，
  //     并断言【它确实会被夹具判红】—— 这才证明夹具具有判别力。
  const naiveSatisfies = (v, r) => (r === '>1' ? v > '1.0.0' : satisfiesSemVer(v, r));

  const runAgainstFixtures = (fn) => {
    const fails = [];
    for (const { range, satisfied } of SEMVER_FIXTURES) {
      const expected = new Set(satisfied);
      for (const v of SEMVER_VERSIONS) {
        if (fn(v, range) !== expected.has(v)) fails.push(`${v} vs ${range}`);
      }
    }
    return fails;
  };

  // ① 真实现必须全过
  assert.deepEqual(runAgainstFixtures(satisfiesSemVer), []);
  // ② ★ 偏离实现必须被判红 —— 且判红的正是 `>1` 那条（oracle 的 `>1` := `>=2.0.0`）
  const naiveFails = runAgainstFixtures(naiveSatisfies);
  assert.equal(naiveFails.length > 0, true, '★ 夹具必须能识别出近似实现的偏离 —— 否则它不具判别力');
  assert.equal(naiveFails.every((f) => f.endsWith('>1')), true, '偏离应全部集中在 >1 这条 range 上');

  // ③ 夹具还必须有「能被恒真实现判红」的能力（否则双向判别是假的）
  const alwaysTrue = () => true;
  assert.equal(runAgainstFixtures(alwaysTrue).length > 0, true, '★ 恒真实现必须被判红（否则 false 期望是空的）');
  const alwaysFalse = () => false;
  assert.equal(runAgainstFixtures(alwaysFalse).length > 0, true, '★ 恒假实现必须被判红（否则 true 期望是空的）');
});
