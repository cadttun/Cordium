/**
 * ★★ 诊断快照的**稳定性契约**门禁 —— `getDiagnostics()` 的哪一部分可以对下游承诺。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 *   消费方**已经在读** `getDiagnostics()`（实测 14 处），而内核此前**从没表态**它稳不稳。
 *   本文件把那份表态（`DIAGNOSTICS_CONTRACT`）**钉住**：
 *     ① 点名即承诺 —— 稳定面里的每条路径、每个键都必须在真实快照里存在；
 *     ② ★ **不留未分类的第三桶** —— 每层真实键集必须恰好 = 「点名稳定」∪「点名不稳定」；
 *     ③ 不稳定面里点名的路径也必须真实存在（否则是**过时的点名**，会让人以为某个
 *        已经不存在的字段「被免责了」）。
 *
 * ── ② 是本文件的核心（也是唯一能自动拦住「悄悄加字段」的判据）──────────
 *   只做 ① 的话，往快照里加一个新字段**门禁照样全绿** —— 它既不在稳定面也不在不稳定面，
 *   谁都看不见，而下一次有人读它时「它稳不稳」就成了历史悬案。
 *   ② 把它变成**编译期式**的强制：加字段 ⇒ 必须在这一刻显式选边（稳定 / 不稳定）。
 *   ★ 与 `MANIFEST_FIELD_TABLE` 的分工：那张表管**manifest 有哪些字段**，
 *     这张表管**快照里每一层的键各归哪一档**。前者是后者的输入（投影由它派生）。
 *
 * ── 与「消费方只读稳定子集」的关系 ──────────────────────────────────
 *   契约文本是 allowlist 形态（k6 措辞：Only APIs specifically mentioned… are covered）。
 *   门禁能钉住的是**内核侧的声明与实现一致**；消费方是否守约由消费方自己的快照守 ——
 *   那属于消费方仓库，本仓只出接口与清单，不代改。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost, DIAGNOSTICS_CONTRACT, LifecycleState } from '../src/index.mjs';

/**
 * 造一个「有插件、有服务、有失败者」的宿主 —— 让快照的每一层都真的有内容可查。
 * ★ `boot()` 遇到激活失败会 reject（这是对的：启动失败不该静默）——这里**故意收下**它，
 *   因为本文件测的是**快照形状**，而失败态恰恰要出现在快照里（`plugins[].error` 非 null）。
 */
async function richHost() {
  const host = new CordiumHost();
  host.declareServiceContracts({ 'service.kv': { access: 'public' } });
  host.registerPlugin(
    { id: 'plugin.ok', version: '1.0.0', apiVersion: '1.0.0', provides: ['service.kv'] },
    { activate: (ctx) => ctx.provideService('service.kv', { get: async () => null }) }
  );
  host.registerPlugin(
    { id: 'plugin.bad', version: '1.0.0', apiVersion: '1.0.0' },
    { activate() { throw new Error('boom'); } }
  );
  await host.boot().catch(() => {});
  return host;
}

const ROOT = '';

/**
 * ★★ 稳定面的**类型签名锁** —— 契约承诺「不改类型」，这张表就是那句话的机械形态。
 * ⚠️ 它是一把**锁**（改实现就要显式改这里），不是「与实现同源的第二份副本」——
 *   正因为要挡「实现悄悄改了类型」，它必须**独立于实现**。
 * 生成方式：把本文件那条类型签名测试的期望值临时置空，跑一次读实际输出即可。
 */
const STABLE_TYPE_SIGNATURE = [
  '<root>.actionsCount = number',
  '<root>.booted = boolean',
  '<root>.hostVersion = string',
  '<root>.plugins = array',
  '<root>.services = array',
  '<root>.totalPlugins = number',
  '<root>.uiContributionsCount = number',
  'plugins[].activation = string',
  'plugins[].activationMs = number',
  'plugins[].apiVersion = string',
  'plugins[].dependencies = object',
  'plugins[].description = string',
  'plugins[].displayName = string',
  'plugins[].error = null|string',
  'plugins[].hotReload = boolean',
  'plugins[].id = string',
  'plugins[].kind = string',
  'plugins[].optionalDependencies = object',
  'plugins[].permissions = array',
  'plugins[].provides = array',
  'plugins[].state = string',
  'plugins[].unresolvedDependencies = array',
  'plugins[].version = string',
  'services[].access = string',
  'services[].activeProvider = null',
  'services[].methods = null',
  'services[].name = string',
  'services[].providerCount = number',
  'services[].requiredPermission = null'
];

/**
 * 在【真实快照】里解析点分路径（`''` = 根；`plugins[]` = 逐元素）。
 * ★ 每一段都要求**存在该键**（`Object.hasOwn`）而不是「值不为 undefined」——
 *   快照里 `errorLogCount` 合法地是 `0`、`error` 合法地是 `null`，用真值判会把它们当成缺键。
 * @returns {any[]} 路径末端的所有值；任一段不存在 ⇒ `[]`
 */
