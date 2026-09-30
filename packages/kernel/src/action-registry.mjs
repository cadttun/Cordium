/**
 * @file packages/kernel/src/action-registry.mjs
 * @description 受控动作表：注册 / 注销 / 鉴权派发。
 *
 * ★ 从 host.mjs 原样搬出（Extract Class：`#actionHandlers` 字段与读写它的方法一起搬）。
 *   **内部实现，不经 index / internal 导出**；宿主以私有字段持有实例，公开方法只做委托。
 * ★ 本类不认识插件表：宿主注入四个【窄查询】——
 *   这里只问「调用方能不能调」「持不持有这个权限」「权限名登没登记」，不拿插件记录本身。
 *   鉴权事实（权限快照、生命周期状态）仍只在宿主那边，本类读不到也改不了。
 */

import { CordiumError, ErrorCode } from './errors.mjs';
import { runWithTimeout, MAX_TIMER_MS, summarizeCause } from './host-util.mjs';

/**
 * @typedef {object} ActionRegistryQueries
 * @property {(callerPluginId: string) => boolean} isCallerLive 调用方是否处于可调用状态（ACTIVE / ACTIVATING）
 * @property {(callerPluginId: string, permission: string) => boolean} hasPermission 读【宿主持有的权限快照】
 * @property {(name: string, where: string) => void} assertPermissionDeclared 未登记即抛 undeclared_permission
 * @property {() => number} defaultTimeoutMs 单条未设 timeoutMs 时的回退值（0 / 负数 = 不限）
 * @property {() => number} maxInFlight 同时在途的派发数上限
 * @property {symbol} releaseKey 宿主释放令牌（登记宿主自有的释放回调用）
 * @property {(level: string, message: string, details?: any) => void} log 写宿主审计日志
 */

export class ActionRegistry {
  #entries = new Map();
  #q;
  /** 在途派发数（进入 dispatch 即 +1，结束 -1）。见 CordiumHost 构造里 maxInFlightActions 的说明 */
  #inFlight = 0;
  /** 在途数触顶后的告警限频：回落到一半以下才允许下一次告警 */
  #overloadWarned = false;

  /** @param {ActionRegistryQueries} queries */
  constructor(queries) {
    this.#q = queries;
  }

