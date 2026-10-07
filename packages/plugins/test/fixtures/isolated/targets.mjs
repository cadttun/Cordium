// callIsolated 的测试目标（中立夹具）
import fs from 'node:fs';
export const add = (a, b) => a + b;
export async function later(v) { await new Promise(r => setTimeout(r, 5)); return v; }
export function spin() { for (;;) { /* 同步死循环 */ } }
export function boom() { const e = new Error('boom'); e.code = 'plugin_boom'; throw e; }
export function readFile(p) { return fs.readFileSync(p, 'utf8').length; }
export function giveFunction() { return () => 1; }
export const notAFunction = 42;
export default function hello(name) { return `hello ${name}`; }
export const kinds = (...xs) => xs.map(x => Object.prototype.toString.call(x) + (x instanceof Map ? `:${x.size}` : ""));
export async function sleep(ms) { await new Promise(r => setTimeout(r, ms)); return ms; }
export const byteLen = (b) => b.byteLength;
export const makeBytes = (n) => new Uint8Array(n).fill(7);
export const makeBytesObj = (n) => ({ label: 'x', data: new Uint8Array(n).fill(9) });
export function heapHog() { const a = []; for (;;) a.push({ x: Math.random() }); }
/**
 * ★ 有界堆填充：分配 n 个小对象后【正常返回】。
 *
 * 与 `heapHog`（无界，永远撞上限才停）的关键区别：**它会不会死，只取决于上限装不装得下**，
 * 与机器快慢无关 ⇒ 让「`maxMemoryMb` 有没有真的接线」可以被**非计时**地判定。
 * （`heapHog` 撞上限只是「早晚」问题，摘掉接线它照样会死，于是只能用「多快死」去区分 ——
 *  而 CI 的 windows runner 实测同一条正常调用在 178ms~3664ms 之间浮动（20 倍），
 *  任何绝对墙钟阈值都必然在某个 runner 上假红。）
 *
 * 标定（Windows / Node v24，每对象约 32–64 B）：
 *   上限 32MB：1M / 2M / 4M 全 OOM；64MB：1M 通过、2M OOM；128MB：2M 通过、4M OOM；256MB：4M 通过。
 *   ⇒ 2M 个对象 ≈ 64–128 MB：32MB 上限装不下、256MB 上限装得下。
 */
export function heapFill(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = { x: i + 0.5 }; return a.length; }
export function throwLater(kind) {
  const values = { undefined, null: null, symbol: Symbol('s'), number: 42 };
  setTimeout(() => { throw values[kind]; });
  return new Promise(() => {});
}
export function throwValue(kind) {
  const values = { undefined, null: null, symbol: Symbol('s'), number: 42, badMessage: { get message() { throw new Error('x'); } }, badName: { get name() { throw new Error('x'); } }, badCode: { get code() { throw new Error('x'); } } };
  throw values[kind];
}
