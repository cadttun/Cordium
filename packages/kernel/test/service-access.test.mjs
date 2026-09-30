/**
 * @file packages/kernel/test/service-access.test.mjs
 * @description 服务访问门禁与鉴权依据隔离的回归门禁
 *
 * 缺陷背景（两条，必须一起修）：
 *   ① getService 此前没有任何访问门禁 —— 任何插件都能取任何服务，
 *      且调用方身份由参数传入，可随意伪造。
 *   ② dispatchAction 的鉴权读 caller.manifest.permissions —— 那正是交给插件的
 *      同一个对象，插件 push 一个字符串就能给自己提权。
 *
 * 修复后：身份由 ctx.getService 的闭包注入；门禁读宿主自持的
 * pluginDependencies / pluginPermissions 快照，与插件对象彻底脱钩。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost, LifecycleState } from '../src/index.mjs';
import { pluginState, pluginInfo } from './fixtures/inspect.mjs';

/** 两个提供者插件，服务分属不同 provider —— 用于验证「依赖声明的是具体提供者」 */
const PROVIDER_A = {
  id: 'plugin.provider.a',
  version: '1.0.0',
  apiVersion: '1.0.0',
  provides: ['service.pub', 'service.dec']
};
const PROVIDER_B = {
  id: 'plugin.provider.b',
  version: '1.0.0',
  apiVersion: '1.0.0',
  provides: ['service.sens', 'service.int']
};

/** 每个提供者只注册【自己的】服务：若两个插件都注册同名服务，后注册者会覆盖 activeProviderId */
function registerProvider(host, manifest, serviceNames) {
  host.registerPlugin(manifest, {
    activate(ctx) {
      for (const name of serviceNames) {
        ctx.provideService(name, { tag: name });
      }
    }
  });
}

const ALL_SERVICES = ['service.pub', 'service.dec', 'service.sens', 'service.int', 'service.optional'];

function makeHost() {
  const host = new CordiumHost();
  host.declareServiceContracts({
    'service.pub': { access: 'public' },
    'service.dec': { access: 'declared' },
    'service.sens': { access: 'sensitive', requiredPermission: 'perm.sens' },
    'service.int': { access: 'internal' },
    'service.optional': { access: 'declared', optionalProvider: 'plugin.not.installed' }
  });
  registerProvider(host, PROVIDER_A, ['service.pub', 'service.dec']);
  registerProvider(host, PROVIDER_B, ['service.sens', 'service.int']);
  return host;
}

/** 注册一个消费者插件，在 activate() 里逐个尝试取服务并记录结果 */
function addConsumer(host, id, manifestExtra = {}) {
  const captured = { results: {}, stateDuringActivate: null, ctx: null, rawManifest: null };
  const rawManifest = {
    id,
    version: '1.0.0',
    apiVersion: '1.0.0',
    permissions: [],
    dependencies: {},
    ...manifestExtra
  };
  captured.rawManifest = rawManifest;
  host.registerPlugin(rawManifest, {
    async activate(ctx) {
      captured.ctx = ctx;
      captured.stateDuringActivate = pluginState(host, id);
      for (const name of ALL_SERVICES) {
        try {
          captured.results[name] = { ok: true, value: ctx.getService(name) };
        } catch (err) {
          captured.results[name] = { ok: false, message: err.message, code: err.code };
        }
      }
    }
  });
  return captured;
}

test('public 可取；declared 需声明该提供者；sensitive 需权限；internal 一律拒绝', async () => {
  const host = makeHost();
  // 只声明了 provider.a，没有 provider.b，也没有 perm.sens
  const captured = addConsumer(host, 'plugin.consumer.plain', {
    dependencies: { 'plugin.provider.a': '^1.0.0' }
  });

  await host.boot();

  assert.equal(captured.results['service.pub'].ok, true, 'public 无需额外校验');
  assert.equal(captured.results['service.dec'].ok, true, 'declared 且已声明该提供者 ⇒ 通过');

  assert.equal(captured.results['service.sens'].ok, false, '未声明 provider.b ⇒ 拒绝');
  assert.match(captured.results['service.sens'].message, /did not declare a dependency on provider 'plugin\.provider\.b'/);

  assert.equal(captured.results['service.int'].ok, false, 'internal 禁止插件取用');
  assert.match(captured.results['service.int'].message, /is internal and cannot be accessed by plugins/);
});

