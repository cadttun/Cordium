// 问候：依赖 store，提供 greeter 服务；每次问候计数并发出 greeted 事件。
export const manifest = {
  id: 'example.greeter',
  name: 'Greeter',
  version: '1.0.0',
  apiVersion: '1.0.0',
  provides: ['greeter'],
  dependencies: { 'example.store': '^1.0.0' },
  hotReload: true
};

export function activate(ctx, config) {
  const greeting = config.greeting ?? 'Hello';
  ctx.provideService('greeter', {
    greet(name) {
      // 每次现取句柄：store 被停用 / 替换后旧句柄失效
      const kv = ctx.getService('kv');
      const count = (kv.get(name) ?? 0) + 1;
      kv.set(name, count);
      ctx.emit('greeted', { name, count });
      return `${greeting}, ${name}! (#${count})`;
    }
  });
}
