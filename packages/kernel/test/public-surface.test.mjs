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

test('★ index.mjs 导出清单定稿（显式具名，不得随模块新增 export 自动变大）', () => {
  assert.deepEqual(Object.keys(publicApi).sort(), [
    'ACTIVATION_POLICY_VALUES', 'ActivationPolicy', 'CordiumError', 'CordiumHost',
    // ★ DIAGNOSTICS_CONTRACT：诊断快照的稳定性契约 —— 消费方必须能读到它，
    //   否则「哪些字段可信」只能靠人传（它是对外承诺本身，不是内部实现细节）。
    'DIAGNOSTICS_CONTRACT',
    'DispatchMode', 'EffectScope', 'ErrorCode', 'KERNEL_API_VERSION', 'LOG_LEVEL_VALUES', 'LifecycleState', 'LogLevel', 'MessageChannel',
    'PLUGIN_KIND_VALUES', 'PluginKind', 'SERVICE_ACCESS_VALUES', 'ServiceAccess',
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