test('声明了提供者但缺少权限，sensitive 服务仍被拒绝', async () => {
  const host = makeHost();
  const captured = addConsumer(host, 'plugin.consumer.noperm', {
    dependencies: { 'plugin.provider.b': '^1.0.0' }
    // 注意：没有 permissions: ['perm.sens']
  });
  await host.boot();

  assert.equal(captured.results['service.sens'].ok, false);
  assert.match(captured.results['service.sens'].message, /lacks required permission 'perm\.sens'/);
});

test('声明了提供者且持有权限，sensitive 服务可正常取用', async () => {
  const host = makeHost();
  const captured = addConsumer(host, 'plugin.consumer.full', {
    dependencies: { 'plugin.provider.b': '^1.0.0' },
    permissions: ['perm.sens']
  });
  await host.boot();

  assert.equal(captured.results['service.sens'].ok, true, '依赖 + 权限齐备 ⇒ 通过');
  assert.equal(captured.results['service.sens'].value.tag, 'service.sens');
});

test('插件在 activate() 期间（ACTIVATING）即可取用已声明的依赖', async () => {
  const host = makeHost();
  const captured = addConsumer(host, 'plugin.consumer.early', {
    dependencies: { 'plugin.provider.a': '^1.0.0' }
  });
  await host.boot();

  assert.equal(
    captured.stateDuringActivate,
    LifecycleState.ACTIVATING,
    '取依赖时插件确实处于 ACTIVATING —— 门禁不得限制为「仅 ACTIVE」'
  );
  assert.equal(captured.results['service.dec'].ok, true, '激活期间取依赖必须成功');
});

test('篡改 manifest 的 permissions 与 dependencies 均无法提权', async () => {
  const host = makeHost();
  const captured = addConsumer(host, 'plugin.tamper', {
    dependencies: { 'plugin.provider.b': '^1.0.0' }
    // 没有 perm.sens
  });

  await host.boot();

  // 篡改前：被权限门拒绝
  assert.equal(captured.results['service.sens'].ok, false);
  assert.match(captured.results['service.sens'].message, /lacks required permission/);

  // ★ 从【所有对外可达的 manifest 引用】下手篡改（模拟「万一插件拿到了可写引用」）：
  //   ① 注册时传进去的原始对象（调用方手里一直留着）；
  //   ② getDiagnostics() 交出的插件视图。
  //   （ctx.manifest 是冻结副本，另有专条测试。）宿主记录本身已私有化，外部够不着。
  //   鉴权读的是 pluginPermissions 快照，改这些对象应当【完全无效】。
  captured.rawManifest.permissions.push('perm.sens');
  captured.rawManifest.dependencies['plugin.legit.hack'] = '^1.0.0';
  const record = pluginInfo(host, 'plugin.tamper');
  record.permissions.push('perm.sens');
  record.dependencies['plugin.legit.hack'] = '^1.0.0';

  assert.throws(
    () => captured.ctx.getService('service.sens'),
    hasCode('access_denied', /lacks required permission 'perm\.sens'/),
    '改了 manifest 对象仍然提不了权 —— 鉴权依据必须是宿主自持的快照'
  );
});

