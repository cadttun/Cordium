/**
 * @file packages/kernel/src/channel.mjs
 * @description 信息中转层 —— 内核里【只负责搬运消息】的那一层。
 *
 * ── 为什么要单独一层 ────────────────────────────────────────────────
 * 服务（service）与消息（message）是**两种根本不同的语义**：
 *
 *   |          | 服务            | 通道                |
 *   |----------|-----------------|---------------------|
 *   | 拓扑     | 点对点          | 一对多              |
 *   | 调用方   | 知道对方是谁    | ★ 不知道谁在听      |
 *   | 回执     | 必须有返回值    | 可有可无            |
 *   | 可拦截   | 不该被第三方插脚 | ★ 就是设计来被拦截的 |
 *
 * 混在一起的代价：每加一个「拦截」需求，都要去改服务解析逻辑。
 * ⇒ 因此把「信息怎么流动」独立出来，宿主只做编排，本层只做搬运。
 *
 * ── 三条设计铁律 ────────────────────────────────────────────────────
 *   ① **本层不知道消息内容是什么** —— 零业务。它只认「名字 + 参数」。
 *   ② **零 token** —— 全是函数调用，绝不碰模型。
 *   ③ **注册即效果** —— 调用方拿到的 disposer 由 EffectScope 托管，
 *      插件卸载时监听器自动摘除（见 host.mjs 的 ctx.on 接线）。
 *
 * ── 分发模式（对齐 Cordis `events.ts`）────────────────────────────────
 *   emit       广播，不等回执
 *   parallel   广播 + 等全部完成（失败 ⇒ CordiumError(listener_failed)，原始错误在 cause.errors）
 *   serial     串行，【第一个有回应的赢】
 *   waterfall  ★ 中间件：可停留 / 传输 / 变换
 *
 * ── 失败口径 ────────────────────────────────
 *   监听器抛出的任意值 ⇒ CordiumError(listener_failed)，原值在 cause（parallel 是多个，cause 为 AggregateError）。
 *   此前只有 parallel 这么做，serial / waterfall 原样透传 —— 同一文件两套口径，
 *   抛字符串时调用方拿不到码与栈（实测）。
 *   不包的：本层自己的用法错误（next() 调两次）；waterfall 兜底函数（调用方自己的）抛的错。
 */

import { CordiumError, ErrorCode } from './errors.mjs';
import { summarizeCause } from './host-util.mjs';
import { ScopeTree } from './scope-tree.mjs';

/** 监听器失败的信封（serial / waterfall 共用） */
function listenerFailed(mode, name, err, owner) {
  return new CordiumError(ErrorCode.LISTENER_FAILED,
    `MessageChannel.${mode}('${String(name)}'): a listener${owner ? ` of plugin '${owner}'` : ''} failed: ${summarizeCause(err)}`,
    { cause: err, pluginId: owner });
}

/** 分发模式（导出供诊断与测试使用） */
export const DispatchMode = Object.freeze({
  EMIT: 'emit',
  PARALLEL: 'parallel',
  SERIAL: 'serial',
  WATERFALL: 'waterfall'
});

/**
 * 判定「是否拦截」。
 *
 * 语义取 Cordis `events.ts:6-8`：只有非空且非 false 的返回值才算拦截。
 * ⇒ `undefined` / `null` / `false` 都表示「我不处理，往下传」。
 */
export function isBailed(value) {
  return value !== null && value !== false && value !== undefined;
}

export class MessageChannel {
  /**
   * 名字 → 监听器数组。
   *
   * ⚠️ 数组顺序即分发顺序 —— **必须是确定的**，不可依赖 Map 迭代顺序做优先级。
   * `prepend` 决定插队首还是队尾（对齐 Cordis `EventOptions.prepend`）。
   *
   * @type {Map<string, Array<{ listener: Function, prepend: boolean, scopeLabel: string | null, global: boolean, owner: string | null }>>}
   */
  #handlers = new Map();

