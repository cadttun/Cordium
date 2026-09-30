// 提供 greeting 服务。改下面的 text 再保存，main.mjs 会热重载本插件。
// 只在 ctx 上登记东西（登记型）⇒ 可以声明 hotReload: true。
export const manifest = {
  id: 'example.greeting',
  name: 'Greeting',
  version: '1.0.0',
  apiVersion: '1.0.0',
  provides: ['greeting'],
  hotReload: true
};

export function activate(ctx) {
  const text = 'Hello';
  ctx.provideService('greeting', { text: () => text });
}
