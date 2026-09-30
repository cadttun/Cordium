// 每秒打印一次问候。持有一个定时器 —— 交给 ctx.scope 托管，停用时宿主自动清掉，
// 所以它也能声明 hotReload: true。自己开的端口、文件、子进程同理：在 ctx.scope.addDisposer 里释放干净才能写。
export const manifest = {
  id: 'example.ticker',
  name: 'Ticker',
  version: '1.0.0',
  apiVersion: '1.0.0',
  dependencies: { 'example.greeting': '^1.0.0' },
  hotReload: true
};

export function activate(ctx, config) {
  const tick = () => {
    // 每次现取：greeting 被热重载后旧句柄失效（本插件也会被停下再拉起，拿到新的 ctx）
    console.log(`[tick] ${ctx.getService('greeting').text()}, ${config.name}!`);
  };
  tick();
  ctx.scope.trackTimer(setInterval(tick, config.intervalMs));
}
