/**
 * ★★ `apiVersion` 的语义 = 「**至少需要**哪个 API 版本」。
 *
 * ── 修的是什么 ──────────────────────────────────────────────────────
 *   此前两层都**只比 major**（`compareSemVer(x.0.0, kernel.0.0) !== 0`），于是
 *   在内核 `KERNEL_API_VERSION = '1.0.0'` 时：
 *     `apiVersion: '1.99.0'`  ⇒ **静默放行**
 *   ⇒ 插件声明「我需要 1.99.0 的 API」，内核只有 1.0.0，**却放它上线**。
 *     插件作者以为自己的前置要求被检查了 —— **其实没有**。
 *
 * ── 判据（两条同时成立）────────────────────────────────────────────
 *   ① **破坏边界相同**   ② **内核版本 ≥ 插件要求的版本**
 *   ★ 破坏边界 = 版本号里**最左的那个非零位**（node-semver 对 caret 的定义原话：
 *     "Allows changes that do not modify the left-most non-zero element"）。于是
 *     `^1.4.2` 边界是 major、`^0.9.0` 边界是 minor、`^0.0.3` 边界是 patch。
 *   ⇒ 判据与 caret **等价**（本文件末尾有一条逐值比对的等价性断言钉住这点）。
 *
 * ── 为什么不是完整 SemVer 范围 / 新增字段 ───────────────────────────
 *   · 完整范围：本仓**同仓分发、一并 bump**，不存在「旧内核 + 新插件」的组合矩阵
 *     ⇒ 让作者写范围只会诱导他写**虚假上界**（SemVer §4 明说 0.y.z 不承诺稳定）。
 *   · 新增 `minKernelVersion` 字段：语义上可行，但要改全仓 **33 处真实 manifest**；
 *     而同样语义**用既有比较函数就能表达**。
 *   · 写成显式两条、而不是构造 `^值` 交给范围匹配：两条读出来就是语义本身。
 *
 * ★★ 本文件最重要的一条：**两层同一判定**。
 *   内核层（运行时契约）与描述符层（上架契约）判出不同结论时，
 *   同一份 manifest 会「能跑但上不了架」或反过来 —— 这正是 `doc-examples.test.mjs` 当初立的原因。
 *   ★ 判据本体现在只有**一份实现**（内核 `types.mjs` 的 `isApiVersionCompatible`，两层共用），
 *     所以这条不变量是**结构上**成立的，不再只靠本文件逐值比对兜住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, KERNEL_API_VERSION, satisfiesSemVer, compareSemVer } from '../src/index.mjs';
// ★ 判据本体是内部导出（跨包由 @cordium/plugins 经 internal.mjs 取用，见 runtime.mjs）。
//   本文件直接测它 —— 因为内核契约版本是常量，0.x 分支走公开 API 测不到。
import { isApiVersionCompatible } from '../src/internal.mjs';
// ★ 跨包一律走【包名】（boundary.test.mjs 守这条边界：测试里不得出现 ../../plugins/… 这类相对路径）。
//   同层先例见 regression-sweep.test.mjs 的同一行写法。
import { validatePluginManifest } from '@cordium/plugins/runtime';

const hasCode = code => err => err.code === code;

/** 同一个 apiVersion 值，在【两层】各判一次 */
function judgeBoth(apiVersion) {
  const kernel = { id: 'plugin.x', version: '1.0.0', apiVersion };
  const descriptor = { id: 'plugin.x', name: 'X', version: '1.0.0', apiVersion };
  const result = (fn, arg) => { try { fn(arg); return 'pass'; } catch { return 'reject'; } };
  return { kernel: result(validateManifest, kernel), descriptor: result(validatePluginManifest, descriptor) };
}

test('★ 内核契约版本就是本测试的前提（否则下面的断言可能测的是别的东西）', () => {
  assert.equal(KERNEL_API_VERSION, '1.0.0', '本文件所有期望值都建立在 1.0.0 上；内核升版时本文件必须同步');
});

test('★★ 两层对同一 apiVersion 判出【同一结论】（判据表）', () => {
  const table = [
    // 值              期望      为什么
    ['1.0.0', 'pass', '与内核同版本 —— ★ 实测 33 处真实 manifest 写的都是它，必须照旧放行'],
    ['1.0.1', 'reject', '★ 要求内核还不具备的 patch 版本 —— 这正是修的那个洞（此前静默放行）'],
    ['1.4.2', 'reject', '★ 同上；此前 regression-sweep 还把它断言成「同主版本兼容」'],
    ['1.99.0', 'reject', '★ 极端形态：要求一个远未存在的 API'],
    ['2.0.0', 'reject', '主版本不同 ⇒ API 有过破坏性变更'],
    ['0.9.0', 'reject', '主版本不同（SemVer §4：0.y.z 是初始开发期，1.0.0 才定义公开 API）'],
  ];
  const bad = [];
  for (const [value, expected, why] of table) {
    const got = judgeBoth(value);
    if (got.kernel !== expected) bad.push(`内核层 apiVersion='${value}' ⇒ ${got.kernel}，期望 ${expected}（${why}）`);
    // ★★ 本文件的核心断言：两层不能各判各的
    if (got.descriptor !== got.kernel) {
      bad.push(`★ 两层不一致：apiVersion='${value}' ⇒ 内核层 ${got.kernel} / 描述符层 ${got.descriptor}`);
    }
  }
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
});

