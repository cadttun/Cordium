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
export function throwLater(kind) {
  const values = { undefined, null: null, symbol: Symbol('s'), number: 42 };
  setTimeout(() => { throw values[kind]; });
  return new Promise(() => {});
}
export function throwValue(kind) {
  const values = { undefined, null: null, symbol: Symbol('s'), number: 42, badMessage: { get message() { throw new Error('x'); } }, badName: { get name() { throw new Error('x'); } }, badCode: { get code() { throw new Error('x'); } } };
  throw values[kind];
}
