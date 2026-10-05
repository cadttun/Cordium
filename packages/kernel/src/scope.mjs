/**
 * @file packages/kernel/src/scope.mjs
 * @description 资源所有权与清理作用域 (Effect Scope)
 */

import { CordiumError, ErrorCode } from './errors.mjs';
import { runWithTimeout } from './host-util.mjs';

export class EffectScope {
  /**
   * 宿主注入的两个释放回调 —— 【硬私有】。
   *
   * ★ 此前这里存的是【宿主实例本身】，dispose 回调 host.releaseRegistration /
   *   host.unregisterUIContribution —— 那是这两个方法必须公开的唯一原因。
   *   改为只持有两个回调后：宿主方法可以私有；本类也不再依赖宿主的形状。
   *
   * 为什么仍必须私有：本 Scope 会作为 ctx.scope 交给插件。回调若是公开字段，
   * 插件就能拿它们提前注销自己（或借 scope 身份反查的任何实现）。
   *
   * 对外只保留四个清理登记接口（+ untrackTimer）与宿主专用的 dispose：
   * addDisposer / trackTimer / trackService / trackUIContribution。
   * @type {{ releaseService?: (serviceName: string, scope: EffectScope) => void,
   *          releaseUIContribution?: (contributionId: string, ownerId: string) => void }}
   */
  #release;

  /**
   * 拥有者标识 —— 【硬私有】。
   *
   * 为什么必须私有：本 Scope 会作为 ctx.scope 交给插件。
   * 旧实现把它做成了公开可写字段，而 dispose() 又读它来调宿主注销服务 ——
   * 于是插件只要在 activate 里写一句 `ctx.scope.ownerId = 'plugin.b'`，
   * 停用时就会【注销掉 plugin.b 的实现】，同时把自己的实现留成幽灵。
   * 这是「可写的身份字段」这一整类缺陷 —— ★ 与 **Kubernetes CVE-2025-5187** 同族借鉴
   *   （NVD 在册、CVSS 6.7、CWE-863 Incorrect Authorization，
   *    描述是「node 用户给自己打 OwnerReference 删掉自己」）。
   *   ⚠️ **但只是同族，不是同一机制**：K8s 的官方修法是
   *   「**防止 node 用户修改自己的 OwnerReference**」（加一道检查拦截），
   *   而这里是「**注销根本不看那个字段**」（拿掉这个能力）。
   *   ★ 项目口径一贯偏向后者：**不是靠拦截，而是靠这个操作没有那个能力。**
   *
   * ⚠️ 但真正的防线不在这里：服务的注销已经不读这个字段了
   *    （见 dispose() 调用宿主 releaseRegistration，按 scope 对象身份反查）。
   *    此处的私有化只是防御纵深。
   *
   * @type {string}
   */
  #ownerId;

  /**
   * 存活标志 —— 【硬私有】，且对外只给只读 getter。
   *
   * 为什么必须这样：本对象会作为 ctx.scope 交给插件，而 dispose() 的第一行就是
   * `if (!#active) return`。旧实现把它做成公开可写字段 ⇒ 插件只要在 activate 里写一句
   * `ctx.scope.active = false`，宿主日后调 deactivatePlugin 时 dispose 会立即 return：
   *   · 它注册的服务继续占着服务槽（幽灵），
   *   · 它订阅过的监听器继续收事件（已停用的插件仍在观察世界），
   *   · 而宿主的状态机照样显示 disabled —— 状态与资源彻底脱钩。
   *
   * ★ 改成「私有 + 只读 getter」后，那句赋值在严格模式（ESM 默认）下**直接抛 TypeError**。
   *   ⇒ 这不是"防君子"，而是把静默的失效变成响亮的报错（本项目一贯口径）。
   */
  #active = true;

  /** 四类被托管的资源 —— 同样硬私有（见各 getter 的说明）。 */
  #disposers = new Set();
  /**
   * 宿主自己挂的释放回调（摘监听器 / 动作、归还作用域引用）—— 与插件的 disposer 分开存。
   * ★ 此前两者混在一个集合里按序 await，插件的某个清理回调永不结束 ⇒
   *   排在它后面的宿主释放全都轮不到：插件停在 stopping，**服务仍可取、动作仍可派发**（实测）。
   *   现在宿主释放同步、先跑、不可被插件拖住。
   */
  #hostDisposers = new Set();
  #timers = new Set();
  #services = new Set();
  #uiContributions = new Set();

  /**
   * dispose 的 in-flight promise。
   * ★ 用于让【并发第二次】dispose 也能等到第一次真正跑完 ——
   *   否则「await 了 dispose 就等于资源真的没了」这个直觉在并发下不成立。
   */
  #disposePromise = null;

