/**
 * @file packages/kernel/test/memory-bounds.test.mjs
 * @description 内存门禁：内核经过若干次「创建 → 停用 / 释放」循环后，**不得保留本应释放的对象**。
 *
 * ── 判据形状：对象存活性（计数），不是字节阈值 ─────────────────────────────
 * 这与 `long-running.test.mjs` 的既有口径一致（该文件头逐字）：
 *   「判据用【宿主可观察的结构】… 而不是堆大小 —— 堆受 GC 时机影响，测试会抖。」
 * 本文件把这句推到底：用 `v8.queryObjects(Ctor)` 直接数**活着的实例个数**。
 *   · 计数与 Node 版本 / OS / GC 策略无关 —— 天然免疫 CI 抖动；
 *     而「堆字节阈值」会随这些漂移（本仓 `docs/开工中/README.md` 的「★★ CI 抖动实测」
 *     已记过一次 `windows-latest` 慢两个数量级导致的假红，修法是「别让环境慢吞掉判定」）。
 *   · 计数判据不需要失败重试（重试会吞掉真回归）。
 *
 * ── ★★ 机制要点（均已在本机 Node v24.16.0 独立复现，不是转述）─────────────
 *   ① `v8.queryObjects(Ctor)` 默认 `format: 'count'` ⇒ 返回 **number**（不是数组）。
 *      ⚠️ 别指望用 `{ format: 'summary' }` 拿到实例：官方文档逐字是
 *      「an array with **summary strings** of the matched objects」—— 返回的是**字符串**数组
 *      （形如 `"M { x: 1 }"`，实测 `arr[0] instanceof M === false`）。
 *      在数字上取 `.length` 会得到 undefined —— 探针早期就栽在这一步。
 *   ② ★★ `queryObjects` **自带一次 full GC**：它数的是「**此刻活着的**」，
 *      不是「已经活过 GC 的」—— 这两个说法差别很大，别写反。
 *      本机 Node v24.16.0 实测：丢弃 500 个实例后**不显式 gc()**、同步连调 3 次，计数**当场归零**；
 *      老年代对象（先经多轮分配促其晋升）丢弃后同样归零 ⇒ 是 full GC，不是 scavenge。
 *      官方文档逐字：「…search for objects … in the heap **after a full garbage collection**」。
 *      ★ 反向的读数（「丢弃后计数不降」）几乎总是**引用并没有真正丢弃** —— 对象仍被同一帧的
 *        局部变量引用着，那次 full GC 收不走它。判据要的是「不可达」，不是「赋了个 null」。
 *   ③ 判据**不建在 ② 上**。版本历史（官方文档）：v22.0.0 引入，v24.13.1 / v25.4.0 起标为
 *      no longer experimental —— 而本机 v24.16.0 实测**仍打** `ExperimentalWarning`，
 *      文档与实测对不上，恰好说明这条线还在动。
 *      本文件开头的判据形状写着「计数与 Node 版本 / OS / GC 策略无关」——
 *      若把「它会自己收垃圾」写成断言，就正好违反了这句话：那会让门禁在别的 Node 上假红，
 *      而它**红不出任何内核回归**（`settle()` 已经把该做的做完了）。
 *      ⇒ 探针自带 `settle()`（让出栈 + 显式 `gc()`），无论 ② 成不成立，判据都成立。
 *      ⚠️ 其中**让出栈是承重的**：`queryObjects` 收不走**仍被当前帧局部变量引用**的对象，
 *        在同一帧里创建并计数会把临时对象误报成泄漏（下方自检 ④ 把这一点钉住）。
 *   ④ 拿不到 `gc` 时**响亮失败**（见下方模块级 IIFE）—— 绝不静默降级成「跳过」。
 *      依据本仓规矩 44：「判据失效」与「检查通过」必须分开报；一个不能强制 GC 的探针
 *      要么把垃圾报成泄漏（假红），要么被静默跳过（假绿），两者都不可接受。
 *
 * ── 本门禁**故意不覆盖**什么（边界，不是遗漏）──────────────────────────────
 *   · **native / 外部内存看不见**：`queryObjects` 只数 JS 堆上原型匹配的对象；
 *     `Buffer` 底层 slab、WASM 线性内存、native addon 的分配不在视野内。
 *   · **只按构造函数 / 原型匹配**：`structuredClone` 的产物**丢失原型** ⇒ 数不到。
 *     故 `ctx.log` 的 details 走克隆路径时，本探针只能发现「内核改成存原引用」这类回归，
 *     发现不了「克隆体本身常驻」——后者由 `long-running.test.mjs` 的预算/截断断言守护。
 *   · **「本就该增长」的操作不纳入零增长断言**：审计日志环形缓冲（`maxLogSize` 条）
 *     与 `manifestDiagnostics` 是**按设计常驻的有界证据**。本探针只断言
 *     「随轮数线性增长的那类残留为零」，因此这些容器里只放克隆体 / 字段名，不放原对象。
 *   · **不测字节**：这是计数门禁，不替代 heap snapshot / 泄漏定位工具。
 *
 * ── 判别力自检（否则是恒真假绿）────────────────────────────────────────────
 *   ★★ 本文件自带「探针自检」：把**同一套探针**指向一个本地构造的**忠实泄漏体**
 *      （每轮把该轮全部 Marker 存进一个常驻 `Set` —— 真实的引用泄漏，不是「自己崩掉」的
 *      退化变异体），断言探针**报出增长**；撤掉泄漏源后断言**回到基线**。
 *      指向正确实现时，探针**不报**（见下方各主用例）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { CordiumHost } from '../src/index.mjs';

// ═════════════════════ 探针基础设施 ═════════════════════

if (typeof v8.queryObjects !== 'function') {
  // 规矩 44：拿不到判据就响亮失败，不许静默跳过。
  throw new Error(
    'memory-bounds gate: node:v8.queryObjects is unavailable (requires Node >= 22). '
    + 'Refusing to run: a silently skipped memory gate is worse than no gate.'
  );
}

/**
 * 免 `--expose-gc` 拿到 `gc`。
 * ★ 实测可用：`v8.setFlagsFromString('--expose-gc')` 之后 `vm.runInNewContext('gc')` 是函数。
 * ★ 拿不到就抛 —— 模块加载即失败，`node --test` 会把整个文件报成红（不是 skip）。
 */
