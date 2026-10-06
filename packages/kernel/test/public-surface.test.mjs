/**
 * 公开面门禁：包入口的导出清单（定稿）。
 *
 * ★ 增删改名任何一项 = 有意的 API 变更，必须同时改这里；定稿后破坏性变更须升 KERNEL_API_VERSION 主版本。
 * 宿主成员 / ctx 成员的清单门禁在 host.test.mjs。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as publicApi from '../src/index.mjs';
import * as internalApi from '../src/internal.mjs';
import { isAcceptableExport, unfrozenPaths } from './fixtures/deep-frozen.mjs';

test('★ index.mjs 导出清单定稿（显式具名，不得随模块新增 export 自动变大）', () => {
  assert.deepEqual(Object.keys(publicApi).sort(), [
    'ACTIVATION_POLICY_VALUES', 'ActivationPolicy', 'CordiumError', 'CordiumHost',
    // ★ DIAGNOSTICS_CONTRACT：诊断快照的稳定性契约 —— 消费方必须能读到它，
    //   否则「哪些字段可信」只能靠人传（它是对外承诺本身，不是内部实现细节）。
    'DIAGNOSTICS_CONTRACT',
    'DispatchMode', 'EffectScope', 'ErrorCode',
    // ★ HOST_CALLER：宿主的调用方身份。导出是**承重的** —— 消费方靠它从审计日志里认出
    //   「这条是宿主自己干的」，而不是某个插件（此前宿主只能借插件身份，日志记的是被借者）。
    'HOST_CALLER',
    'KERNEL_API_VERSION', 'LOG_LEVEL_VALUES', 'LifecycleState', 'LogLevel', 'MessageChannel',
    'PLUGIN_KIND_VALUES', 'PluginKind', 'SERVICE_ACCESS_VALUES', 'ServiceAccess',
    // ★ UnresolvedReason / UNRESOLVED_REASON_VALUES：诊断快照 reason 字段的取值集合。
    //   导出后 `host.mjs` 的 5 个产出点 + 1 个比较点已回改成本常量 ⇒ 不是第二真相源。
    'UNRESOLVED_REASON_VALUES', 'UnresolvedReason',
    'compareSemVer', 'isBailed', 'isValidSemVer', 'satisfiesSemVer', 'validateManifest'
  ]);
});

test('★ 内部共享工具不得出现在主入口', () => {
  for (const name of ['normalizeStringList', 'normalizeDependencyMap', 'diffWhitelistFields',
    'diffServiceContractFields', 'diffManifestFields', 'MANIFEST_FIELD_TABLE', 'PLUGIN_ID_PATTERN',
    'isValidPluginKind', 'isValidServiceAccess', 'parseRange', 'measureValue']) {
    assert.equal(name in publicApi, false, `${name} 是内部工具，只能经 internal.mjs 取`);
    assert.equal(typeof internalApi[name] === 'undefined', false, `${name} 必须仍可经 internal.mjs 取到`);
  }
});

test('★ internal.mjs 不得导出宿主（plugins 经它取工具时不应牵出 host.mjs）', () => {
  assert.equal('CordiumHost' in internalApi, false);
});

// ★★ 内核侧此前**完全没有**冻结检查（只有 plugins 侧有，且它还是浅的）—— 公开面校验不对称。
//   判据与 plugins 侧共用 `test/fixtures/deep-frozen.mjs`（两个门禁同一口径）。
//   ⚠️ **只覆盖 `index.mjs`（公开 API）**，不覆盖 `internal.mjs`：后者明确「不是公开 API」，
//      且实测它导出的 `PLUGIN_ID_PATTERN` 是未冻结的 RegExp（RegExp 冻结后行为不变，
//      但没有理由为一个内部工具强加公开面口径）。`internal.mjs` 由上面的名字清单门禁守。
test('★ index.mjs 的每个对象导出都必须【逐层】冻结（消费者改了会串给别人）', () => {
  const bad = [];
  for (const [name, value] of Object.entries(publicApi)) {
    if (isAcceptableExport(value)) continue;
    bad.push(...unfrozenPaths(value, name));
  }
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
});

test('★ 门禁自检：逐层判据在内核侧也能判别（否则是恒真假绿）', () => {
  assert.deepEqual(unfrozenPaths(Object.freeze({ inner: { n: 1 } }), 'probe'), ['probe.inner —— 未冻结']);
  assert.deepEqual(unfrozenPaths(publicApi.DIAGNOSTICS_CONTRACT, 'DIAGNOSTICS_CONTRACT'), [],
    '契约是逐层冻结的 —— 若这里变红，说明源码的冻结层级掉了（诊断契约另有专门门禁再钉一次）');
  assert.ok(Object.keys(publicApi).some(n => typeof publicApi[n] === 'object'),
    '内核导出里必须确实有对象，否则本门禁是空扫');
});
