/**
 * @file packages/plugins/src/payload.mjs
 * @description `callIsolated` 的负载体积估算（纯函数）。包内工具，不在 `exports`。
 */
import { measureValue } from '@cordium/kernel/internal';

/** payloadBytes 最多看这么多个节点：够判出「大二进制 / 长字符串」，又不至于为了估算把海量小对象走一遍 */
export const PAYLOAD_SCAN_NODES = 100_000;

/**
 * 负载的大致字节数（用于在途总量限额，不求精确）。测量规则与内核日志预算同一份实现（`measureValue`）：
 *   · 二进制按【整个底层 buffer】计 —— 结构化克隆复制的是整块 buffer，不只是视图那一段（实测）；同一块只计一次；
 *   · 字符串按长度计；其它标量每个 8 字节；容器本身不计；
 *   · 最多看 PAYLOAD_SCAN_NODES 个节点，之后不再累加（估算偏小，但真正的大头 —— 二进制 / 长串 —— 通常在前面）。
 * 取值抛错的怪对象（getter / Proxy）不计入，真正发送时由克隆报错。
 */
export function payloadBytes(value) {
  return measureValue(value, { maxNodes: PAYLOAD_SCAN_NODES }).bytes;
}
