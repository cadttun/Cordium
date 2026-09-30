// 基础示例：装配宿主 → 从文件加载插件 → 启动 → 调用服务与动作 → 级联停用与恢复。
// 运行：node examples/basic/main.mjs
import { CordiumHost } from '@cordium/kernel';
import { loadPlugins } from '@cordium/plugins/loader';

const host = new CordiumHost();

// 装配方定义服务契约与权限名；插件不能自造
host.declarePermissions(['perm.audit']);
host.declareServiceContracts({
  kv: { access: 'declared', methods: ['get', 'set'] },   // 须在 dependencies 里声明提供者才能取
  greeter: { access: 'public', methods: ['greet'] }
});

// 插件放在哪都行，清单里写绝对路径或 file: URL；这里以本文件为基准
const plugin = (name) => new URL(`./plugins/${name}.mjs`, import.meta.url);
await loadPlugins(host, [
  { module: plugin('store') },
  { module: plugin('greeter'), config: { greeting: 'Hello' } },
  { module: plugin('audit') }
]);
await host.boot();   // 按依赖顺序激活：store → greeter，audit 无依赖

const states = () => host.getDiagnostics().plugins.map(p => `${p.id}=${p.state}`).join(' ');
console.log('booted:', states());

const greeter = host.getInternalService('greeter');
console.log(greeter.greet('Ada'));
console.log(greeter.greet('Ada'));
console.log(greeter.greet('Linus'));

// 动作的调用方身份由宿主注入：以 example.audit 的身份调它自己的动作（它持有 perm.audit）
console.log('audit:', await host.dispatchAction('example.audit', 'audit.report'));

// 停用 store ⇒ 依赖它的 greeter 先被连带停下
await host.deactivatePlugin('example.store');
console.log('store off:', states());
try {
  host.getInternalService('greeter');
} catch (err) {
  console.log('greeter now:', err.code);   // no_provider：greeter 已停用，它提供的服务被宿主收回
}
try {
  greeter.greet('Ada');
} catch (err) {
  console.log('stale greeter:', err.code); // scope_disposed：停用后旧实例的 ctx 失效，不要长期留着
}

// 重新激活 store ⇒ greeter 自动恢复（kv 是新实例，计数从头开始）
await host.activatePlugin('example.store');
console.log('store on:', states());
console.log(host.getInternalService('greeter').greet('Ada'));
