/**
 * @file packages/kernel/src/ui-registry.mjs
 * @description UI 贡献注册表 —— **内部实现，不经 index / internal 导出**。
 *
 * ★ Extract Class：`#items` 表连同它的三个操作一起从 host.mjs 搬出（字段与方法同搬，不泄出私有字段）。
 *   宿主以私有字段持有实例、公开方法委托；插件仍只经 ctx.registerUIContribution 进来。
 * ★ 不认识插件表 / 生命周期：scope 是否已释放由调用方传入的 scope 自己回答，属主由调用方注入。
 */

import { CordiumError, ErrorCode } from './errors.mjs';

export class UIRegistry {
  #items = new Map();

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
    if (scope && !scope.active) {
      throw new CordiumError(ErrorCode.SCOPE_DISPOSED,
        `UI contribution cannot be registered by plugin '${ownerId}': `
        + `its scope is already disposed (a disposed plugin must not register anything)`
      );
    }

    const item = typeof contribution === 'string'
      ? { id: contribution, type: 'custom', ownerId }
      : { ...contribution, ownerId };
    if (!item.id) throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'UI contribution must have an id');

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

  /** 列出贡献项的副本（按 type 过滤） */
  list(type) {
    // ★ 交副本：此前交出内部条目本身，外部改 ownerId 即可让属主的 disposer 删不掉它（幽灵贡献）。
    const all = Array.from(this.#items.values(), c => ({ ...c }));
    return type ? all.filter(c => c.type === type) : all;
  }
}