const gc = (() => {
  try {
    v8.setFlagsFromString('--expose-gc');
    const candidate = vm.runInNewContext('gc');
    if (typeof candidate !== 'function') {
      throw new Error(`vm.runInNewContext('gc') returned ${typeof candidate}`);
    }
    return candidate;
  } catch (err) {
    throw new Error(
      'memory-bounds gate: cannot obtain gc() (' + (err && err.message) + '). '
      + 'Refusing to run: without a forced GC the probe would report unreclaimed garbage as a leak, '
      + 'and a silent skip would turn this gate into an always-green no-op.'
    );
  }
})();

/**
 * 让出栈 + 强制 GC，反复若干轮。
 * ★ 为什么必须让出栈：`queryObjects` 自带 full GC，但**收不走仍被当前帧局部变量引用的对象**
 *   —— 同一帧内创建并计数会把临时对象误报成泄漏。`setImmediate` 让出当前帧后再 `gc()`，
 *   才能拿到「真活着的」。
 * ★ `gc()` 这一半在今天的 Node 上对 `queryObjects` 是冗余的（它自己会 GC），
 *   保留是为了不把判据押在「引擎永远这样」上，并覆盖 `settle()` 可能被复用到别处的情形。
 */
const settle = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
};

/** 标记类：内核各条路径交进去的「本应释放」的对象都长这样。 */
class Marker {
  constructor(tag) {
    this.tag = tag;
    // 给一点载荷，避免被引擎当作可优化掉的空对象；但远小于日志预算，走的是克隆路径。
    this.payload = new Array(16).fill(0);
  }
}

/** 当前活着的 Marker 实例数（先 settle 保证 GC 已发生）。 */
const liveMarkers = async () => {
  await settle();
  return v8.queryObjects(Marker);
};

const CONTRACTS = { 'svc.marker': { access: 'public' }, 'svc.scoped': { access: 'public' } };

// ═════════════════════ ① 机制自检 ═════════════════════