  /** 已登记的动作数（诊断用） */
  get size() { return this.#entries.size; }

  /**
   * 注册受控动作 (Action)
   */
  register(action, ownerId, options, scope) {
    // ★ 此前签名里直接解构 ⇒ 不传 options 抛引擎 TypeError（无码）
    if (options === null || typeof options !== 'object') {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT,
        `Action '${action}' registered by plugin '${ownerId}' requires an options object with a handler function`);
    }
    const { requiredPermission, handler, timeoutMs } = options;
    // 单条上限：不写 = 用宿主默认；写了就必须是 (0, MAX_TIMER_MS] —— 此前非法值静默回退默认值，
    // 而 > 2³¹-1 会被 Node 改成 1ms ⇒ 该动作每次立即超时（实测）
    if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS)) {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT,
        `Action '${action}' registered by plugin '${ownerId}': timeoutMs must be a number in (0, ${MAX_TIMER_MS}], got ${String(timeoutMs)}`);
    }
    // ★ 生命周期门禁（必须在【写表之前】）：旧实现先写 actionHandlers、后调 addDisposer，
    //   而 addDisposer 在已释放的 scope 上会抛 —— 抛出发生在写表【之后】且没有回滚，
    //   于是 actionHandlers 里留下一条没有任何 disposer 能删除的永久 handler。
    //   而 dispatchAction 只校验调用方状态、不校验 handler 属主状态 ⇒ 任何 ACTIVE 插件
    //   都能永久触发一个已停用插件留下的 handler。
    if (scope && !scope.active) {
      throw new CordiumError(ErrorCode.SCOPE_DISPOSED,
        `Action '${action}' cannot be registered by plugin '${ownerId}': `
        + `its scope is already disposed (a disposed plugin must not register anything)`
      );
    }

    if (requiredPermission) {
      this.#q.assertPermissionDeclared(requiredPermission, `Action '${action}' of plugin '${ownerId}'`);
    }
    if (typeof handler !== 'function') {
      // ★ 此前不校验：没有 handler 也能注册，到派发时才抛 TypeError（离出错点很远）。
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT, `Action '${action}' registered by plugin '${ownerId}' requires a handler function`);
    }
    // 同名动作严禁相互覆盖：否则先注册者的 disposer 会在停用时把后来者的 handler 一并删掉。
    // ★ 同一插件重复注册同样拒绝（此前静默覆盖）—— 与 UI 贡献查重同一口径：
    //   重复注册意味着逻辑错误，静默覆盖会把它伪装成「看起来正常」。
    const existing = this.#entries.get(action);
    if (existing) {
      throw new CordiumError(ErrorCode.DUPLICATE_ACTION,
        `Action '${action}' is already registered by plugin '${existing.ownerId}'`
      );
    }

    this.#entries.set(action, {
      action,
      ownerId,
      requiredPermission: requiredPermission || null,
      // 单条动作的执行上限（已在上方校验）；null ⇒ dispatch 时回退到 defaultTimeoutMs
      timeoutMs: timeoutMs ?? null,
      handler
    });

    if (scope) {
      // ★ 宿主自有释放：先于插件的清理回调执行，插件的回调挂起也拖不住它（否则停用卡住时动作仍可派发）
      scope.addHostDisposer(() => {
        // 仅当当前 handler 仍属于自己时才删除，避免误删他人注册的同名动作。
        const current = this.#entries.get(action);
        if (current && current.ownerId === ownerId) {
          this.#entries.delete(action);
        }
      }, this.#q.releaseKey);
    }
  }

  /**
   * 执行安全受控动作调度 (严格基于调用方权限声明鉴权)
   * @param {string} callerPluginId
   * @param {string} action
   * @param {any} payload
   */
  async dispatch(callerPluginId, action, payload) {
    // ★ 与 #assertServiceAccess 对齐 —— ACTIVATING 期同样允许调用。
    //   此前 activate() 里 getService 放行而 ctx.dispatchAction 被拒：同一时刻两条能力口径相反，
    //   且「能在 activate 里 registerAction，却不能调用别人的 action」自相矛盾。
    //   对照 Cordis 源码（cordis@4.0.0-rc.10 lib/index.js）：effect 只做 assertActive()（= 未 dispose），
    //   不要求 ACTIVE；服务可用性看的是【提供者】状态。activatePlugin 的依赖检查已保证依赖在调用方激活前已 ACTIVE。
    if (!this.#q.isCallerLive(callerPluginId)) {
      throw new CordiumError(ErrorCode.ACCESS_DENIED, `Security Violation: Caller plugin '${callerPluginId}' is not active`);
    }

    const entry = this.#entries.get(action);
    if (!entry) {
      throw new CordiumError(ErrorCode.ACTION_NOT_FOUND, `Action '${action}' has no registered handler`);
    }

    if (entry.requiredPermission) {
      // ★ 读【宿主持有的权限快照】，不读 caller.manifest ——
      //   后者正是交给插件的那个对象，插件往里 push 一个字符串就能给自己提权。
      if (!this.#q.hasPermission(callerPluginId, entry.requiredPermission)) {
        this.#q.log('warn', `Security Violation: Plugin '${callerPluginId}' lacks permission '${entry.requiredPermission}' for action '${action}'`);
        throw new CordiumError(ErrorCode.ACCESS_DENIED, `Security Violation: Plugin '${callerPluginId}' lacks required permission '${entry.requiredPermission}'`);
      }
    }

    // 执行上限：权限校验只回答"能不能调用"，不回答"会不会把宿主拖死"。
    // ⚠️ 这不是隔离：处理器与宿主同进程，超时只让调用方不再等待，处理器本身可能仍在运行。
    // 第三方插件处理器可能永不 resolve（死循环 await、外部依赖挂起），
    // 没有超时就会让 dispatchAction 永久挂起并连带卡住调用方。
    // 此处给每个动作一个执行上限，超时以明确错误返回而非静默。
    const timeoutMs = entry.timeoutMs ?? this.#q.defaultTimeoutMs();

    // 在途数闸：在调用处理器之前判，被拒的调用零副作用
    const limit = this.#q.maxInFlight();
    if (this.#inFlight >= limit) {
      if (!this.#overloadWarned) {
        this.#overloadWarned = true;
        this.#q.log('warn', `Action dispatch overloaded: ${this.#inFlight} in flight (maxInFlightActions ${limit}); rejecting '${action}' from '${callerPluginId}' — likely recursive or runaway dispatch`,
          { action, callerPluginId, inFlight: this.#inFlight });
      }
      throw new CordiumError(ErrorCode.ACTION_OVERLOADED,
        `Action '${action}' rejected: ${this.#inFlight} dispatches already in flight (maxInFlightActions ${limit}); the handler was not called`,
        { pluginId: callerPluginId });
    }
    this.#inFlight += 1;
    let timedOut = false;
    try {
      const result = await runWithTimeout(
        () => entry.handler(payload, { callerPluginId, action }),
        timeoutMs,
        () => {
          timedOut = true;
          return new CordiumError(ErrorCode.ACTION_TIMEOUT, `Action '${action}' from plugin '${callerPluginId}' timed out after ${timeoutMs}ms`);
        }
      );
      // ★ 执行期间属主被停用（handler 已被摘除）⇒ 迟到的结果不得交给调用方 ——
      //   否则「已停用的插件」仍在向世界输出。⚠️ 副作用可能已经发生（与超时同一口径）。
      if (this.#entries.get(action) !== entry) {
        throw new CordiumError(ErrorCode.ACTION_OWNER_GONE,
          `Action '${action}' owner '${entry.ownerId}' was deactivated before the action completed; result discarded`
        );
      }
      return result;
    } catch (err) {
      // ★ 超时必须与普通失败在审计里【可区分】：outcome='timeout' 而非 'error'，
      //   并明确记下「处理器可能还在跑」—— 调用方据此判断是否需要幂等兜底。
      //   判据是【本次调用自己的】计时器，不是错误码：处理器内部再派发的动作超时也是 action_timeout 码。
      if (timedOut) {
        this.#q.log(
          'warn',
          `Action '${action}' from plugin '${callerPluginId}' timed out after ${timeoutMs}ms`,
          { outcome: 'timeout', note: 'handler may still be running' }
        );
        throw err;
      }
      if (err instanceof CordiumError && err.code === ErrorCode.ACTION_OWNER_GONE) throw err;
      // ★ 处理器冒出来的一切（含它内部再派发失败的 CordiumError）一律套信封 ——
      //   此前原样透传：抛字符串则调用方拿不到码 / 归属 / 栈；更糟的是内部派发的 action_not_found /
      //   action_timeout 与「本动作不存在 / 本动作超时」同码，调用方分不清哪一层出的错（实测）。
      //   原值一条不丢地放在 cause 上（与 parallel 的 listener_failed 同一口径）。
      throw new CordiumError(ErrorCode.ACTION_FAILED,
        `Action '${action}' (owner '${entry.ownerId}') failed: ${summarizeCause(err)}`,
        { cause: err, pluginId: entry.ownerId });
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight < limit / 2) this.#overloadWarned = false;
    }
  }
}