  /**
   * 释放令牌 —— 【硬私有】。构造时由宿主给出，只有持有者能 dispose。
   *
   * ★ dispose() 曾是插件可调的公开方法。宿主只在 activate() 期间
   *   检查过「插件自己释放 scope」，activate 结束后插件再调一次 ⇒ 监听器 / 服务全被摘掉，
   *   宿主诊断却仍显示 active（状态与资源脱钩）。
   *   ⇒ 口径同本项目一贯做法：不是事后检测，而是让插件【没有这个能力】。
   * 不传令牌（null）⇒ 不设防，供独立使用 EffectScope 的场景。
   */
  #releaseKey;

  /**
   * @param {string} ownerId 拥有者标识 (如插件 ID)
   * @param {{ releaseService?: Function, releaseUIContribution?: Function } | null} [release]
   *   释放回调；缺省 ⇒ 独立使用时只清理定时器与 disposer
   * @param {symbol | null} [releaseKey] 释放令牌；给定后 dispose 必须出示同一个令牌
   */
  constructor(ownerId, release = null, releaseKey = null) {
    this.#ownerId = ownerId;
    this.#release = { ...release };
    this.#releaseKey = releaseKey;
  }

  /** 存活状态（只读） */
  get active() {
    return this.#active;
  }

  /**
   * 以下四个 getter 只交付【快照副本】，不是内部集合本身。
   *
   * ★ 为什么给副本：插件拿到的若是活引用，`ctx.scope.disposers.clear()` 就能
   *   在停用前把清理链掏空（监听器永不摘除）；给副本则 clear() 只是改了个临时对象。
   * ★ 只读 getter 而非直接暴露字段，是为了让「读得到」与「改得动」分开：
   *   需要登记请走 addDisposer / trackTimer / trackService / trackUIContribution，
   *   它们带存活校验。
   */
  // ★ disposers 只交【数量等价的不透明占位】，不交函数本身 ——
  //   里面有宿主挂的清理闭包（如作用域释放），交给插件等于让它能提前 / 反复触发宿主的清理。
  get disposers() { return new Set(Array.from(this.#disposers, () => Object.freeze({}))); }
  get timers() { return new Set(this.#timers); }
  get services() { return new Set(this.#services); }
  get uiContributions() { return new Set(this.#uiContributions); }

  /**
   * 存活断言 —— 一切「向宿主登记」的入口都必须先过这一关。
   *
   * ★ 覆盖范围要与 addDisposer 对齐：旧实现只有 addDisposer 检查了，
   *   于是 trackTimer / trackService / trackUIContribution 成了三个后门 ——
   *   「已停用的插件还能继续往宿主表里塞东西」正是要堵的那一类缺陷。
   */
  #assertActive(what) {
    if (!this.#active) {
      throw new CordiumError(ErrorCode.SCOPE_DISPOSED, `Scope for ${this.#ownerId} is already disposed (${what} rejected)`);
    }
  }

  /**
   * 注册清理回调
   * @param {() => void | Promise<void>} fn
   */
  addDisposer(fn) {
    this.#assertActive('addDisposer');
    this.#disposers.add(fn);
    return () => this.#disposers.delete(fn);
  }

  /**
   * 宿主专用：登记一个【同步】释放回调，dispose 时先于插件的 disposer 执行，不受其挂起影响。
   * 须出示释放令牌（插件拿不到），否则 scope_owned_by_host。
   * @param {() => void} fn
   * @param {symbol | null} releaseKey
   */
  addHostDisposer(fn, releaseKey) {
    if (releaseKey !== this.#releaseKey) {
      throw new CordiumError(ErrorCode.SCOPE_OWNED_BY_HOST, `Scope for ${this.#ownerId}: host disposers require the host's release key`);
    }
    this.#assertActive('addHostDisposer');
    this.#hostDisposers.add(fn);
    return () => this.#hostDisposers.delete(fn);
  }

  /**
   * 托管定时器 (卸载时自动清理，杜绝内存泄漏)
   * @param {any} timerId
   */
  trackTimer(timerId) {
    this.#assertActive('trackTimer');
    this.#timers.add(timerId);
    return timerId;
  }

  /**
   * 取消托管一个定时器（一次性定时器触发后、或插件自行 clear 后调用）。
   *
   * ★ scope 无从得知一个裸 timer id 何时触发 ——
   *   只 track 不 untrack 的一次性定时器会一直留在集合里直到插件停用（实测 500 个残留）。
   *   常驻插件大量使用 setTimeout 时应在回调里调用本方法。
   * @param {any} timerId
   * @returns {boolean} 是否曾被托管
   */
  untrackTimer(timerId) {
    return this.#timers.delete(timerId);
  }

  /**
   * 托管服务注册
   * @param {string} serviceName
   */
  trackService(serviceName) {
    this.#assertActive('trackService');
    this.#services.add(serviceName);
  }

  /**
   * 托管 UI 贡献 (面板、按钮等)
   * @param {string} contributionId
   */
  trackUIContribution(contributionId) {
    this.#assertActive('trackUIContribution');
    this.#uiContributions.add(contributionId);
  }

  /**
   * 释放本 Scope 下的所有资源。
   *
   * ★ 幂等 + 可并发：第二次及以后的调用【等同一个 promise】，而不是立刻返回。
   *   旧实现是「第二次直接 return」，于是在并发 teardown 下，
   *   `await scope.dispose()` 可能在你以为"已经清干净"时其实第一次还没跑完。
   */
  dispose(releaseKey, { timeoutMs = 0 } = {}) {
    if (this.#releaseKey !== null && releaseKey !== this.#releaseKey) {
      throw new CordiumError(ErrorCode.SCOPE_OWNED_BY_HOST,
        `Scope for ${this.#ownerId} is owned by the host — a plugin must not release the scope the host owns`
      );
    }
    this.#disposePromise ||= this.#doDispose(timeoutMs);
    return this.#disposePromise;
  }

  /**
   * @param {number} timeoutMs 插件 disposer 的【总】预算（0 / 负数 = 不限）
   */
  async #doDispose(timeoutMs) {
    if (!this.#active) return;
    // ★ 第一件事就是关门：此后一切登记（含 disposer 执行期间的）都会被 #assertActive 拒绝。
    this.#active = false;

    // 1. 清理托管的定时器
    for (const timer of this.#timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.#timers.clear();

    // 2. 宿主自有释放（同步、逆序）：摘监听器 / 动作、归还作用域引用。先于插件代码，插件拖不住它。
    for (const fn of Array.from(this.#hostDisposers).reverse()) {
      try { fn(); } catch (err) { this.#reportDisposeError(err); }
    }
    this.#hostDisposers.clear();

    // 3. 注销服务与 UI 贡献
    // ★ 服务注销【不报名字，报"我是谁"】—— 宿主拿 scope 对象身份去反查自己持有的
    //   所有者记录，而不是相信一个可以被改写的字符串。
    //   这样即使有人绕过私有字段，也无法借刀注销别人的实现；
    //   同时因为反查是"按 scope 摘除"，自己的实现也必然被摘干净，不会留幽灵。
    // ★★ 逐个隔离（与上方宿主自有释放同一口径）：一条释放回调抛错，不得【短路】其余释放。
    //   JS 显式资源管理（`Symbol.dispose` / `DisposableStack`）的语义本就是如此 ——
    //   处置期的异常被收集进 `SuppressedError` 汇总抛出，而不是让剩下的资源干脆不处置。
    //   ★ 这两段此前是裸调，因而成了 #doDispose 唯一能 reject 的路径；而宿主侧
    //     `await scope.dispose(...)` 之后才置 DISABLED ⇒ 一条释放回调抛错，
    //     插件状态就永久停在 STOPPING（既不再 ACTIVE，也到不了 DISABLED）。
    //     下面的隔离使 dispose 成为【一定会走完】的操作：这个状态再没有别的卡法。
    const { releaseService, releaseUIContribution } = this.#release;
    for (const s of this.#services) {
      try { releaseService?.(s, this); } catch (err) { this.#reportDisposeError(err); }
    }
    this.#services.clear();

    // UI 贡献沿用字符串 ownerId，但这里读的是私有字段，插件无法改写。
    for (const c of this.#uiContributions) {
      try { releaseUIContribution?.(c, this.#ownerId); } catch (err) { this.#reportDisposeError(err); }
    }
    this.#uiContributions.clear();

    // 4. 插件的清理回调（逆序）。共享一个总预算：某个回调挂起 ⇒ 等到预算用完即记错误、继续下一个；
    //    预算用完后剩下的回调照样【调用】（不再等待），保证每个都被执行过、dispose 有界结束。
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
    for (const fn of Array.from(this.#disposers).reverse()) {
      const remaining = deadline - Date.now();
      try {
        if (remaining > 0) {
          await runWithTimeout(fn, remaining === Infinity ? 0 : remaining, () => new CordiumError(ErrorCode.LIFECYCLE_TIMEOUT,
            `Dispose hook of plugin '${this.#ownerId}' did not finish within the ${timeoutMs}ms lifecycle budget (it may still be running)`));
        } else {
          Promise.resolve().then(fn).then(undefined, err => this.#reportDisposeError(err));
        }
      } catch (err) {
        this.#reportDisposeError(err);
      }
    }
    this.#disposers.clear();
  }

  #reportDisposeError(err) {
    // ★ 此前只打 console.error ⇒ 宿主审计 / 错误日志里看不到「清理失败」。
    //   宿主经释放回调注入 onDisposeError；没有宿主（单独 new EffectScope）时退回 console。
    try {
      if (this.#release.onDisposeError) this.#release.onDisposeError(this.#ownerId, err);
      else console.error(`[Scope:${this.#ownerId}] Error during dispose hook:`, err);
    } catch { /* 上报本身失败不得中断清理 */ }
  }
}
