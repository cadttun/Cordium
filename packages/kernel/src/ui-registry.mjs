/**
 * @file packages/kernel/src/ui-registry.mjs
 * @description UI 贡献注册表 —— **内部实现，不经 index / internal 导出**。
 *
 * ★ Extract Class：`#items` 表连同它的三个操作一起从 host.mjs 搬出（字段与方法同搬，不泄出私有字段）。
 *   宿主以私有字段持有实例、公开方法委托；插件仍只经 ctx.registerUIContribution 进来。
 * ★ 不认识插件表 / 生命周期：scope 是否已释放由调用方传入的 scope 自己回答，属主由调用方注入。
 */

import { CordiumError, ErrorCode } from './errors.mjs';
import { assertScopeLive } from './host-util.mjs';

/**
 * @typedef {object} UIRegistryQueries
 * @property {(type: string) => boolean} [isKnownType] `type` 是否为装配方登记过的合法值
 * @property {() => string[]} [knownTypes] 已登记值集（仅用于报文）
 */

export class UIRegistry {
  #items = new Map();
  #q;

  /** @param {UIRegistryQueries} [queries] 不传 ⇒ 不校验 `type`（保持旧行为） */
  constructor(queries = {}) {
    this.#q = queries;
  }

  /** 当前条目数（诊断用） */
  get size() { return this.#items.size; }

  /**
   * 注册 UI 贡献项 (面板/快捷栏/命令)
   * @param {string | object} contribution
   * @param {string} ownerId
   * @param {import('./scope.mjs').EffectScope | null} scope
   */
  register(contribution, ownerId, scope) {
    // ★ 生命周期门禁：与 registerService / registerAction 同一口径。
    //   已释放的 scope 上登记 UI 会静默成功，而 unregister 再也不会被调用
    //   （dispose 早就跑完了）⇒ 贡献列表里永久多一条筛不掉的项。
    assertScopeLive(scope,
      `UI contribution cannot be registered by plugin '${ownerId}': `
      + `its scope is already disposed (a disposed plugin must not register anything)`);

    const shorthand = typeof contribution === 'string';
    const item = shorthand
      ? { id: contribution, type: 'custom', ownerId }
      : { ...contribution, ownerId };
    if (!item.id) throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'UI contribution must have an id');

    // ★ 字符串速记硬编码 `type:'custom'`。若装配方登记了类型值集且**不含** 'custom'，
    //   下面那道类型门会以 `unknown type "custom"` 报错 —— 而调用方**从没写过 'custom'**，
    //   报文指不到真因。⇒ 对【速记】这条路径先给一句能指路的错（值集为空时仍不校验，旧行为不变）。
    //   ⚠️ 抛出与否与改前一致（改前也经类型门抛），只是报文更准 ⇒ 非行为变更。
    if (shorthand && this.#q.isKnownType && this.#q.knownTypes().length > 0 && !this.#q.isKnownType('custom')) {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT,
        `UI contribution '${item.id}' by plugin '${ownerId}': the string shorthand implies type 'custom', `
        + `which the host has not declared (declared: ${this.#q.knownTypes().join(', ')}); `
        + `pass a full contribution object with a declared type instead`
      );
    }

    // ★ type 成员校验（写表之前）—— 同 `kind` / `access` / `log.level` 的口径。
    //
    //   实测的坑（在消费方）：上层 UI 宿主的分派是
    //     `if type==='theme' … else if type==='command' … else if (item.slot) …`
    //   ⇒ **type 拼错但带 `slot` 的贡献会静默落进 panels** ——「拼错值静默落成最宽松的那个」
    //   在本项目的第三个实例。内核装不了那道闸（它不该知道 `slot` 是什么），
    //   但可以提供【登记口】让消费方把它自己的值集交进来。
    //
    //   ⚠️ 值集为空（装配方未登记）⇒ 不校验：内核不得替消费方猜它的值集。
    if (this.#q.isKnownType && this.#q.knownTypes().length > 0 && !this.#q.isKnownType(item.type)) {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT,
        `UI contribution '${item.id}' by plugin '${ownerId}' has unknown type ${JSON.stringify(item.type)} — `
        + `types must be declared by the host via host.declareUIContributionTypes() `
        + `(declared: ${this.#q.knownTypes().join(', ')})`
      );
    }

    // ★ 查重与所有权 —— 对齐 registerAction 的做法，**不得静默覆盖**。
    //   此前这里是 `map.set(item.id, item)`，后者直接顶掉前者。
    //   两种情形都【拒绝】，**不选「幂等」**：重复注册通常意味着逻辑错误
    //   （例如两条注册路径写同一个 id），静默幂等会把它掩盖成「看起来正常」。
    const existing = this.#items.get(item.id);
    if (existing) {
      throw new CordiumError(ErrorCode.DUPLICATE_UI_CONTRIBUTION,
        existing.ownerId === ownerId
          ? `UI contribution '${item.id}' is already registered by plugin '${ownerId}'`
          : `UI contribution '${item.id}' is already registered by plugin '${existing.ownerId}'`
      );
    }

    this.#items.set(item.id, item);

    if (scope) {
      scope.trackUIContribution(item.id);
    }
  }

  /** 按属主注销（非属主的注销请求不生效） */
  unregister(contributionId, ownerId) {
    const item = this.#items.get(contributionId);
    if (item && item.ownerId === ownerId) {
      this.#items.delete(contributionId);
    }
  }

  /**
   * 列出贡献项的副本（按 type 过滤）
   *
   * @param {string} [type] 可选。按 `type` **精确相等**过滤；**省略 / `null` ⇒ 返回全部**。
   * @returns {any[]} 贡献项的副本（逐条浅拷贝）
   */
  list(type) {
    // ★ 交副本：此前交出内部条目本身，外部改 ownerId 即可让属主的 disposer 删不掉它（幽灵贡献）。
    const all = Array.from(this.#items.values(), c => ({ ...c }));
    // ★ 判据用 `== null`（undefined / null）而非真值 —— 此前 `type ? … : all` 让**空串** `''`
    //   也落进「返回全部」那一支（'' 是假值）⇒ `getUIContributions('')` 返回全部而非空集，
    //   与「按 type 精确相等过滤」的承诺相反。
    return type === undefined || type === null ? all : all.filter(c => c.type === type);
  }
}