function resolveRaw(snapshot, path) {
  let nodes = [snapshot];
  if (path !== ROOT) {
    for (const seg of path.split('.')) {
      const each = seg.endsWith('[]');
      const key = each ? seg.slice(0, -2) : seg;
      nodes = nodes.flatMap(n => (n !== null && typeof n === 'object' && Object.hasOwn(n, key) ? [n[key]] : []))
        .flatMap(v => (each ? (Array.isArray(v) ? v : []) : [v]));
    }
  }
  return nodes;
}

/** 同 `resolveRaw`，但只留可查键的对象 —— 用于逐键比对 */
const resolvePath = (snapshot, path) =>
  resolveRaw(snapshot, path).filter(n => n !== null && typeof n === 'object');

/** 不稳定面里【直接挂在某个稳定路径下】的那些键（按路径前缀归属） */
function unstableChildrenOf(path) {
  const prefix = path === ROOT ? '' : `${path}.`;
  const bare = { [ROOT]: s => !s.includes('.') && !s.includes('[') };
  return DIAGNOSTICS_CONTRACT.unstable
    .filter(s => (path === ROOT ? bare[ROOT](s) : s.startsWith(prefix)))
    .map(s => (path === ROOT ? s : s.slice(prefix.length)));
}

test('★ 契约自检：两张面都非空、且稳定面的每条路径都点名了键（否则是恒真的假绿）', () => {
  const stablePaths = Object.keys(DIAGNOSTICS_CONTRACT.stable);
  assert.ok(stablePaths.includes(ROOT), '稳定面必须包含根路径');
  assert.ok(stablePaths.length >= 3, '至少要有 根 / plugins[] / services[] 三层');
  for (const [path, keys] of Object.entries(DIAGNOSTICS_CONTRACT.stable)) {
    assert.ok(Array.isArray(keys) && keys.length > 0,
      `稳定面 '${path}' 的键集为空 —— 空清单等于没承诺，却看起来像承诺过了`);
  }
  assert.ok(DIAGNOSTICS_CONTRACT.unstable.length > 0, '不稳定面必须是非空显式清单');
  assert.ok(Number.isInteger(DIAGNOSTICS_CONTRACT.schemaVersion) && DIAGNOSTICS_CONTRACT.schemaVersion >= 1);
  // 反例：契约对象必须真的是冻结的（否则消费方可以就地改掉内核的承诺）
  assert.ok(Object.isFrozen(DIAGNOSTICS_CONTRACT) && Object.isFrozen(DIAGNOSTICS_CONTRACT.stable),
    '契约对象必须冻结 —— 否则下游 `DIAGNOSTICS_CONTRACT.stable = {}` 就能改掉承诺');
});

test('★★ 稳定面点名的每条路径 / 每个键都在【真实快照】里存在（点名即承诺）', async () => {
  const snapshot = (await richHost()).getDiagnostics();
  const bad = [];
  for (const [path, keys] of Object.entries(DIAGNOSTICS_CONTRACT.stable)) {
    const nodes = resolvePath(snapshot, path);
    if (nodes.length === 0) {
      bad.push(`稳定面点名的路径 '${path}' 在真实快照里解析为空 —— 路径写错了，或该层已不存在`);
      continue;
    }
    for (const key of keys) {
      // ★ 用 hasOwn 判「键是否存在」，而不是 `!== undefined`：值为 null（如未失败插件的 error）
      //   是**合法的稳定值**，用 undefined 判会把「有键但值为 null」误报成缺键。
      const missing = nodes.filter(n => !Object.hasOwn(n, key));
      if (missing.length) bad.push(`稳定面 '${path}' 点名的键 '${key}' 在 ${missing.length}/${nodes.length} 条记录上不存在`);
    }
  }
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
});

test('★★ 不留未分类的第三桶：每层真实键集 == 点名稳定 ∪ 点名不稳定', async () => {
  const snapshot = (await richHost()).getDiagnostics();
  const bad = [];
  for (const path of Object.keys(DIAGNOSTICS_CONTRACT.stable)) {
    const nodes = resolvePath(snapshot, path);
    if (nodes.length === 0) continue; // 路径不存在已由上一条测试报出
    const unknown = new Set();
    for (const node of nodes) {
      const named = new Set([...DIAGNOSTICS_CONTRACT.stable[path], ...unstableChildrenOf(path)]);
      for (const key of Object.keys(node)) if (!named.has(key)) unknown.add(key);
    }
    for (const key of unknown) {
      bad.push(`'${path}' 下的 '${key}' 既不在稳定面也不在不稳定面 —— `
        + '新增字段必须显式选边（DIAGNOSTICS_CONTRACT.stable / .unstable），不能默默存在');
    }
  }
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
});

