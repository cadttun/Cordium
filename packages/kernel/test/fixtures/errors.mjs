/**
 * @file packages/kernel/test/fixtures/errors.mjs
 * @description 按错误码断言：`assert.throws(fn, hasCode('scope_disposed'))`。
 *
 * ★ 为什么按码不按报文：报文只给人看，措辞随时会改；`code` 才是调用方分支所依据的契约。
 *   测试按报文断言 = 把「给人看的文字」钉成了契约，改一个词就红一片。
 * ★ 可选的 `detail` 正则：只用于「报文里必须点名肇事者」这类断言（插件 id / 服务名要出现在报文里，
 *   否则排查时不知道是谁）—— 码先对，再核细节。
 */
import assert from 'node:assert/strict';
import { CordiumError } from '../../src/index.mjs';

export function hasCode(code, detail) {
  return (err) => {
    assert.ok(err instanceof CordiumError, `应抛 CordiumError，实际：${err?.name}: ${err?.message}`);
    assert.equal(err.code, code, `错误码应为 '${code}'，实际 '${err.code}'：${err.message}`);
    if (detail) assert.match(err.message, detail);
    return true;
  };
}
