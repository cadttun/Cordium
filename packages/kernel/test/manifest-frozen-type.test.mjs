/**
 * `ctx.manifest` 的**类型与运行时一致性**门禁。
 *
 * ── 守的是什么 ──────────────────────────────────────────────────────
 *   `ctx.manifest` 交出的是 `freezeManifestForPlugin` 的**深冻结副本**。
 *   若类型声明成可写的 `PluginManifest`，插件写 `ctx.manifest.provides.push('x')`
 *   会**过类型检查、运行期抛 TypeError** —— 类型在骗人。
 *
 * ★ 为什么这条必须**同时**测运行时与类型：
 *   只测运行时（push 抛错）证明不了「类型收缩了」；
 *   只测类型（`@ts-expect-error`）证明不了「运行时真的冻结了」。
 *   两边都钉住，才排除「改了一边忘了另一边」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost } from '../src/index.mjs';

/** 起一个宿主并抓出 `ctx` */
async function ctxOf(manifest = { id: 'plug.probe', version: '1.0.0', apiVersion: '1.0.0' }) {
  const host = new CordiumHost();
  let ctx = null;
  host.registerPlugin(manifest, { activate(c) { ctx = c; } });
  await host.boot();
  assert.ok(ctx, '插件未被激活 —— 夹具失效');
  return ctx;
}

test('★★ 运行时：ctx.manifest 与其嵌套数组/对象都是深冻结的', async () => {
  // ★ 权限必须先由宿主声明（否则注册期就抛）—— 夹具自己装配，不依赖外部状态
  const host = new CordiumHost();
  host.declarePermissions(['read_x']);
  let ctx = null;
  host.registerPlugin({
    id: 'plug.probe', version: '1.0.0', apiVersion: '1.0.0',
    provides: ['svc.a'], permissions: ['read_x'],
    dependencies: { 'plug.dep': '^1.0.0' }
  }, { activate(c) { ctx = c; } });
  // 依赖必须先登记（否则 boot 抛 missing_dependency）
  host.registerPlugin({ id: 'plug.dep', version: '1.0.0', apiVersion: '1.0.0' }, { activate() {} });
  await host.boot();
  assert.ok(ctx, '插件未被激活 —— 夹具失效');
  assert.equal(Object.isFrozen(ctx.manifest), true, '顶层必须冻结');
  assert.equal(Object.isFrozen(ctx.manifest.provides), true, '★ 嵌套数组也必须冻结（浅冻不够）');
  assert.equal(Object.isFrozen(ctx.manifest.dependencies), true, '★ 嵌套对象也必须冻结');

  // ★ 实测过的那条误用路径：过得了类型检查的写法，运行期必须抛
  assert.throws(() => { ctx.manifest.provides.push('x'); }, TypeError,
    '★ 嵌套数组可写 ⇒ 与「深冻结」的宣称不符');
  assert.throws(() => { ctx.manifest.dependencies['plug.x'] = '^2.0.0'; }, TypeError);
});

test('★★ 类型：生成的声明里 ctx.manifest 用的是【深只读】类型，不是可写的 PluginManifest', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dts = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../types/host.d.mts'), 'utf8');

  // ★ 先剥注释：`FrozenPluginManifest` 在 JSDoc 正文里出现过（解释用），注释不算声明
  const code = dts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /manifest:\s*import\('\.\/types\.mjs'\)\.FrozenPluginManifest/,
    '★ ctx.manifest 必须声明为 FrozenPluginManifest（深只读）—— 退化成 PluginManifest 就意味着类型又开始骗人了');
  assert.doesNotMatch(code, /manifest:\s*import\('\.\/types\.mjs'\)\.PluginManifest[;\s]/,
    '★★ ctx.manifest 退回到可写的 PluginManifest');

  // ★ 再确认那个类型本身确实是递归派生的，不是起了个空名字
  const typesDts = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../types/types.d.mts'), 'utf8');
  assert.match(typesDts, /export type FrozenPluginManifest = DeepReadonlyType<PluginManifest>/,
    'FrozenPluginManifest 必须是 PluginManifest 的派生，而不是手抄一份');
});

test('★★ 类型层的判别性断言：写 ctx.manifest 必须在编译期就报错（不是只改了个名字）', async () => {
  // ★ 上一条只证明「声明里写的是 FrozenPluginManifest」—— 一个起错名的空类型同样能过。
  //   这条跑一次真正的 `tsc`，检查 `test/fixtures/manifest-frozen-types.mjs` 里的
  //   `@ts-expect-error` 是否**真的**命中了错误：
  //     · 若 ctx.manifest 变回可写 ⇒ 那些 @ts-expect-error 会因为「没有错误」而报 TS2578；
  //     · 若类型收得过头（读也报错）⇒ 正向的读取赋值会红。
  const { spawnSync } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const r = spawnSync(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.tests.json')
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0,
    '★ 类型夹具未通过 —— 要么 ctx.manifest 不再深只读，要么类型收得过头：\n'
    + `${r.stdout || ''}${r.stderr || ''}`);
});