  /**
   * 作用域层级表 —— 见 scope-tree.mjs（层级、引用计数、私有子键的全部设计说明在那里）。
   * @type {ScopeTree}
   */
  #scopes = new ScopeTree();

  /**
   * 单个事件的监听器数上限（**泄漏检测器，不是硬限制**）。
   *
   * 为什么需要：监听器泄漏是插件系统最隐蔽的故障 —— 插件卸载时没能摘除监听器，
   * 表现是「功能看着正常，但内存和重复回调慢慢涨」。
   * 依据 Node.js EventEmitter 的做法（默认 10，**是检测器不是限制**）——
   * 本层不复用 EventEmitter，所以自己带一个。
   *
   * ★ 触发时【不抛错、不拒绝注册】，只通过 `onListenerOverflow` 上报 ——
   *   因为"合法地挂很多监听器"是可能的，硬拦会误伤。
   *
   * @type {number}
   */
  maxListenersPerEvent = 200;

  /**
   * 监听器数超限钩子。宿主接到审计日志。
   * @type {(name: string, count: number) => void}
   */
  onListenerOverflow = () => {};

  /**
   * 订阅一个事件。
   *
   * ★ 注册是【同步】的：本方法返回时监听器已经挂上。
   *   这不是随便定的 —— 若注册是异步的，「先订阅再发布」的直觉就会失效，
   *   发布方与订阅方的首次握手会形成竞态。
   *   （依据：Qwen Code `EventBus` 官方文档明确把同步注册列为设计点。）
   *
   * @param {string} name 事件名，约定 `domain/action`（如 `task/created`）
   * @param {Function} listener
   * @param {{ prepend?: boolean, scopeLabel?: string | null, global?: boolean, owner?: string | null }} [options]
   *   owner：订阅者身份（宿主注入插件 id）—— 只用于出错时报「是谁的监听器」，不参与派发
   * @returns {() => boolean} disposer（由调用方交给 EffectScope 托管）
   */
  subscribe(name, listener, options = {}) {
    // ★ 也接受 symbol —— 宿主的服务变更通知用模块私有 symbol，插件拿不到就发不出、订不到。
    if (!((typeof name === 'string' && name) || typeof name === 'symbol')) {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'MessageChannel.subscribe requires a non-empty string (or symbol) event name');
    }
    if (typeof listener !== 'function') {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `MessageChannel.subscribe('${String(name)}') requires a function listener`);
    }

    const record = {
      listener,
      prepend: Boolean(options.prepend),
      scopeLabel: options.scopeLabel ?? null,
      global: Boolean(options.global),
      owner: typeof options.owner === 'string' ? options.owner : null
    };

    let list = this.#handlers.get(name);
    if (!list) {
      list = [];
      this.#handlers.set(name, list);
    }
    // ★ prepend ⇒ 插队首（高优先级）；否则队尾。
    if (record.prepend) list.unshift(record);
    else list.push(record);

    // 泄漏检测：超限只上报，不拒绝注册（见 maxListenersPerEvent 的说明）
    if (list.length > this.maxListenersPerEvent) {
      try {
        this.onListenerOverflow(name, list.length);
      } catch {
        // 上报本身失败不得影响注册
      }
    }

    let disposed = false;
    return () => {
      if (disposed) return false;
      disposed = true;
      const current = this.#handlers.get(name);
      if (!current) return false;
      const index = current.indexOf(record);
      if (index < 0) return false;
      current.splice(index, 1);
      if (current.length === 0) this.#handlers.delete(name);
      return true;
    };
  }

  /**
   * 取某事件的监听器【快照】。
   *
   * ★ 为什么必须快照：发布过程中可能有订阅者退订（甚至订阅新事件），
   *   边遍历边改原数组会导致漏发或重发。
   *   快照的代价是一次浅拷贝，换来的是分发语义的确定性。
   *
   * @param {string} name
   * @param {string | symbol | undefined} dispatchKey 派发作用域；undefined = 只放行无标签监听器（见 #admit）
   */
  #snapshot(name, dispatchKey = undefined) {
    const list = this.#handlers.get(name);
    if (!list || list.length === 0) return [];
    // ★ 祖先链每次派发只走一遍（此前每个监听器各走一遍：1000 监听器 × 3 层 ⇒ 派发慢 ~3 倍）
    const ancestors = dispatchKey === undefined ? null : new Set(this.#scopes.ancestors(dispatchKey));
    const out = [];
    for (const record of list) if (this.#admit(record, dispatchKey, ancestors)) out.push(record);
    return out;
  }

  /**
   * 作用域放行规则。
   *
   * 放行表：
   *   "an **untagged** listener is admitted; a **tagged** listener is admitted
   *    iff its tag is the dispatch key **or an ancestor of it**;
   *    `key === undefined` admits **untagged listeners only**."
   *
   * ★ 注意方向：**注册视图向下继承，事件放行向上延伸** ——
   *   打了「祖先」tag 的监听器能收到**后代** key 的事件，**反之不行**。
   *
   * @param {{ scopeLabel: string | null, global: boolean }} record
   * @param {string | symbol | undefined} dispatchKey 派发作用域键（私有作用域是 symbol）
   * @param {Set<string | symbol> | null} ancestors dispatchKey 自身及其祖先（由 #snapshot 每次派发算一次）
   */
  #admit(record, dispatchKey, ancestors) {
    if (record.global) return true;                       // 显式全局：一律放行
    if (dispatchKey === undefined) return record.scopeLabel === null;  // 无 key ⇒ 只放行无 tag
    if (record.scopeLabel === null) return true;          // 无 tag 监听器：全局可见
    // 监听器的 tag 是派发 key 自身或其祖先 ⇒ 放行
    return ancestors.has(record.scopeLabel);
  }

  // ── 作用域层级（已抽成内部类 ScopeTree，这里只委托；签名与语义不变）──
  /** 见 ScopeTree#declareScope：决定位置（已有不同父级 ⇒ 抛 scope_conflict） */
  declareScope(childKey, parentKey = null) { return this.#scopes.declareScope(childKey, parentKey); }
  /** 见 ScopeTree#ensureScope：取得句柄（已有 ⇒ 加入，绝不改写位置） */
  ensureScope(childKey, parentKey = null) { return this.#scopes.ensureScope(childKey, parentKey); }
  /** 见 ScopeTree#releaseScope：引用计数 -1，归零才回收 */
  releaseScope(key) { return this.#scopes.releaseScope(key); }
  /** @returns {string | symbol | null | undefined} `null` = 顶层；`undefined` = 该键未声明 */
  scopeParentOf(scopeKey) { return this.#scopes.scopeParentOf(scopeKey); }
  /** 从 key 自身沿祖先链向上的键序列（只读快照，含 key 本身；未声明的键只产出它自己） */
  scopeAncestors(scopeKey) { return [...this.#scopes.ancestors(scopeKey)]; }
  /** 当前已声明的键数（诊断用；含顶层键） */
  scopeCount() { return this.#scopes.scopeCount(); }
  /** 当前已声明的作用域键列表（诊断用，顺序确定；与 eventNames 对称） */
  scopeKeys() { return this.#scopes.scopeKeys(); }

  /**
   * 冲突上报钩子 —— `ensureScope` 发现「请求的父级 ≠ 实际的父级」时调用。
   *
   * ★ 只上报、不改写：调用方拿到的是**实际**那个作用域，只是没拿到它以为的层级。
   *   硬拦会误伤"只想引用一下"的合法用法，静默又会让人排查半天 ——
   *   所以走"照常返回 + 留痕"（与 `onListenerOverflow` 同一口径）。
   *
   * @type {(key: string | symbol, actualParent: string | symbol | null, requestedParent: string | symbol | null) => void}
   */
  onScopeConflict = () => {};

  // 已删除接口 `bindScopeParent` 的理由见 design/removed-apis.md §1（勿加回）

  /** 某事件当前有几个监听器（诊断用） */
  listenerCount(name) {
    return this.#handlers.get(name)?.length ?? 0;
  }

  /** 当前已注册的事件名列表（诊断用，顺序确定） */
  eventNames() {
    return Array.from(this.#handlers.keys());
  }

  /**
   * ★ 宿主用的统一派发入口 —— 带上【调用方的作用域 key】。
   *
   * 为什么单独开一个入口而不改公开方法的签名：
   *   公开方法 `emit(name, ...args)` 的可变参数已经占满签名，
   *   再加一个 options 对象会与"事件的普通参数"混淆（无法区分）。
   *   所以作用域走独立入口，由宿主 ctx 闭包提供 —— 与身份注入同一模式。
   *
   * @param {'emit'|'parallel'|'serial'|'waterfall'} mode
   * @param {string} name
   * @param {string | undefined} scopeKey 调用方作用域；undefined = 全局
   * @param {any[]} args
   */
  dispatch(mode, name, scopeKey, args) {
    switch (mode) {
      case DispatchMode.EMIT: return this.#emit(name, scopeKey, args);
      case DispatchMode.PARALLEL: return this.#parallel(name, scopeKey, args);
      case DispatchMode.SERIAL: return this.#serial(name, scopeKey, args);
      case DispatchMode.WATERFALL: return this.#waterfall(name, scopeKey, args);
      default: throw new CordiumError(ErrorCode.INVALID_USAGE, `MessageChannel.dispatch: unknown mode '${mode}'`);
    }
  }

  emit(name, ...args) {
    return this.#emit(name, undefined, args);
  }

  /**
   * 宿主级广播 —— ★【绕开作用域放行规则】，送给【所有】监听器。
   *
   * 为什么需要这个出口：`internal/*` 这类**宿主自身的通知**，语义是「告诉所有关心的人」，
   * 而不是「告诉住在某个作用域里的人」。若走普通派发会踩到官方放行表的一格 ——
   * `dispatchKey === undefined` 时**只放行无标签监听器**，于是
   * `ctx.scoped(...).on('internal/service', ...)` 的订阅者【永远收不到】服务变更，
   * 而代码注释却承诺了「消费者据此重新适配」。
   *
   * ⚠️ 只供宿主内部使用，**不挂到插件 ctx 上** ——
   *   插件拿到它就等于拿到一个「发给所有人」的喇叭，会推翻作用域隔离。
   *
   * @param {string} name
   * @param {...any} args
   */
  broadcast(name, ...args) {
    const list = this.#handlers.get(name);
    if (!list || list.length === 0) return;
    // ★ 同样走快照（Array.from）—— 派发期间有人退订不得影响本次遍历。
    for (const record of Array.from(list)) {
      this.#invokeDetached(name, record, args);
    }
  }

  /**
   * 广播，不等回执。
   *
   * ★ 单个监听器抛错【不阻断】其他监听器 —— 否则一个坏插件能静默吃掉所有人的通知。
   *   错误会被收集并通过 `onListenerError` 上报（宿主接审计日志）。
   */
  #emit(name, scopeKey, args) {
    for (const record of this.#snapshot(name, scopeKey)) {
      this.#invokeDetached(name, record, args);
    }
  }

  /**
   * 「发完就走」式调用一个监听器：同步抛错与【异步拒绝】都走 `onListenerError`。
   *
   * ★ 为什么异步拒绝必须接住：try/catch 只挡同步异常。async 监听器 reject 后
   *   无人 .catch ⇒ unhandledRejection ⇒ **Node 默认直接退出进程**（实测 exit=1）。
   *   即：任意一个插件写一个会抛错的 async 监听器，就能打挂整个宿主。
   */
  #invokeDetached(name, { listener, owner }, args) {
    try {
      const result = listener(...args);
      if (result && typeof result.then === 'function') {
        result.then(undefined, error => this.#reportError(name, error, owner));
      }
    } catch (error) {
      this.#reportError(name, error, owner);
    }
  }

  /**
   * 广播 + 等全部完成。有监听器失败 ⇒ 抛 CordiumError(listener_failed)，各原始错误在 err.cause.errors。
   *
   * 与 `emit` 的区别：`emit` 是「发完就走」，本方法会等所有监听器的 Promise 结算。
   * 注意 `Promise.allSettled` 语义 —— **一个失败不影响其他继续跑完**，最后统一报错。
   */
  async parallel(name, ...args) {
    return this.#parallel(name, undefined, args);
  }

  async #parallel(name, scopeKey, args) {
    const results = await Promise.allSettled(
      this.#snapshot(name, scopeKey).map(({ listener }) => Promise.resolve().then(() => listener(...args)))
    );
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
    if (errors.length > 0) {
      // ★ 抛 CordiumError(listener_failed)，原始错误原样挂在标准的 cause 上 ——
      //   调用方先按 code 分支（与其它失败同一口径），要细节再看 err.cause.errors，一条不丢。
      const message = `MessageChannel.parallel('${String(name)}') had ${errors.length} failing listener(s)`;
      throw new CordiumError(ErrorCode.LISTENER_FAILED, message, { cause: new AggregateError(errors, message) });
    }
  }

  /**
   * 串行 await，【第一个有回应的赢】。
   *
   * 「有回应」= `isBailed(返回值)` 为真。用于「谁能处理这件事」的链式询问。
   */
  async serial(name, ...args) {
    return this.#serial(name, undefined, args);
  }

  async #serial(name, scopeKey, args) {
    for (const { listener, owner } of this.#snapshot(name, scopeKey)) {
      let result;
      try {
        result = await listener(...args);
      } catch (err) {
        throw listenerFailed('serial', name, err, owner);
      }
      if (isBailed(result)) return result;
    }
    return undefined;
  }

  /**
   * ★ 中间件模式 —— 信息可【停留 / 传输 / 变换】。
   *
   * 调用约定（对齐 Cordis `events.ts:117-132`）：
   *   `waterfall(name, ...args, inner)`
   *   最后一个参数是**兜底实现**：前面的监听器都不调 `next()` 时由它收尾。
   *
   *   · 停留 —— 监听器不调 `next()`，直接返回自己的结果
   *   · 传输 —— 监听器调 `next()`
   *   · 变换 —— 监听器改 `args` 后再调 `next()`
   *
   * ⚠️ 两条铁律 —— ★ **依据来源不同，别混为一谈**：
   *
   *   ① **`next()` 调用两次必须抛错** —— 依据是 **`koa-compose` 的源码**（不是"指南"）：
   *      ```js
   *      const nextProxy = async () => {
   *        if (nextCalled) throw Error('next() called multiple times')
   *        nextCalled = true
   *        ...
   *      ```
   *      静默产生诡异行为比直接报错难查得多。
   *
   *   ② **异步监听器必须 `await next()`** —— 依据才是 **Koa 文档的经典陷阱**：
   *      忘记 `await` 会导致「下游还没执行完，流程就结束了」。
   *
   * ★★ 而 `koa-compose` 还有**第三条**守卫，本层**不做** —— 这一条特意记下来免得后人以为是漏了：
   *      ```js
   *      if (nextCalled && !nextResolved) {
   *        throw Error('Middleware resolved before downstream. You are probably missing an await or return')
   *      }
   *      ```
   *   它存在的**前提是全异步**（`await fn(...)` 之后才检查）。
   *   **本层是同步递归**：`next()` 会【同步跑完】整个下游才返回 ⇒
   *   对**同步监听器**而言，"调了 next 却没等它跑完"这件事**根本不可能发生**，
   *   那条检查在这里是恒真的空操作，故不需要。
   *   ⚠️ **但这条豁免只对同步监听器成立**：监听器若是 `async`，
   *   `next()` 会落到微任务里 ⇒ 顺序不再保证 —— 此时**必须自己 `await`**。
   */
  waterfall(name, ...args) {
    return this.#waterfall(name, undefined, args);
  }

  #waterfall(name, scopeKey, args) {
    // ★ 注意：不能就地改 args（它可能是调用方传来的同一个数组引用），先拷一份。
    const rest = [...args];
    const inner = rest.pop();
    if (typeof inner !== 'function') {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `MessageChannel.waterfall('${String(name)}') requires a fallback function as the last argument`);
    }
    const listeners = this.#snapshot(name, scopeKey);

    // 兜底函数是调用方自己的、next() 调两次是本层的用法错误：这两类原样送达，不套信封。
    // ★ 记在本次调用的集合里而不是装盒子：监听器若 try/catch 了 next()，看到的仍是原错误。
    const own = new Set();
    /** @type {Map<unknown, string | null>} 本次调用里各错误的源头监听器归属（原始值也能当键，故不用 WeakMap） */
    const blame = new Map();
    const callInner = currentArgs => {
      let result;
      try { result = inner(...currentArgs); } catch (err) { own.add(err); throw err; }
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(undefined, err => { own.add(err); throw err; });
      }
      return result;
    };

    const dispatch = currentArgs => {
      const record = listeners.shift();
      // ★ 兜底也要收到【当前】参数 —— 否则「没人拦截」时兜底拿不到任何输入，
      //   只能靠闭包捕获，对通用通道来说不可用。
      if (!record) return callInner(currentArgs);

      let called = false;
      /**
       * 继续往下传。
       * ★ 传参 ⇒ 【变换】：用新参数继续，下游与兜底都看到新值。
       *   不传 ⇒ 【透传】：沿用当前参数。
       *   （Koa/Cordis 的中间件靠"改共享对象"来变换；这里额外支持 `next(newArgs)`，
       *     是因为本层是通用消息通道，参数常常是原始值而非可变对象。）
       */
      const next = (...newArgs) => {
        if (called) {
          const usage = new CordiumError(ErrorCode.INVALID_USAGE, `MessageChannel.waterfall('${String(name)}'): next() called multiple times`);
          own.add(usage);
          throw usage;
        }
        called = true;
        return dispatch(newArgs.length > 0 ? newArgs : currentArgs);
      };
      // 记下「最先抛出这个错的是谁的监听器」：错误会穿过上游的 next() 冒上来，最内层那个才是源头
      const blameOwner = err => { if (!own.has(err) && !blame.has(err)) blame.set(err, record.owner); throw err; };
      let result;
      try { result = record.listener(...currentArgs, next); } catch (err) { blameOwner(err); }
      if (result && typeof result.then === 'function') return Promise.resolve(result).then(undefined, blameOwner);
      return result;
    };

    // 信封只在最外层套一次：下游监听器的错会穿过上游监听器的 next() 冒上来，逐层套会套出 N 层
    const settle = err => {
      if (own.has(err)) throw err;
      throw listenerFailed('waterfall', name, err, blame.get(err) ?? null);
    };
    let result;
    try {
      result = dispatch(rest);
    } catch (err) {
      settle(err);
    }
    if (result && typeof result.then === 'function') return Promise.resolve(result).then(undefined, settle);
    return result;
  }

  /**
   * 监听器异常上报钩子。宿主可覆盖为审计日志。owner = 订阅时登记的身份（宿主注入的插件 id；未登记为 null）。
   * @type {(name: string, error: any, owner: string | null) => void}
   */
  onListenerError = (name, error, owner) => {
    console.error(`[channel:${String(name)}] listener${owner ? ` of '${owner}'` : ''} threw:`, error);
  };

  #reportError(name, error, owner = null) {
    try {
      this.onListenerError(name, error, owner);
    } catch {
      // 上报本身失败不能级联放大
    }
  }
}
