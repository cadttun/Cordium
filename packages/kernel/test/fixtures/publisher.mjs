/**
 * @file packages/kernel/test/fixtures/publisher.mjs
 * @description 测试用发布者：注册并激活一个空插件，交出它的根 ctx。
 *
 * ★ host.channel 私有 —— 测试不能再 `host.channel.emit(...)`。
 *   根 ctx 的 emit 派发键是全局（undefined），与原 `channel.emit` 同一语义，且走的是插件公开路径。
 */
let seq = 0;

export async function addPublisher(host, id = `fixture.publisher-${++seq}`) {
  let ctx = null;
  host.registerPlugin({ id, version: '1.0.0', apiVersion: '1.0.0' }, { activate(c) { ctx = c; } });
  await host.activatePlugin(id);
  return ctx;
}
