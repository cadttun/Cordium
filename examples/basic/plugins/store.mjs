// 键值存储：提供 kv 服务。只在 ctx 上登记东西（登记型），可以热重载。
export const manifest = {
  id: 'example.store',
  name: 'Store',
  version: '1.0.0',
  apiVersion: '1.0.0',
  provides: ['kv'],
  hotReload: true
};

export function activate(ctx) {
  const data = new Map();
  ctx.provideService('kv', {
    get: (key) => data.get(key),
    set: (key, value) => { data.set(key, value); }
  });
}
