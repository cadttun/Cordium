/**
 * @file packages/plugins/src/diagnostic-sink.mjs
 * @description 可选诊断回调的校验（catalog / ecosystem 共用）。
 *
 * ★ 单独成文件、不进 package.json 的 `exports`：这是包内工具，不是公开面。
 */
import { CordiumError, ErrorCode } from '@cordium/kernel/internal';

/**
 * @param {((diagnostic: object) => void) | null | undefined} onDiagnostic
 * @returns {(diagnostic: object | null) => void} 空诊断（null）直接跳过
 */
export function diagnosticSink(onDiagnostic) {
  if (onDiagnostic === undefined || onDiagnostic === null) return () => {};
  if (typeof onDiagnostic !== 'function') {
    throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'onDiagnostic must be a function');
  }
  return (diagnostic) => { if (diagnostic) onDiagnostic(diagnostic); };
}
