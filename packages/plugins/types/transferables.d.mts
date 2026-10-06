/**
 * @file packages/plugins/src/transferables.mjs
 * @description 隔离端回传结果时要移交哪些二进制（纯函数）。包内工具，不在 `exports`。
 *
 * ★ 必须零依赖：isolation-runner 在 process 档的权限模型下只能读本目录，import 内核会直接读不到文件。
 */
/** 结果里可移交的 ArrayBuffer：顶层，或数组 / 普通对象的一层成员。共享内存（SharedArrayBuffer）不可移交，跳过。 */
export declare function transferables(value: any): any[];