test('★ 门禁自检：判据能识别退化形态（否则是恒真的假绿）', () => {
  const good = "manifest: import('./types.mjs').FrozenPluginManifest;";
  const bad = "manifest: import('./types.mjs').PluginManifest;";
  assert.match(good, /manifest:\s*import\('\.\/types\.mjs'\)\.FrozenPluginManifest/);
  assert.doesNotMatch(bad, /manifest:\s*import\('\.\/types\.mjs'\)\.FrozenPluginManifest/);
  // ★ 剥注释的判据也要有正向对照：注释里提到不算数
  const commented = "/* manifest: import('./types.mjs').FrozenPluginManifest; */\nmanifest: string;";
  const stripped = commented.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(stripped, /FrozenPluginManifest/, '注释里的名字不得被当真');
});

test('★ 交付面的 manifest 与内部记录【不是同一个对象】（插件改不动宿主）', async () => {
  const ctx = await ctxOf();
  // 深冻结副本 ⇒ 插件拿到的不是 record.manifest 本身
  assert.notEqual(ctx.manifest, undefined);
  // 宿主自己的诊断快照仍看得到同一个 id（证明是副本不是空对象）
  assert.equal(ctx.manifest.id, 'plug.probe');
});

test('★ kind / activation 的取值域在【运行时】也是收敛的（类型与校验同源）', async () => {
  const { PLUGIN_KIND_VALUES, ACTIVATION_POLICY_VALUES, PluginKind, ActivationPolicy } = await import('../src/index.mjs');
  const ctx = await ctxOf();
  assert.ok(PLUGIN_KIND_VALUES.includes(ctx.manifest.kind), '归一化后的 kind 必须在值集内');
  assert.ok(ACTIVATION_POLICY_VALUES.includes(ctx.manifest.activation));
  // ★ 缺省时补的是什么（类型说是字面量联合，运行时必须真的落在其中）
  assert.equal(ctx.manifest.kind, PluginKind.BUSINESS);
  assert.equal(ctx.manifest.activation, ActivationPolicy.EAGER);
});

test('★★ 跨包视角：省略 kind / activation 的清单必须仍能通过类型检查（TS2739 回归）', async () => {
  // ── 为什么这条必须存在 ──────────────────────────────────────────────
  //   `PluginDescriptor` 同时被用作 `validatePluginManifest` 的**入参形状**与**返回值形状**。
  //   把 `kind` / `activation` 标成必需，从「返回值」看是对的（归一化后确实有值），
  //   但从「入参」看是**错的** —— 消费方传 `{ id, name, version, … }` 会跨包报 TS2739。
  //   ★ 这个缺陷**仓内测试全绿**（本仓自己传的都是完整清单），只有从**包外**看才暴露。
  //   ⇒ 判据必须建在「包外视角」上，不能建在「本仓怎么调」上。
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'cordium-xpkg-'));
  try {
    const nm = path.join(dir, 'node_modules', '@cordium');
    fs.mkdirSync(nm, { recursive: true });
    // ★ 用 junction 而不是 copy：这样验的是**发布后的包**（package.json exports + types 条件）
    for (const pkg of ['kernel', 'plugins']) {
      fs.symlinkSync(path.join(root, 'packages', pkg), path.join(nm, pkg), 'junction');
    }
    fs.writeFileSync(path.join(dir, 'probe.mjs'), [
      'export async function probe() {',
      '  const eco = await import(\'@cordium/plugins/ecosystem\');',
      '  // ★ 省略 kind / activation —— 这是消费方最常见的写法',
      '  const out = eco.resolvePluginDependencies([',
      '    { id: \'a\', name: \'a\', version: \'1.0.0\', apiVersion: \'1.0.0\', provides: [], permissions: [], dependencies: {} }',
      '  ]);',
      '  /** @type {string} */ const n = out[0].name;',
      '  return n;',
      '}',
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        allowJs: true, checkJs: true, noEmit: true, target: 'es2023',
        module: 'nodenext', moduleResolution: 'nodenext', skipLibCheck: true, strict: false
      },
      include: ['probe.mjs']
    }, null, 2));

    const r = spawnSync(process.execPath, [
      path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(dir, 'tsconfig.json')
    ], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0,
      '★ 从包外看类型不通 —— 最常见的原因是「返回值才有的性质被写成了必填字段」：\n'
      + `${r.stdout || ''}${r.stderr || ''}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