test('篡改 manifest.dependencies 无法获得未声明的服务访问权', async () => {
  const host = makeHost();
  // 只声明 provider.a，没声明 provider.b —— 本就不该能取到 service.sens
  const captured = addConsumer(host, 'plugin.tamper.dep', {
    dependencies: { 'plugin.provider.a': '^1.0.0' }
  });
  await host.boot();

  assert.equal(captured.results['service.dec'].ok, true, '已声明的 provider.a 服务正常');
  assert.equal(captured.results['service.sens'].ok, false, '未声明的 provider.b 服务被拒');

  // 篡改：把 provider.b 塞进宿主对外交出的 manifest 视图 + 注册时的原始对象
  captured.rawManifest.dependencies['plugin.provider.b'] = '^1.0.0';
  const record = pluginInfo(host, 'plugin.tamper.dep');
  record.dependencies['plugin.provider.b'] = '^1.0.0';

  assert.throws(
    () => captured.ctx.getService('service.sens'),
    hasCode('access_denied', /did not declare a dependency on provider 'plugin\.provider\.b'/),
    '改 manifest.dependencies 拿不到服务访问权 —— 依赖快照同样由宿主自持'
  );
});

test('ctx.manifest 交付的是逐层冻结副本，插件写它会直接抛错', async () => {
  const host = makeHost();
  const captured = addConsumer(host, 'plugin.frozen', {
    dependencies: { 'plugin.provider.a': '^1.0.0' }
  });
  await host.boot();

  const { manifest } = captured.ctx;
  assert.ok(Object.isFrozen(manifest), 'manifest 本身冻结');
  assert.ok(Object.isFrozen(manifest.permissions), 'permissions 数组必须一并冻结（浅冻结挡不住 push）');
  assert.ok(Object.isFrozen(manifest.dependencies), 'dependencies 对象必须一并冻结');
  assert.ok(Object.isFrozen(manifest.provides), 'provides 数组必须一并冻结');

  assert.throws(
    () => manifest.permissions.push('perm.sens'),
    TypeError,
    '严格模式（ESM 默认）下写冻结对象必须抛错，而不是静默失败'
  );
});

test('身份缺省即拒绝，绝不默认放行（防止布尔豁免式的绕过）', async () => {
  const host = makeHost();
  await host.boot();

  assert.throws(
    () => host.getService('service.pub'),
    hasCode('identity_required'),
    '不传身份不得放行 —— 否则「不传身份」就成了豁免开关'
  );
});

test('getInternalService 不接受调用方身份参数（边界由方法所属对象决定）', async () => {
  const host = makeHost();
  await host.boot();

  // ★ 原为 `.length === 1 / 2` 的 arity 断言 —— **不判别**：
  //   在默认值参数之后加一个身份参数，`.length` 不变，照样全绿；还反过来逼生产代码「必须带默认值」。
  //   改为行为判据：边界由【方法所属对象】决定，不由参数决定。

  // 内部入口可越过插件门禁（宿主装配路径）
  assert.equal(host.getInternalService('service.int').tag, 'service.int');
  // ★ 第二参是作用域键，不是身份：塞一个【已注册、已激活】的插件 ID 也不会触发任何鉴权
  //   （用真实 ID 而非虚构 ID：否则插件入口会先因「调用方未注册」被拒，测不到 internal 门）
  assert.equal(host.getInternalService('service.int', 'plugin.provider.a').tag, 'service.int',
    '内部入口不得因「看起来像身份」的第二参而开始鉴权');
  // 插件入口对同一服务、同样的调用形状必须拒绝 —— 两个入口的差别在方法，不在参数
  assert.throws(
    () => host.getService('service.int', 'plugin.provider.a'),
    hasCode('access_denied'),
    '插件入口必须按身份过门禁'
  );
});

test('可选依赖的提供者未安装时，返回可程序化区分的 optional_unavailable', async () => {
  const host = makeHost();
  const captured = addConsumer(host, 'plugin.consumer.optional', {
    dependencies: { 'plugin.provider.a': '^1.0.0' },
    optionalDependencies: { 'plugin.not.installed': '^1.0.0' }
  });
  await host.boot();

  const result = captured.results['service.optional'];
  assert.equal(result.ok, false);
  assert.equal(
    result.code,
    'optional_unavailable',
    '必须是稳定错误码 —— 调用方靠它区分「可选依赖没装（合法）」与「服务真的坏了（异常）」'
  );
  assert.match(result.message, /provider 'plugin\.not\.installed' is not installed/);
});

