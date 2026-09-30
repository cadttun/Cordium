/**
 * @file packages/plugins/test/fixtures/errors.mjs
 * @description 按错误码断言（同 kernel/test/fixtures/errors.mjs 的口径）。
 *
 * ★ 为什么不直接 import kernel 的那份：测试夹具不在 @cordium/kernel 的 `exports` 里，
 *   跨包相对路径（`../../kernel/test/…`）由 boundary 门禁禁止。
 *   错误类经包名取 —— 与 plugins/src 取用内核的方式一致。
 */
import assert from 'node:assert/strict';
import { CordiumError } from '@cordium/kernel';

export function hasCode(code, detail) {
  return (err) => {
    assert.ok(err instanceof CordiumError, `应抛 CordiumError，实际：${err?.name}: ${err?.message}`);
    assert.equal(err.code, code, `错误码应为 '${code}'，实际 '${err.code}'：${err.message}`);
    if (detail) assert.match(err.message, detail);
    return true;
  };
}