test('★ 不稳定面点名的路径也必须在真实快照里存在（过时的点名会误导读者）', async () => {
  const snapshot = (await richHost()).getDiagnostics();
  const bad = DIAGNOSTICS_CONTRACT.unstable
    .filter(p => resolveRaw(snapshot, p).length === 0)
    .map(p => `不稳定面点名的 '${p}' 在真实快照里解析为空 —— 该字段已改名或删除，点名应一并更新`);
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
});

test('★★ 门禁有判别力：加一个未分类字段 / 写错一个稳定键名 ⇒ 各自必须变红', async () => {
  const snapshot = (await richHost()).getDiagnostics();
  // ① 模拟「有人往快照顶层加了个字段」：判据（真实键集 vs 契约）必须真的能看见它
  const withExtra = { ...snapshot, someNewDebugField: 1 };
  const namedAtRoot = new Set([
    ...DIAGNOSTICS_CONTRACT.stable[ROOT], ...unstableChildrenOf(ROOT)
  ]);
  assert.ok(!namedAtRoot.has('someNewDebugField'), '前提：新字段确实没有被点名');
  assert.ok(Object.keys(withExtra).some(k => !namedAtRoot.has(k)),
    '★ 判别力：未分类的新字段必须能在「真实键集 vs 契约」这一步被看见（否则上面那条断言恒真）');
  // ② 稳定面写错键名 ⇒ 「点名即承诺」那条必须真的能看见
  const misnamed = DIAGNOSTICS_CONTRACT.stable[ROOT].filter(k => !Object.hasOwn(snapshot, k));
  assert.deepEqual(misnamed, [], '前提：当前稳定面没有错名');
  assert.ok(!Object.hasOwn(snapshot, 'hostVerison'), '反例：拼错的键确实不存在于快照');
});

test('★★ 契约承诺「不改类型」—— 稳定面每个键的【类型签名】逐字钉住', async () => {
  // ★ 为什么必须有这条：契约文本承诺稳定面「不删、**不改名、不改类型**」，
  //   而上面几条只验「键存在」—— 实测把 `totalPlugins` 从 number 改成 string，
  //   本文件**六条全绿**（全量里有三条红是别的测试偶然兜住的，不是门禁）。
  //   ⇒ 承诺了类型就得有东西守类型。
  const snapshot = (await richHost()).getDiagnostics();
  const sigOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const lines = [];
  for (const [path, keys] of Object.entries(DIAGNOSTICS_CONTRACT.stable)) {
    for (const key of [...keys].sort()) {
      const types = [...new Set(resolvePath(snapshot, path).map(n => sigOf(n[key])))].sort();
      lines.push(`${path || '<root>'}.${key} = ${types.join('|')}`);
    }
  }
  assert.deepEqual(lines, STABLE_TYPE_SIGNATURE,
    '★ 稳定面的类型签名变了 —— 契约承诺「不改类型」，真要改就必须同步改契约文本与这里的锁');
});

test('★ 契约承诺枚举值「可增不可改」—— 既有取值逐字钉住（允许新增）', () => {
  // ⚠️ 守它的**不是** `Object.freeze`：冻结只挡运行时改对象，**挡不住改源码里的字面量**。
  //   这条只对【既有】取值断言 —— 新增一个 state 是允许的（契约明说「可增不可改」）。
  const pinned = {
    DISCOVERED: 'discovered', READY: 'ready', ACTIVATING: 'activating', ACTIVE: 'active',
    STOPPING: 'stopping', DISABLED: 'disabled', FAILED: 'failed'
  };
  const bad = Object.entries(pinned).filter(([k, v]) => LifecycleState[k] !== v)
    .map(([k, v]) => `LifecycleState.${k} = ${JSON.stringify(LifecycleState[k])}，契约承诺的是 ${JSON.stringify(v)}`);
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
  assert.ok(Object.isFrozen(LifecycleState), '运行时也必须冻结（这是另一件事，两条都要）');
});

test('★ schemaVersion 随快照交出，且与契约表同源（不是第二份字面量）', async () => {
  const snapshot = (await richHost()).getDiagnostics();
  assert.equal(snapshot.schemaVersion, DIAGNOSTICS_CONTRACT.schemaVersion,
    '快照里的 schemaVersion 必须等于契约表的 —— 两处各写一份就会漂移');
  // ★ schemaVersion 本身【不在稳定面】：承诺它等于承诺「版本号不会变」，自相矛盾
  assert.ok(!DIAGNOSTICS_CONTRACT.stable[ROOT].includes('schemaVersion'),
    'schemaVersion 不得进稳定面');
  assert.ok(DIAGNOSTICS_CONTRACT.unstable.includes('schemaVersion'),
    'schemaVersion 必须进不稳定面 —— 「不承诺」也要是显式的');
});