test('可选提供者【存在但版本不兼容】时，同样返回 optional_unavailable（不得伪装成可用）', async () => {
  const host = makeHost();   // service.optional 的 optionalProvider 是 plugin.not.installed

  // 提供者「装了」，但版本是 2.0.0，而调用方要的是 ^1.0.0
  host.registerPlugin({
    id: 'plugin.not.installed',
    version: '2.0.0',
    apiVersion: '1.0.0',
    provides: ['service.optional']
  }, { async activate() {} });   // 版本不兼容 ⇒ 运行期视为不可用，故它不提供服务

  const captured = addConsumer(host, 'plugin.consumer.versioned', {
    dependencies: { 'plugin.provider.a': '^1.0.0' },
    optionalDependencies: { 'plugin.not.installed': '^1.0.0' }
  });
  await host.boot();

  const result = captured.results['service.optional'];
  assert.equal(result.ok, false);
  assert.equal(
    result.code,
    'optional_unavailable',
    '★ 版本不兼容必须与「未安装」返回同一个稳定错误码 —— 约定是'
      + '「版本不符时跳过拓扑依赖，运行期视为不可用」，不能让它退化成普通错误'
  );
  assert.match(
    result.message,
    /v2\.0\.0 does not satisfy the declared optional range '\^1\.0\.0'/
  );
});

test('可选提供者【版本兼容且已安装】却取不到服务时，按真异常处理（不得被降级吞掉）', async () => {
  const host = makeHost();

  // 版本刚好匹配（1.0.0 满足 ^1.0.0），插件确实装了
  host.registerPlugin({
    id: 'plugin.not.installed',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.optional']
  }, { async activate() {} });   // 但它激活时没有注册服务 —— 这是真异常，不是「可选依赖没装」

  const captured = addConsumer(host, 'plugin.consumer.realproblem', {
    dependencies: { 'plugin.provider.a': '^1.0.0' },
    optionalDependencies: { 'plugin.not.installed': '^1.0.0' }
  });
  await host.boot();

  const result = captured.results['service.optional'];
  assert.equal(result.ok, false);
  assert.notEqual(
    result.code,
    'optional_unavailable',
    '★ 依赖装了、版本也对 ⇒ 取不到服务是【真异常】。若这里也返回可选不可用，'
      + '调用方会静默降级，把真正的问题吞掉'
  );
  assert.match(result.message, /has no active providers/);
});

test('★ getDiagnostics() 交出的是【副本】—— 往 provides 里 push 不得绕过 registerService 的 provides 校验', async () => {
  // 缺陷背景：诊断此前直接交出 record.manifest 的活数组/对象。
  //   宿主字段私有化后，这是外部唯一还能摸到 record.manifest 的出口 ——
  //   往 provides 里 push 一个服务名，就能冒领一个未在 manifest 里声明的服务。
  const host = new CordiumHost();
  host.declareServiceContracts({ 'service.hijack': { access: 'public' } });
  host.registerPlugin(
    { id: 'plugin.sneaky', version: '1.0.0', apiVersion: '1.0.0' },   // 没有 provides
    { async activate(ctx) { ctx.provideService('service.hijack', { who: () => 'SNEAKY' }); } }
  );

  const view = pluginInfo(host, 'plugin.sneaky');
  view.provides.push('service.hijack');
  view.permissions.push('perm.any');
  view.dependencies['plugin.any'] = '*';

  await assert.rejects(host.activatePlugin('plugin.sneaky'), hasCode('provide_not_declared'),
    '诊断视图不得是宿主记录的写入口');
  assert.deepEqual(pluginInfo(host, 'plugin.sneaky').provides, [], '宿主记录不得被诊断视图污染');
});
