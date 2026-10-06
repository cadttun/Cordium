/**
 * @param {((diagnostic: object) => void) | null | undefined} onDiagnostic
 * @returns {(diagnostic: object | null) => void} 空诊断（null）直接跳过
 */
export declare function diagnosticSink(onDiagnostic: ((diagnostic: object) => void) | null | undefined): (diagnostic: object | null) => void;