test('★ 机制自检：queryObjects 返回计数（number），且自带一次 full GC —— 判据是「活过 GC 的对象」', { timeout: 60_000 }, async () => {
  const baseline = await liveMarkers();

  // ① 默认 format 是 count ⇒ 数字，不是数组。
  //    （第一版探针曾在数字上取 .length 拿到 undefined。）
  const n = v8.queryObjects(Marker);
  assert.equal(typeof n, 'number', 'queryObjects 默认返回计数（number）；在它上面取 .length 会得到 undefined');

  // ② 仍被引用的对象必须被数到 —— GC 收不走活对象。
  const held = [];
  for (let i = 0; i < 500; i++) held.push(new Marker('held'));
  assert.ok(v8.queryObjects(Marker) >= 500, '仍被引用的对象必须被数到');

  // ③ 丢弃引用 + settle ⇒ 必须回到基线。
  //    ★ 这里**刻意用 settle()，而不是裸 queryObjects**：官方文档说它是在
  //      「after a full garbage collection」之后检索（实测亦然），但那是**它的实现细节**；
  //      而本文件开头的判据形状明写「计数与 Node 版本 / OS / GC 策略无关」——
  //      判据若建在它上面，就正好违反了自己那句话（见文件头 ③）。
  held.length = 0;
  assert.equal(await liveMarkers(), baseline, '丢弃引用并 settle 后必须回到基线');

  // ④ 让出栈的意义：queryObjects 的 GC **收不走仍被本帧局部变量引用的对象**。
  //    同一帧内创建并计数 ⇒ 会被数到；帧结束后再计数 ⇒ 归零。
  const inFrame = (() => {
    const tmp = [];
    for (let i = 0; i < 50; i++) tmp.push(new Marker('tmp'));
    return v8.queryObjects(Marker); // tmp 仍在本帧 ⇒ 必须被数到
  })();
  assert.ok(inFrame >= 50, `同帧内被局部变量引用的对象必须被数到（实测 ${inFrame}）`);
  assert.equal(await liveMarkers(), baseline, '让出栈后，帧内临时对象必须被回收');
});

// ═════════════════════ ② 热路径：反复交入对象后停用必须全部释放 ═════════════════════

/** 每次激活内的热路径重复次数。 */
const HOT = 25;

test('★ 热路径反复经内核各路径交入对象：停用 + 卸载后必须全部释放', { timeout: 120_000 }, async () => {
  const baseline = await liveMarkers();
  const host = new CordiumHost({ maxLogSize: 10 });
  host.declareServiceContracts(CONTRACTS);

  let live = null;
  host.registerPlugin(
    { id: 'plugin.hot', version: '1.0.0', apiVersion: '1.0.0', provides: ['svc.marker', 'svc.scoped'] },
    {
      activate(ctx) {
        live = { ctx };
        // ① 全局服务实现：闭包持有 Marker
        const svc = new Marker('svc');
        ctx.provideService('svc.marker', { get: () => svc });
        // ② 具名作用域服务：闭包持有 Marker
        const scoped = new Marker('scoped');
        ctx.scoped('agent').provideService('svc.scoped', { get: () => scoped });
        // ③ 热路径：反复派生私有作用域并注册实现
        //    （历史泄漏点：scopedProviders 的空桶 / 代次记录残留）
        for (let i = 0; i < HOT; i++) {
          const m = new Marker(`private:${i}`);
          ctx.privateScope().provideService('svc.marker', { get: () => m });
        }
        // ④ 热路径：反复注册监听器
        //    （历史泄漏点：scope.disposers / channel 监听器随调用次数无上限增长）
        for (let i = 0; i < HOT; i++) {
          const m = new Marker(`listener:${i}`);
          ctx.on('evt.marker', () => m);
        }
        // ⑤ 热路径：反复写日志 details
        //    （历史泄漏点：大 details 深克隆后常驻 500 槽缓冲；修复后超预算换成截断标记）
        for (let i = 0; i < HOT; i++) {
          ctx.log('info', 'hot', { m: new Marker(`log:${i}`) });
        }
        // ⑥ 动作处理器闭包持有 Marker
        const act = new Marker('action');
        ctx.registerAction('act.marker', { handler: () => act });
      }
    }
  );

  await host.activatePlugin('plugin.hot');
  // 使用各路径：返回值都是 Marker，用完即弃（不留在测试帧里）。
  void live.ctx.getService('svc.marker').get();
  await host.dispatchAction('plugin.hot', 'act.marker');
  live.ctx.emit('evt.marker', 1);

  await host.deactivatePlugin('plugin.hot');
  await host.unregisterPlugin('plugin.hot');
  live = null;

  assert.equal(
    await liveMarkers(), baseline,
    '停用 + 卸载后不得残留任何 Marker —— 每个 Marker 都只该被内核在生命周期内临时持有'
  );
});

// ═════════════════════ ③ 多轮完整生命周期 ═════════════════════

