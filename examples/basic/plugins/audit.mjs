// 审计：监听 greeted 事件并记下来，经 audit.report 动作交出记录。与 greeter 互不 import，只经宿主交互。
export const manifest = {
  id: 'example.audit',
  name: 'Audit',
  version: '1.0.0',
  apiVersion: '1.0.0',
  permissions: ['perm.audit']
};

export function activate(ctx) {
  const records = [];
  ctx.on('greeted', ({ name, count }) => { records.push(`${name}#${count}`); });
  ctx.registerAction('audit.report', {
    requiredPermission: 'perm.audit',
    handler: () => [...records]
  });
}

export function deactivate() {
  // 可选：这里只需释放自己开的外部资源；监听器、动作由宿主回收
}
