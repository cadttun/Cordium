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
 * ── 为什么是这两条判据（而不是完整 SemVer 范围 / 新增字段）────────────
 *   · 完整范围：本仓**同仓分发、一并 bump**，不存在「旧内核 + 新插件」的组合矩阵
 *     ⇒ 让作者写范围只会诱导他写**虚假上界**（SemVer §4 明说 0.y.z 不承诺稳定）。
 *   · 新增 `minKernelVersion` 字段：语义上可行，但要改全仓 296 处 manifest；
 *     而同样语义**用既有比较函数就能表达**。
 *   · ★ 不用 caret 表达式：它在 **0.x** 上是 patch-only 语义（`^0.9.0` = `>=0.9.0 <0.10.0`），
 *     与「至少」的意图不符 ⇒ 会把「要求低于内核」的插件误拒（实测）。
 *
 * ★★ 本文件最重要的一条：**两层必须同一判定**。
 *   内核层（运行时契约）与描述符层（上架契约）判出不同结论时，
 *   同一份 manifest 会「能跑但上不了架」或反过来 —— 这正是 `doc-examples.test.mjs` 当初立的原因。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, KERNEL_API_VERSION } from '../src/index.mjs';
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
    ['1.0.0', 'pass', '与内核同版本 —— ★ 现有 296 处 manifest 写的都是它，必须照旧放行'],
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
