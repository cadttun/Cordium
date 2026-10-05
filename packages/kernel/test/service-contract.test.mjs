// @cross-package: plugins —— plugins 是【被测对象】（断言两层 validateManifest 逐字一致）
/**
 * @file packages/kernel/test/service-contract.test.mjs
 * @description 服务契约与访问级别的回归门禁
 *
 * 缺陷背景：registerService 此前在服务未声明时【自动创建契约】，
 * 于是「谁先注册谁决定该服务的安全级别」—— 插件可以替宿主把自己的服务
 * 降级为 public，或把 requiredPermission 置空来取消权限门。
 *
 * 修复后：契约只能由宿主装配层（上层应用，经 host.declareServiceContracts）声明，
 * 未登记的服务一律拒绝注册，且默认级别取最严格值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost, CordiumError, ServiceAccess, validateManifest } from '../src/index.mjs';
import { MANIFEST_FIELD_TABLE, diffManifestFields, diffServiceContractFields } from '../src/internal.mjs';
import { contractInfo, pluginInfo } from './fixtures/inspect.mjs';
import { NEUTRAL_SERVICE_CONTRACTS } from './fixtures/neutral-service-contracts.mjs';
import { NEUTRAL_PLUGIN_MANIFEST } from './fixtures/neutral-plugin.mjs';


test('未由宿主声明的服务必须拒绝注册（禁止「先注册先得」自定义安全级别）', async () => {
  const host = new CordiumHost();
  host.registerPlugin({
    id: 'plugin.rogue',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.rogue']
  }, {
    async activate(ctx) {
      ctx.provideService('service.rogue', { ok: true });
    }
  });

  await assert.rejects(
    () => host.boot(),
    hasCode('undeclared_service', /Service 'service\.rogue' has no host-declared contract/),
    '插件不得靠抢先注册替宿主定义服务的安全级别'
  );
});

test('契约的 access 默认取【最严格】级别（忘记声明不等于放行）', () => {
  const host = new CordiumHost();
  host.declareServiceContract('service.untagged');

  const contract = contractInfo(host, 'service.untagged');
  assert.equal(
    contract.access,
    ServiceAccess.SENSITIVE,
    '缺省必须是 sensitive，绝不能不声明就自动 public —— 那等于静默降级'
  );
  // （原有一条 `declaredBy === 'host'` 断言已移除：该字段是硬编码常量、宿主私有，
  //   公开面观察不到；插件无法伪造契约由上方「未登记服务一律拒绝注册」那条测试守护。）
});

test('重复声明不得覆盖既有安全级别（插件无法把宿主声明的服务降级）', () => {
  const host = new CordiumHost();
  host.declareServiceContract('service.guarded', {
    access: ServiceAccess.SENSITIVE,
    requiredPermission: 'perm.guarded'
  });

  // 模拟「后来者试图降级」
  host.declareServiceContract('service.guarded', { access: ServiceAccess.PUBLIC });

  const contract = contractInfo(host, 'service.guarded');
  assert.equal(contract.access, ServiceAccess.SENSITIVE, '已声明的级别不可被后续声明降级');
  assert.equal(contract.requiredPermission, 'perm.guarded', '权限要求同样不可被抹掉');
});

test('declareServiceContracts 批量装载（宿主装配入口）', () => {
  const host = new CordiumHost();
  host.declareServiceContracts({
    'service.alpha': { access: ServiceAccess.PUBLIC },
    'service.beta': { access: ServiceAccess.DECLARED }
  });

  assert.equal(host.getDiagnostics().services.length, 2);
  assert.equal(contractInfo(host, 'service.alpha').access, 'public');
  assert.equal(contractInfo(host, 'service.beta').access, 'declared');
});

test('optionalDependencies 必须能被 validateManifest 保留（白名单不得吞字段）', () => {
  // validateManifest 是白名单重建：函数里未列出的键会被静默丢弃。
  // 一旦漏掉这一行，插件 manifest 里写好的可选依赖就会凭空消失，
  // 表现为「声明了等于没声明」，且没有任何报错。
  const manifest = validateManifest({
    id: 'plugin.opt',
    version: '1.0.0',
    apiVersion: '1.0.0',
    optionalDependencies: { 'plugin.optional.dep': '^1.0.0' }
  });

  assert.deepEqual(
    manifest.optionalDependencies,
    { 'plugin.optional.dep': '^1.0.0' },
    '可选依赖声明被白名单吞掉 ⇒ 后续的可选依赖解析会全部失效'
  );
});

// 「契约表必须登记全仓所有生产 provideService 服务名」是上层应用的仓库级门禁
//   （扫它自己的插件、比对它自己的契约表），与内核机制无关，不在这里。

// ============================================================================
// Manifest 丢字段的【结构化诊断】—— 从「完全静默」改为「可见且带归属」
// ============================================================================

test('共享字段表存在且两层 schema 都有声明', () => {
  // 共享字段表是「读同一类载荷只应有一处代码」的落点：
  // 两套 validator 各自手写白名单时，漏列一个字段就会静默丢弃（本项目已踩两次）。
  assert.ok(Array.isArray(MANIFEST_FIELD_TABLE.kernel), '内核层字段表必须存在');
  assert.ok(Array.isArray(MANIFEST_FIELD_TABLE.plugin), '插件层字段表必须存在');
  assert.ok(MANIFEST_FIELD_TABLE.kernel.includes('optionalDependencies'), '内核层必须承认 optionalDependencies');
  assert.ok(MANIFEST_FIELD_TABLE.plugin.includes('config'), '插件层必须承认 config');
});

test('diffManifestFields 只报「输入有、输出没有」的字段', () => {
  const input = { id: 'p', version: '1.0.0', extraField: 'x' };
  const output = { id: 'p', version: '1.0.0', displayName: 'p', description: '' };

  const d = diffManifestFields('kernel', input, output, 'p');
  assert.ok(d, 'extraField 被丢弃，必须产出诊断');
  assert.deepEqual(d.fields, ['extraField'], '只应报真正被丢的字段');
  assert.equal(d.path, 'kernel', '诊断必须带层次归属');
  assert.equal(d.pluginId, 'p', '诊断必须带插件归属');
  assert.equal(d.severity, 'warn');

  // ★ 反例：displayName/description 是【带默认值】的可选字段（输入没有、输出有）
  //   —— 它们是「凭空出现」不是「被丢弃」，绝不能报成问题。
  assert.ok(
    !d.fields.includes('displayName') && !d.fields.includes('description'),
    '带默认值的可选字段不得被误报为「被丢弃」（否则是误报，会淹没真问题）'
  );
});

test('无丢弃字段时返回 null（调用方零开销跳过）', () => {
  const m = { id: 'p', version: '1.0.0' };
  assert.equal(diffManifestFields('kernel', m, { ...m, displayName: 'p' }, 'p'), null);
});

test('宿主把丢字段写入结构化诊断，且日志同步可见', () => {
  const host = new CordiumHost({ hostVersion: '1.0.0' });
  host.registerPlugin({
    id: 'plugin.dropped',
    version: '1.0.0',
    apiVersion: '1.0.0',
    typoField: 'oops'          // ← 未在白名单 ⇒ 会被静默丢弃
  });

  const diag = host.getDiagnostics().manifestDiagnostics;
  assert.equal(diag.length, 1, '必须恰好记录一条诊断');
  assert.equal(diag[0].path, 'kernel', '必须标明是【内核层】schema 丢的');
  assert.equal(diag[0].pluginId, 'plugin.dropped', '必须标明是哪个插件');
  assert.deepEqual(diag[0].fields, ['typoField']);

  // ★ 两个通道都要走：诊断是「快照」（随时可查），日志是「事件流」（即时可见）
  assert.ok(
    host.getDiagnostics().recentLogs.some(l => l.message.includes('typoField')),
    '宿主 log 必须同步可见（装插件那一刻就能看到）'
  );
});

test('反例：未注入 sink 时，描述符层校验行为与改动前完全一致', () => {
  // 本项的全部改动都必须是「可观测性增强」，不得改变任何校验结果。
  const host = new CordiumHost({ hostVersion: '1.0.0' });
  host.registerPlugin({ id: 'plugin.clean', version: '1.0.0', apiVersion: '1.0.0' });
  assert.equal(
    host.getDiagnostics().manifestDiagnostics.length,
    0,
    '字段齐全时不得产生任何诊断（否则每次装插件都会刷噪音）'
  );
});

// ============================================================================
// 数组依赖静默损坏修复 / 诊断分级 / 共享规范化 / 跨入口一致性
// ============================================================================

test('★ 数组形式 dependencies 一律拒 —— 一个字段只留一种形态', () => {
  // 为什么取消：数组项**没有位置写版本范围**，只能一律当 `'*'`
  //   ⇒ 「用数组声明依赖」= 自动放弃版本约束，且**零提示**。
  //   它与已修的「非法范围字符串」「空串」同源 —— `'*'` 是那几条 fail-open 路径共同的兜底值。
  //   （历史上数组还会被对象展开成 `{0:'a'}` 污染鉴权快照；现在这条路径整个不存在了。）
  const base = { id: 'plugin.arr', version: '1.0.0', apiVersion: '1.0.0' };
  assert.throws(() => validateManifest({ ...base, dependencies: ['plugin.parent'] }),
    hasCode('invalid_manifest', /got an array/), 'dependencies 传数组必须被拒（且理由是「数组」本身，不是落到对象分支被误拒）');
  assert.throws(() => validateManifest({ ...base, optionalDependencies: ['plugin.opt'] }),
    hasCode('invalid_manifest', /got an array/), '可选依赖同形，必须一并拒');
  // ★ 正向对照：对象形式仍然收下 —— 否则上面两条可能是「一律拒绝」伪装成判别
  assert.deepEqual(
    validateManifest({ ...base, dependencies: { 'plugin.parent': '^1.0.0' } }).dependencies,
    { 'plugin.parent': '^1.0.0' }
  );
});

test('★ 依赖键必须是真实依赖名（不得被压成下标），鉴权快照随之正确', async () => {
  const host = new CordiumHost({ hostVersion: '1.0.0' });
  const got = {};
  host.declareServiceContracts({ 'service.parent': { access: ServiceAccess.DECLARED } });
  host.registerPlugin(
    { id: 'plugin.parent', version: '1.0.0', apiVersion: '1.0.0', provides: ['service.parent'] },
    { async activate(ctx) { ctx.provideService('service.parent', { ok: () => true }); } }
  );
  host.registerPlugin(
    { id: 'plugin.child', version: '1.0.0', apiVersion: '1.0.0', dependencies: { 'plugin.parent': '*' } },
    { async activate(ctx) { got.svc = ctx.getService('service.parent'); } }
  );

  assert.deepEqual(
    Object.keys(pluginInfo(host, 'plugin.child').dependencies),
    ['plugin.parent'],
    '依赖必须记录真实依赖名，不能被数组下标污染'
  );
  await host.boot();   // ← 修复前这里会抛 `Missing dependency '0' required by 'plugin.child'`
  // ★ 鉴权依据在【注册时】快照 —— 这里正是被污染的地方。
  //   用行为判别：declared 服务只放行「声明了该提供者」的调用方，
  //   若快照被污染成 Set(['0'])，这里会伪装成 Security Violation。
  assert.equal(got.svc.ok(), true, '鉴权快照必须记录真实依赖名，declared 服务必须可取');
});

test('★ 诊断按「是否真未知」分级：跨层字段是 info，真错别字才是 warn', () => {
  // 误报背景：内置 manifest 被【两层共用】，插件层不保留 displayName/description，
  // 但内核层保留着 ⇒ 字段根本没丢。原实现一律报 warn ⇒ 实测 6/6 全误报。
  const crossLayer = diffManifestFields(
    'plugin',
    { id: 'p', name: 'P', displayName: 'P 显示名' },
    { id: 'p', name: 'P' },
    'p'
  );
  assert.equal(crossLayer.severity, 'info', '★ displayName 属于内核层字段 ⇒ 是跨层保留，不得报 warn');
  assert.deepEqual(crossLayer.crossLayerFields, ['displayName']);
  assert.deepEqual(crossLayer.unknownFields, []);

  const typo = diffManifestFields(
    'kernel',
    { id: 'p', typooField: 1 },
    { id: 'p' },
    'p'
  );
  assert.equal(typo.severity, 'warn', '★ 两层都不认的字段才是真未知 ⇒ 必须 warn');
  assert.deepEqual(typo.unknownFields, ['typooField']);
});

test('★ 反例：共用 manifest 的插件走描述符层【不得产生 warn】', async () => {
  // 修掉的【假警报】：此前共用 manifest 的插件每次启动各刷一条 warn。
  //   被测对象是**跨层字段识别机制**，夹具用 cordium 自持的中立插件。
  const mod = NEUTRAL_PLUGIN_MANIFEST;
  const runtime = await import('@cordium/plugins/runtime');
  const out = runtime.validatePluginManifest(mod);
  const d = diffManifestFields('plugin', mod, out, mod.id);

  assert.ok(d, '共用 manifest 确实带 displayName/description ⇒ 应产出诊断（但只作 info）');
  assert.equal(d.severity, 'info', '★ 不得报 warn —— 那是误报');
  assert.ok(
    d.crossLayerFields.includes('displayName') && d.crossLayerFields.includes('description'),
    '这两个字段属于内核层，必须被识别为【跨层保留】'
  );
  assert.deepEqual(d.unknownFields, [], '不得把跨层字段误判为「未知字段」');
});

test('★ 依赖归一化是【共享实现】—— 三处入口产出必须逐字一致', async () => {
  const runtime = await import('@cordium/plugins/runtime');
  const eco = await import('@cordium/plugins/ecosystem');

  const inputs = [
    ['对象形式', { 'plugin.a': '^1.0.0' }],
    ['键值带空格', { ' plugin.a ': ' ^1.0.0 ' }],
    ['范围为空串（⇒ *，与 npm 一致）', { 'plugin.a': '' }],
    ['空输入', undefined]
  ];

  // ★ 数组形式已取消 —— 三处入口必须【一致地拒】，而不是各自为政（这才是「共享实现」的含义）
  for (const [label, deps] of [['数组形式', ['plugin.a', 'plugin.b']], ['数组含空串', ['  ', 'plugin.a']]]) {
    const km = { id: 'p', version: '1.0.0', apiVersion: '1.0.0', dependencies: deps };
    const pm = { id: 'p', name: 'n', version: '1.0.0', apiVersion: '1.0.0', dependencies: deps };
    assert.throws(() => validateManifest({ ...km }), hasCode('invalid_manifest', /got an array/), `★ [${label}] 内核层必须拒`);
    assert.throws(() => runtime.validatePluginManifest({ ...pm }), hasCode('invalid_manifest', /got an array/), `★ [${label}] 插件层必须拒`);
    assert.throws(() => eco.normalizeDependencies(deps), hasCode('invalid_manifest', /got an array/), `★ [${label}] ecosystem 必须拒`);
  }

  for (const [label, deps] of inputs) {
    const kernelOut = validateManifest({ id: 'p', version: '1.0.0', apiVersion: '1.0.0', dependencies: deps }).dependencies;
    const pluginOut = runtime.validatePluginManifest({ id: 'p', name: 'n', version: '1.0.0', apiVersion: '1.0.0', dependencies: deps }).dependencies;
    const ecoOut = eco.normalizeDependencies(deps);
    assert.deepEqual(kernelOut, pluginOut, `★ [${label}] 内核层与插件层依赖归一必须一致`);
    assert.deepEqual(kernelOut, ecoOut, `★ [${label}] 内核层与 ecosystem 依赖归一必须一致`);
  }
});

test('★ 两层【共享字段】的 canonical 形状必须一致（拼写错误类的输入不再各归各的）', async () => {
  const runtime = await import('@cordium/plugins/runtime');
  const shared = ['id', 'version', 'apiVersion', 'provides', 'permissions', 'dependencies'];

  const inputs = [
    { id: 'p', name: 'n', version: '1.0.0', apiVersion: '1.0.0' },
    { id: 'p', name: 'n', version: '1.0.0', apiVersion: '1.0.0', provides: ['a', 'b'] },
    { id: 'p', name: 'n', version: '1.0.0', apiVersion: '1.0.0', dependencies: { 'plugin.a': '^1.0.0' } }
  ];

  for (const input of inputs) {
    const k = validateManifest({ ...input });
    const p = runtime.validatePluginManifest({ ...input });
    for (const field of shared) {
      assert.deepEqual(k[field], p[field], `★ 共享字段 ${field} 在两层必须产出相同 canonical 值`);
    }
  }
});

test('★ 畸形依赖在两层都响亮失败（invalid_manifest），不再 fail-open', async () => {
  // ★ 此前锁的是「宽容退化为 {} / '*'」——`{ p: 2 }` 任意版本放行、`'oops'` 依赖整体消失。
  //   依赖范围是版本门禁的输入，输入错了必须响亮失败。
  const runtime = await import('@cordium/plugins/runtime');
  const eco = await import('@cordium/plugins/ecosystem');
  const isInvalidManifest = err => err.code === 'invalid_manifest';

  const cases = [
    ['字符串', 'oops'], ['数字', 42], ['布尔', true],
    ['范围为数字', { 'plugin.a': 2 }], ['范围为 null', { 'plugin.a': null }],
    ['数组含非字符串', ['plugin.a', 3]]
  ];
  for (const [label, malformed] of cases) {
    for (const field of ['dependencies', 'optionalDependencies']) {
      assert.throws(
        () => validateManifest({ id: 'p', version: '1.0.0', apiVersion: '1.0.0', [field]: malformed }),
        err => isInvalidManifest(err) && err.message.startsWith(field) && err.pluginId === 'p',
        `[${label}] 内核层 ${field} 必须抛 invalid_manifest（报文指明字段、带 pluginId）`
      );
    }
    assert.throws(
      () => runtime.validatePluginManifest({ id: 'p', name: 'n', version: '1.0.0', apiVersion: '1.0.0', dependencies: malformed }),
      isInvalidManifest,
      `[${label}] 插件层必须与内核层同一判定`
    );
  }

  // ecosystem 独立入口：整体类型错保留既有码 invalid_dependencies；条目类型错走共享实现
  assert.throws(() => eco.normalizeDependencies('oops'), err => err.code === 'invalid_dependencies');
  assert.throws(() => eco.normalizeDependencies({ 'plugin.a': 2 }), isInvalidManifest);
});

test('★ 列表类字段：宽松输入（带空格元素）在两层都必须【被 trim 后接受】', async () => {
  // ★ 回归修正：曾加过 `item.trim() === item` 检查，
  //   把 `[' a ']` 从「通过并 trim」变成「抛错」—— 那是计划外的行为变更。
  const runtime = await import('@cordium/plugins/runtime');

  assert.deepEqual(
    validateManifest({ id: 'p', version: '1.0.0', apiVersion: '1.0.0', provides: [' a ', 'b'] }).provides,
    ['a', 'b'], '内核层应 trim 后接受'
  );
  assert.deepEqual(
    runtime.validatePluginManifest({ id: 'p', name: 'n', version: '1.0.0', apiVersion: '1.0.0', provides: [' a ', 'b'] }).provides,
    ['a', 'b'], '★ 插件层必须与改动前逐字一致：trim 后接受，不得抛错'
  );
  // 空串/纯空白仍然被拒（这是原有语义，不得放松）
  assert.throws(
    () => runtime.validatePluginManifest({ id: 'p', name: 'n', version: '1.0.0', apiVersion: '1.0.0', provides: ['  '] }),
    hasCode('invalid_manifest'),
    '空串元素必须仍被拒绝'
  );
});

test('门禁：字段表必须与 validator 实际产出的键【逐字同步】（预防未来漂移）', async () => {
  // ★ 定位：这是【预防性】门禁 —— 当前两层都一致，所以它今天全绿是正常的。
  //   它防的是「以后有人给 validator 加了字段却忘了登记字段表」（本项目已踩两次）。
  //
  // ★★ 本门禁此前**只断言了内核层**，注释却写着「当前两层都一致」
  //    —— **口径与代码不符**。后果在加 `kind` 字段时实测暴露：
  //    给内核层 `validateManifest` 加了 `kind`、也登记了 `MANIFEST_FIELD_TABLE.plugin`，
  //    但**插件层 `runtime.mjs` 的 validateManifest 没跟着改**，而本门禁**看不见**这一层
  //    ⇒ 会让插件层拿到 `kind` 缺失的 manifest，且本门禁看不见。
  //    ⇒ 本门禁现在**两层都断言**，与注释口径对齐。

  const kernelActual = Object.keys(validateManifest({ id: 'p', version: '1.0.0', apiVersion: '1.0.0' })).sort();
  const kernelDeclared = [...MANIFEST_FIELD_TABLE.kernel].sort();
  assert.deepEqual(kernelActual, kernelDeclared, '★ 内核层：字段表与实际产出必须逐字同步（新增字段必须同步登记）');

  // ★ 插件层：走的是**另一套** validateManifest（`plugins/src/runtime.mjs`），
  //   同样必须与 `MANIFEST_FIELD_TABLE.plugin` 逐字同步。
  const { validatePluginManifest } = await import('@cordium/plugins/runtime');
  const pluginActual = Object.keys(
    validatePluginManifest({ id: 'p', name: 'P', version: '1.0.0', apiVersion: '1.0.0' })
  ).sort();
  const pluginDeclared = [...MANIFEST_FIELD_TABLE.plugin].sort();
  assert.deepEqual(pluginActual, pluginDeclared, '★ 插件层：字段表与实际产出必须逐字同步（新增字段必须同步登记）');
});

test('★ 判别性：门禁本身必须能变红（模拟「新增字段漏登记」）', () => {
  // 反例的「替换是否真的生效」必须自证 —— 直接构造一个与字段表不符的产出，断言检查会失败。
  const fakeOutput = Object.keys(validateManifest({ id: 'p', version: '1.0.0', apiVersion: '1.0.0' }));
  fakeOutput.push('brandNewFieldNotRegistered');   // ← 模拟漏登记
  const declared = [...MANIFEST_FIELD_TABLE.kernel].sort();
  assert.notDeepEqual(
    fakeOutput.sort(),
    declared,
    '★ 若新增字段未登记字段表，本门禁必须能识别出不一致（否则门禁不判别任何东西）'
  );
});

// ══════════════════════════════════════════════════════════════════════
// 服务契约的【白名单重建】同样必须报告丢字段
//
// 背景（实测）：`declareServiceContract(name, options)` 只把 3 个键重建进契约记录，
//   其余**静默丢弃且零报错** —— 加一个契约维度却忘了在记录里接，表现是
//   「声明成功但行为零变化」，比报错更难查。本项目已因同类形状踩过两次。
// ══════════════════════════════════════════════════════════════════════

test('diffServiceContractFields 只报「输入有、记录里没有」的键', () => {
  const input = { access: 'public', requiredPermission: 'perm.x', futureField: 'X' };
  const record = { access: 'public', requiredPermission: 'perm.x', declaredBy: 'host', providers: new Map() };

  const d = diffServiceContractFields('service.demo', input, record);
  assert.ok(d, 'futureField 被丢弃，必须产出诊断');
  assert.deepEqual(d.fields, ['futureField'], '只应报真正被丢的键');
  assert.equal(d.path, 'service-contract', '诊断必须标明是【契约层】丢的');
  assert.equal(d.pluginId, 'service.demo', '归属槽填服务名（契约由宿主声明，无插件归属）');
  assert.equal(d.severity, 'warn', '契约没有「跨层合法字段」这回事 ⇒ 一律 warn');

  // ★ 反例：记录里的内部字段（declaredBy / providers）是【凭空出现】不是【被丢弃】，
  //   绝不能报成问题 —— 否则每次声明契约都会刷噪音。
  assert.ok(
    !d.fields.includes('declaredBy') && !d.fields.includes('providers'),
    '记录内部字段不得被误报为「被丢弃」'
  );
});

test('无丢弃键时返回 null（调用方零开销跳过）', () => {
  const input = { access: 'public' };
  const record = { access: 'public', requiredPermission: null };
  assert.equal(diffServiceContractFields('service.demo', input, record), null);
});

test('★ 判别性：契约记录必须【真的】丢掉未知键（自证反例前提成立）', () => {
  // 若哪天契约改成 `{...defaults, ...options}` 不做白名单重建，
  // 上面那条「必须产出诊断」就会失去意义 —— 本测试把那个前提钉住。
  const host = new CordiumHost();
  host.declareServiceContract('service.probe', { access: 'public', futureField: 'X' });
  // 诊断 = diff(输入, 契约记录)：只有记录【真的】丢了 futureField，它才会被点名
  assert.deepEqual(
    host.getDiagnostics().manifestDiagnostics.flatMap(d => d.fields),
    ['futureField'],
    '★ 未知键必须被白名单挡在契约记录之外 —— 若它进了记录，契约丢字段的整条诊断就无从谈起'
  );
  assert.equal(contractInfo(host, 'service.probe').access, 'public', '合法键必须照常生效（诊断不得影响正常路径）');
});

test('宿主把契约丢字段写入结构化诊断，且日志同步可见', () => {
  const host = new CordiumHost();
  host.declareServiceContract('service.typo', { access: 'public', requirdPermission: 'perm.typo' });

  const diag = host.getDiagnostics().manifestDiagnostics;
  assert.equal(diag.length, 1, '必须恰好记录一条诊断');
  assert.equal(diag[0].path, 'service-contract');
  assert.equal(diag[0].pluginId, 'service.typo');
  assert.deepEqual(diag[0].fields, ['requirdPermission'], '拼错的键必须被点名');

  // ★ 两个通道都要走：诊断是「快照」，日志是「事件流」
  assert.ok(
    host.getDiagnostics().recentLogs.some(l => l.message.includes('requirdPermission')),
    '宿主 log 必须同步可见'
  );
  // ★ 日志措辞不得写死 "Manifest" —— 本方法已被三个层次共用
  assert.ok(
    host.getDiagnostics().recentLogs.some(l => l.message.includes('[service-contract]')),
    '日志必须带层次归属，且措辞不得偏袒 manifest'
  );
});

test('反例：合法契约不得产生任何诊断（否则装配期刷噪音）', () => {
  const host = new CordiumHost();
  // 装配路径：契约表一次性声明（★ 用 cordium 自持的中立夹具，不含业务服务名）
  host.declareServiceContracts(NEUTRAL_SERVICE_CONTRACTS);
  assert.equal(
    host.getDiagnostics().manifestDiagnostics.length,
    0,
    '★ 字段齐全时零诊断 —— 否则每次装配都会刷满诊断环形缓冲'
  );
});

// ══════════════════════════════════════════════════════════════════════
// 字段表【不直接驱动】重建（归一化是独立的一层，不塞进表里），
//   但表里的每一格都必须有消费者，且每个字段都必须被归一化处理过。
//   一条查「defaultsOnly 这格说的是真的」；一条查「处理了没有」—— 字段表同步门禁只查「键在不在表里」。
// ══════════════════════════════════════════════════════════════════════

const KERNEL_BASE = { id: 'p', version: '1.0.0', apiVersion: '1.0.0' };
const PLUGIN_BASE = { ...KERNEL_BASE, name: 'P' };

test('★ defaultsOnly 接活：每个字段在输入省略时，输出里必须有【非 undefined】的值', () => {
  const out = validateManifest(KERNEL_BASE);
  for (const field of MANIFEST_FIELD_TABLE.defaultsOnly) {
    assert.ok(MANIFEST_FIELD_TABLE.kernel.includes(field) || MANIFEST_FIELD_TABLE.plugin.includes(field),
      `defaultsOnly 的 '${field}' 必须是某一层的字段`);
    assert.ok(field in out && out[field] !== undefined,
      `★ '${field}' 声明为「带默认值」，省略时输出却没有值 —— 表里这格是假的`);
  }
});

function shapeOf(v) {
  return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
}

async function layers() {
  const { validatePluginManifest } = await import('@cordium/plugins/runtime');
  return [
    ['kernel', validateManifest, KERNEL_BASE],
    ['plugin', validatePluginManifest, PLUGIN_BASE]
  ];
}

test('★ 归一化覆盖：每层每个字段收到畸形值 ⇒ 要么归一成与缺省同形，要么抛 CordiumError，不得静默穿过', async () => {
  const MALFORMED = [null, [], {}, 42];
  const leaks = [];
  for (const [layer, validate, base] of await layers()) {
    const canonical = validate(base);
    for (const field of MANIFEST_FIELD_TABLE[layer]) {
      for (const bad of MALFORMED) {
        let out;
        try {
          out = validate({ ...base, [field]: bad });
        } catch (err) {
          if (!(err instanceof CordiumError)) leaks.push(`${layer}.${field}=${JSON.stringify(bad)} 抛了非 CordiumError：${err?.name}`);
          continue;
        }
        if (shapeOf(out[field]) !== shapeOf(canonical[field])) {
          leaks.push(`${layer}.${field}=${JSON.stringify(bad)} ⇒ ${shapeOf(out[field])}（应为 ${shapeOf(canonical[field])}）`);
        } else if (bad !== null && typeof bad === 'object' && out[field] === bad) {
          leaks.push(`${layer}.${field}=${JSON.stringify(bad)} 原样透传（同一引用）`);
        }
      }
    }
  }
  assert.deepEqual(leaks, [], `★ 这些字段没被归一化：\n${leaks.join('\n')}`);
});
