/**
 * @file packages/kernel/src/semver-api.mjs
 * @description 对外交出的 SemVer 入口：把 semver.mjs 的 `TypeError` 转成带码的 `CordiumError`。
 *
 * ★ 为什么另起一个文件：`semver.mjs` 的边界是「不得 import 任何东西」（依赖图里最稳定的一层），
 *   它不能自己去认识 `CordiumError`。于是在导出边界上包一层 —— 内核内部照旧直接用 semver.mjs
 *   （内部调用方要么已先校验过版本，要么自己 catch），只有交到调用方手里的那一份带码。
 * ★ 内部实现文件，经 index.mjs / internal.mjs 转出，不单独出现在 exports 里。
 */

import * as raw from './semver.mjs';
import { CordiumError, ErrorCode } from './errors.mjs';
import { describeError } from './host-util.mjs';

function coded(fn, what) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      if (err instanceof CordiumError) throw err;
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `${what}: ${describeError(err)}`, { cause: err });
    }
  };
}

/** SemVer 优先级比较；任一参数非法 ⇒ `invalid_argument` */
export const compareSemVer = coded(raw.compareSemVer, 'compareSemVer');
/** 解析版本范围；非法 ⇒ `invalid_argument` */
export const parseRange = coded(raw.parseRange, 'parseRange');
// 这两个本来就不抛（非法输入返回 false），原样转出
export const { isValidSemVer, satisfiesSemVer } = raw;