/** 每轮创建并交入内核的 Marker 个数（manifest 未知字段 / entry.config / 服务 ×2 / 私有服务 / 动作 / 监听器 / 日志）。 */
const MARKERS_PER_ROUND = 8;
/** 完整「注册 → 使用 → 停用 → 卸载」轮数。 */
const ROUNDS = 3;

/**
 * 跑 `rounds` 轮完整生命周期。
 * @param {CordiumHost} host
 * @param {number} rounds
 * @param {{ sink?: Set<any[]> }} [opts] `sink` 非空时，把每轮的全部 Marker 存入它 ——
 *   这是自检用的**忠实泄漏体**（真实引用泄漏），用来证明探针确实能判别增长。
 */
async function runLifecycleRounds(host, rounds, opts = {}) {
  for (let r = 0; r < rounds; r++) {
    const id = `plugin.round${r}`;
    const held = [];
    const mk = (tag) => {
      const m = new Marker(`${id}:${tag}`);
      held.push(m);
      return m;
    };
    let live = null;

    host.registerPlugin(
      {
        id, version: '1.0.0', apiVersion: '1.0.0',
        provides: ['svc.marker', 'svc.scoped'],
        // 未知 manifest 字段：白名单重建会把它丢掉（连同里面的 Marker）——
        // 放进来的 Marker 只该被「丢字段」诊断记下**字段名**，不得留下对象。
        bogusManifestField: mk('manifest')
      },
      {
        // entry.config 由内核记录保存到卸载为止。
        config: { token: mk('config') },
        activate(ctx) {
          live = { ctx };
          const s = mk('svc');
          ctx.provideService('svc.marker', { get: () => s });
          const sc = mk('scoped');
          ctx.scoped('agent').provideService('svc.scoped', { get: () => sc });
          const priv = ctx.privateScope();
          const pm = mk('private');
          priv.provideService('svc.marker', { get: () => pm });
          const a = mk('action');
          ctx.registerAction('act.marker', { handler: () => a });
          const l = mk('listener');
          ctx.on('evt.marker', () => l);
          ctx.log('info', 'round', { m: mk('log') });
        }
      }
    );

    await host.activatePlugin(id);
    void live.ctx.getService('svc.marker').get();
    await host.dispatchAction(id, 'act.marker');
    live.ctx.emit('evt.marker', r);
    await host.deactivatePlugin(id);
    await host.unregisterPlugin(id);

    if (opts.sink) opts.sink.add(held); // ★ 忠实泄漏体：常驻 Set 持有该轮全部 Marker
  }
}

test('★ 多轮「注册 → 使用 → 停用 → 卸载」后不得保留任何本应释放的对象', { timeout: 120_000 }, async () => {
  const baseline = await liveMarkers();
  const host = new CordiumHost({ maxLogSize: 10 });
  host.declareServiceContracts(CONTRACTS);

  await runLifecycleRounds(host, ROUNDS);

  assert.equal(
    await liveMarkers(), baseline,
    `跑 ${ROUNDS} 轮完整生命周期后，活着的 Marker 数必须回到基线（不得随轮数增长）`
  );
});

// ═════════════════════ ④ 判别力自检（忠实泄漏体） ═════════════════════

test('★★ 判别力自检：同一套探针指向忠实泄漏体必须报增长，撤掉泄漏源必须回到基线', { timeout: 120_000 }, async () => {
  const baseline = await liveMarkers();

  // (a) 忠实泄漏体：每轮把该轮全部 Marker 存进常驻 Set（真实引用泄漏；
  //     不是「自己崩掉」那种退化变异体 —— 内核代码路径完全不变，只是多了一个持有者）。
  const sink = new Set();
  const leakyHost = new CordiumHost({ maxLogSize: 10 });
  leakyHost.declareServiceContracts(CONTRACTS);
  await runLifecycleRounds(leakyHost, ROUNDS, { sink });

  const leaked = await liveMarkers();
  assert.ok(leaked > baseline, `探针必须报出泄漏（baseline=${baseline}, leaked=${leaked}）`);
  assert.equal(
    leaked - baseline, ROUNDS * MARKERS_PER_ROUND,
    `忠实泄漏体的增量应恰好是「轮数 × 每轮 Marker 数」（实测增量 ${leaked - baseline}）`
  );

  // (b) 撤掉泄漏源 ⇒ 探针必须回到基线。
  //     这一步证明 (a) 的增长确实来自那个 Set，而不是探针自己在攒东西（否则是恒真假绿）。
  sink.clear();
  assert.equal(await liveMarkers(), baseline, '清空泄漏源后必须回到基线');
});