test('★ 判据有判别力：修之前的「只比 major」写法会在这张表上翻车', () => {
  // 反例前提：把旧判定复现出来，证明它确实与上表冲突（否则本文件的断言可能恒真）
  const oldKernelJudge = apiVersion =>
    apiVersion.split('.')[0] === KERNEL_API_VERSION.split('.')[0] ? 'pass' : 'reject';
  assert.equal(oldKernelJudge('1.99.0'), 'pass', '旧判定确实放行 1.99.0 —— 这就是被修掉的洞');
  assert.notEqual(oldKernelJudge('1.99.0'), judgeBoth('1.99.0').kernel, '新判定必须与旧判定在这一点上不同');
});

test('★ 描述符层的入口选项 apiVersion 同样受新判定约束（不是只改了一处）', () => {
  // `options.apiVersion` 是【宿主】声明的契约版本；manifest 里那个才是【插件要求】的。
  const hostAt = apiVersion => ({ apiVersion });
  // ★ 插件不自带 apiVersion ⇒ 回退用宿主声明的那个 ⇒ 必然自洽，放行
  assert.doesNotThrow(() => validatePluginManifest({ id: 'plugin.y', name: 'Y', version: '1.0.0' }, hostAt('1.0.0')));
  // ★★ 插件要求 1.4.2、而宿主只有 1.0.0 ⇒ 必须拒（与内核层同一判定）
  assert.throws(
    () => validatePluginManifest({ id: 'plugin.y', name: 'Y', version: '1.0.0', apiVersion: '1.4.2' }, hostAt('1.0.0')),
    hasCode('invalid_manifest'),
    '宿主声明 1.0.0、插件要求 1.4.2 ⇒ 必须拒 —— 与内核层同一判定'
  );
  // 正向对照：要求与宿主相等的 ⇒ 放行
  assert.doesNotThrow(
    () => validatePluginManifest({ id: 'plugin.y', name: 'Y', version: '1.0.0', apiVersion: '1.0.0' }, hostAt('1.0.0'))
  );
});

// ════════════════════════════════════════════════════════════════════════════
// ★★ 0.x 分支与 caret 等价性。
//    内核契约版本是个常量（1.0.0），所以这一支**走公开 API 测不到** ——
//    但它不是死代码：`isApiVersionCompatible` 是通用判据，描述符层还带 `options.apiVersion`
//    入口（宿主可声明任意版本）。直接测判据本体，这一支才有门禁。
// ════════════════════════════════════════════════════════════════════════════

test('★★ 破坏边界 = 最左非零位：major / minor / patch 三种边界各钉一条', () => {
  const table = [
    // 内核      插件要求    期望    说明
    ['1.4.2', '1.4.2', true, 'major 边界：同版本'],
    ['1.9.9', '1.4.2', true, 'major 边界：内核更高'],
    ['1.4.1', '1.4.2', false, 'major 边界：内核更低'],
    ['2.0.0', '1.4.2', false, 'major 边界不同'],
    ['0.9.5', '0.9.0', true, 'minor 边界：同 minor、内核更高'],
    ['0.10.0', '0.9.0', false, '★ minor 边界：0.x 跨 minor 即拒'],
    ['0.0.3', '0.0.3', true, 'patch 边界：同版本'],
    ['0.0.4', '0.0.3', false, '★ patch 边界：0.0.X 只有完全相同才放行']
  ];
  const bad = table
    .filter(([k, p, want]) => isApiVersionCompatible(k, p) !== want)
    .map(([k, p, want, why]) => `内核 ${k} / 插件要求 ${p} ⇒ ${!want}，期望 ${want}（${why}）`);
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
});

test('★★ 判据与 caret 逐值等价（否则「与 caret 等价」就是一句空头承诺）', () => {
  const kernels = ['2.0.0', '1.9.9', '1.4.2', '1.4.1', '1.0.0', '0.10.0', '0.9.5', '0.9.0', '0.0.4', '0.0.3'];
  const plugins = ['1.4.2', '1.0.0', '0.9.0', '0.0.3'];
  const bad = [];
  for (const k of kernels) {
    for (const p of plugins) {
      const ours = isApiVersionCompatible(k, p);
      const caret = satisfiesSemVer(k, `^${p}`);
      if (ours !== caret) bad.push(`内核 ${k} / 插件 ${p}：本仓判 ${ours}，caret 判 ${caret}`);
    }
  }
  assert.deepEqual(bad, [], '\n与 caret 不一致的组合：\n' + bad.join('\n'));
});

test('★ 判别力：修之前那版「只比 major」在 0.x 上会放行跨 minor 的组合', () => {
  // 反例前提：把旧写法复现出来，证明它确实与新判据在这点上不同（否则上面两条可能恒真）
  const oldJudge = (k, p) => k.split('.')[0] === p.split('.')[0] && compareSemVer(k, p) >= 0;
  assert.equal(oldJudge('0.10.0', '0.9.0'), true, '旧写法确实放行跨 minor 的 0.x 组合');
  assert.equal(isApiVersionCompatible('0.10.0', '0.9.0'), false, '★ 新判据必须拒');
});

test('★ 版本号非法 ⇒ 判据返回 false（不抛），由调用方映射成错误码', () => {
  for (const bad of ['', '1.0', 'x.y.z', '01.0.0', null, undefined, 42]) {
    assert.equal(isApiVersionCompatible('1.0.0', bad), false, `插件要求 ${JSON.stringify(bad)} 应判不兼容`);
    assert.equal(isApiVersionCompatible(bad, '1.0.0'), false, `内核版本 ${JSON.stringify(bad)} 应判不兼容`);
  }
});
