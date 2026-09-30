/**
 * @file packages/kernel/src/scope-tree.mjs
 * @description 作用域层级表（键之间的父子关系 + 引用计数 + 私有子键）。
 *
 * ★ 此前住在 MessageChannel 里 —— 消息层兼管作用域层级。
 *   事件放行（channel）与服务解析（host）都要沿同一棵树向上走，树本身不属于任何一方。
 *   字段与方法原样搬出（Extract Class），MessageChannel 以私有字段持有并委托，公开方法签名不变。
 * ★ 内部实现，不经 index / internal 导出。
 */

import { CordiumError, ErrorCode } from './errors.mjs';

export class ScopeTree {
  /**
   * 作用域表：key → { parent, holders }。
   *
   * 用途有两个：
   *   ① 事件放行 / 服务解析时沿【祖先链】向上查找（见 `MessageChannel#admit`）；
   *   ② ★ **登记「绑定只发生一次」这个事实** —— `parent` 为 `null` 表示**顶层键**，
   *      它同样是一条记录，因此**顶层键不再是"无记录"状态**，谁来给它挂父级都会被拒。
   *
   * ★ 层级住在「key 之间的关系」里，而不是住在某个 context 的属性上
   *   （即 "the hierarchy lives in the
   *   key-level parent relation, not in context tags"）。
   *
   * ★★ 为什么顶层键也必须入表（修过的一个洞）：旧实现只在【有父级】时才写表，
   *   于是 `ctx.scoped('writer')`（根上下文）**什么都不登记**。此后另一个插件
   *   执行 `ctx.scoped('team').scoped('writer')` 时，"改嫁守卫"看不到任何冲突，
   *   便【静默地】把别人的顶层作用域挂到了 `team` 底下 —— 实测后果是：
   *   那个从没听说过 team 的插件，突然能解析到 team 的私有服务实现，
   *   而 team 的监听器也开始收到它的事件。
   *
   * ★ `holders` 是引用计数：同一个键可能被多个插件声明（多 agent 共享作用域是刻意设计），
   *   只有当最后一个持有者释放时才真正回收 —— 否则"先停用的那个插件"会把
   *   还在用的插件的作用域链【悄悄拆掉】。
   *   （规则：只有当整个聚合为空时才回收作用域层。）
   *
   * ★ `children` 与 `holders` 分开计数 —— 子键对父键的持有【不走 holders】。
   *   此前子键持有也记在 holders 上，于是声明者多调几次 releaseScope（或插件拿到宿主挂的
   *   释放闭包反复调用）就能把计数减到 0、删掉仍有子键的父键，再把同名父键重建到自己下面
   *   接管整条子链（实测）。现在：父键只有在【声明者归零且无子键】时才回收，
   *   多余的 release 不会让 holders 低于 0。
   *
   * @type {Map<string | symbol, { parent: string | symbol | null, holders: number, children: number }>}
   */
  #scopes = new Map();

  /**
   * 私有作用域下的子键备忘：父键（symbol）→ (标签 → 专属子键)。
   *
   * 用途：`ctx.privateScope().scoped('sub')` 里的 `'sub'` 不能被别的私有作用域蹭到，
   * 所以它在私有父键下会被换成一个【该父键专属】的新 symbol。
   * ★ 同一个父键下同名标签必须拿到【同一个】子键，否则 `scoped('sub')` 调两次
   *   会得到两个不同的作用域 —— 幂等性就没了。
   *
   * ★ 用 **WeakMap**：私有作用域的父键是个 symbol，而 **ES2023 起「非注册 symbol」可以作
   *   WeakMap 的键**（MDN WeakMap：「Objects and **non-registered symbols** can be used as keys
   *   because they are garbage-collectable」；tc39 提案把规范里的 `Type(key) is not Object` 换成了
   *   `CanBeHeldWeakly(key)`）。
   *   ⇒ 父键一旦不可达（插件停用后 ctx 被回收），这张备忘表**自动**被回收，不需要任何手工清理。
   *   ⚠️ 边界：`Symbol.for()` 造的**注册** symbol 不可作 WeakMap 键（实测抛 TypeError）；
   *     本处用的是 `Symbol(...)`，是**非注册**的，安全。
   *
   * ⚠️ 教训：这里原先是 `Map` + 一句「symbol 不能作 WeakMap 键」的注释 ——
   *   **那句话是错的**（过时知识）。更糟的是它直接带坏了一个设计选择：
   *   因为不能用 WeakMap，就写了"释放时手工 delete"的补偿逻辑，而那个 delete 删的是
   *   **子键**自己的条目（子键没有下级），**真正的泄漏（父键那张表）永远不会被命中**。
   *   实测：200 轮「建私有作用域 → 挂子标签 → 释放」之后，`#scopes` 归 0，
   *   而这张表**残留 200 条**。⇒ 一句错误的注释，换来了一个真实的泄漏。
   *
   * @type {WeakMap<symbol, Map<string, symbol>>}
   */
  #privateChildren = new WeakMap();

  /**
   * ★★ 声明一个作用域的【位置】—— 这是本层唯一的作用域登记入口。
   *
   * 效果（皆按官方语义）：
   *   · **注册视图向下继承** —— 子作用域能看到祖先的层；
   *     本层只实现「事件放行」这一侧，注册视图的继承在宿主侧（`#resolveProvider`）。
   *   · **事件放行向上延伸** —— 打了 parentKey tag 的监听器能收到 childKey 的事件。
   *
   * ★ **绑定仅此一次**（已有父级的键再绑到别的父级直接抛错）：
   *   同一个键声明到【不同】的父级上一律抛错，而不是静默覆盖。
   *   静默覆盖的后果是：某个 agent 的事件会诡异地流进另一个 agent 的作用域，
   *   而现场没有任何报错 —— 这类「静默改变拓扑」正是最难排查的一类缺陷。
   * ★★ **顶层键同样入表**（`parent: null`）—— 这是修过的一个洞：
   *   过去顶层键"什么都没登记"，于是第三方可以用 `scoped(x).scoped(别人已有的顶层键)`
   *   把别人的作用域【追溯】挂到自己底下，从而蹭到它的服务与事件。
   * ★ 幂等：重复声明【同一个键 + 同一父级】不会报错，只加引用计数。
   * ★ 防环：若新关系会形成环，直接抛错 —— 否则祖先链遍历会死循环。
   *
   * @param {string} childKey 子键（标签字符串，或私有作用域下自动派的 symbol）
   * @param {string | symbol | null} parentKey 父键；**`null` 表示顶层**（不是"没有关系"）
   * @returns {string | symbol} 实际生效的键 —— 属性为 symbol 的父键下会派发专属子键
   */
  declareScope(childKey, parentKey = null) {
    if (!childKey) {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'declareScope requires a non-empty child key');
    }
    // ★ 私有作用域下的子键要换成【该父键专属】的 symbol，
    //   否则两个插件的 privateScope().scoped('sub') 会撞成同一个作用域。
    const key = (typeof parentKey === 'symbol') ? this.#privateChildKey(parentKey, childKey) : childKey;

    if (key === parentKey) {
      throw new CordiumError(ErrorCode.SCOPE_CYCLE, `declareScope: '${String(childKey)}' cannot be its own parent`);
    }
    // ★ 顺序要紧：先查成环，再查改绑。
    //   因为"改绑成环"这一种输入两个条件都满足，改成先查改绑会把成环那条检查
    //   变成【永远不可达的死代码】—— 而它的报错信息恰恰更具体、更指向真因。
    this.#assertNoCycle(key, parentKey, 'declareScope');

    const existing = this.#scopes.get(key);
    if (existing) {
      if (existing.parent !== parentKey) {
        // ★★ 这里就是修过的那个洞：顶层键（parent === null）过去【不入表】，
        //    于是 `ctx.scoped('writer')` 之后再有人做 `scoped('team').scoped('writer')`
        //    不会被拦下，而是把别人的顶层作用域静默挂到了 team 底下。
        throw new CordiumError(ErrorCode.SCOPE_CONFLICT,
          `declareScope: '${String(childKey)}' is already declared with parent `
          + `'${existing.parent === null ? '(top-level)' : String(existing.parent)}', `
          + `cannot re-declare it under '${parentKey === null ? '(top-level)' : String(parentKey)}'`
        );
      }
      existing.holders += 1;   // 同一个键被多方声明是合法的（共享作用域），只加计数
      return key;
    }

    this.#retainParent(parentKey);
    this.#scopes.set(key, { parent: parentKey, holders: 1, children: 0 });
    return key;
  }

  /**
   * ★★ 加入或新建一个作用域 —— `ctx.scoped(label)` 走的就是这条。
   *
   * 与 `declareScope` 的区别，是最关键的一处语义切分：
   *   · `declareScope` = **决定位置**。已有不同父级 ⇒ 抛错。（宿主装配期用的窄入口）
   *   · `ensureScope`  = **取得句柄**。已有 ⇒ 原样加入，**绝不改写**它的位置。
   *
   * ★ 为什么必须是「不改写」而不是「抛错」：
   *   同一个作用域常常需要被多个插件【引用】（agent 循环 / 记忆 / 工具都要落在 agent:x 里）。
   *   引用者多数并不关心它挂在谁下面，只是想要一个绑定到它的 ctx。
   *   若把"引用"也当成"声明"，就会出现「两个插件都写 `ctx.scoped('agent:child')`
   *   却因为一个在根上写、一个在嵌套里写而互相打红」——那是把引用者的写法差异
   *   当成了拓扑冲突。
   *
   * ★★ 而**关键的安全性质靠"不改写"本身就成立**：
   *   漏洞的成因是"声明会【改变】已有键的位置"，所以只要加入即不改写，
   *   第三方就再也不可能把别人的顶层作用域【追溯】挂到自己底下。
   *   ⇒ 不是靠拦截，而是靠**这个操作没有那个能力**。
   *
   * ★ 引用计数：**加入者也计数**。否则"先停用的创建者"会把还在被引用的作用域
   *   悄悄回收掉，引用它的插件会静默丢失整条作用域链。
   *
   * @param {string} childKey
   * @param {string | symbol | null} parentKey
   * @returns {{ key: string | symbol, parent: string | symbol | null, created: boolean }}
   *   `parent` 是**实际**的父级（加入时可能不等于调用方请求的那个）
   */
  ensureScope(childKey, parentKey = null) {
    if (!childKey) {
      throw new CordiumError(ErrorCode.INVALID_ARGUMENT, 'ensureScope requires a non-empty child key');
    }
    const key = (typeof parentKey === 'symbol') ? this.#privateChildKey(parentKey, childKey) : childKey;
    const existing = this.#scopes.get(key);
    if (existing) {
      existing.holders += 1;
      return { key, parent: existing.parent, created: false };
    }
    // ★★ 新建路径必须与 `declareScope` 做【同一个】防环检查。
    //
    //   曾有的不对称：`declareScope` 有防环、`ensureScope` 当时没有，
    //   而两者的前提条件是一样的（都要求 parentKey 是一条已有链）。实测可复现：
    //     ch.ensureScope('a', 'p');  ch.ensureScope('p', 'a');   // → p→a、a→p 成环，无人拦截
    //   而 `MessageChannel#admit` 的祖先链遍历（`for (cursor = key; cursor != null; cursor = parentOf(cursor))`）
    //   **没有步数上限** ⇒ 环一旦建立，每次派发都会**死循环**（实测：链 a→p→a→p… 永不终止）。
    //
    //   ⚠️ 可达性边界（实测）：**今天从插件代码走不到** —— `ctx.scoped()` 传的 parentKey
    //   永远是一个已声明的键，而"已存在 ⇒ 只加入、不改写"这条本身也挡住了改写。
    //   但 `ensureScope` 是 MessageChannel 的公开方法，宿主装配或将来的重构
    //   都可能直接从外部调用 —— 所以这道检查是**结构性预防**，不是可有可无的装饰。
    //   ★ 口径同「不改写」那次：**让这个操作没有产生环的能力**，而不是事后去拦截它。
    this.#assertNoCycle(key, parentKey, 'ensureScope');
    this.#retainParent(parentKey);
    this.#scopes.set(key, { parent: parentKey, holders: 1, children: 0 });
    return { key, parent: parentKey, created: true };
  }

  /**
   * 防环：确认 `parentKey` 的祖先链不会绕回 `key`。
   *
   * ★ 两个登记入口共用同一份判定 —— 分开写两份迟早漂移（本项目反复踩过「白名单重建」类缺陷）。
   * ★ 这也是 `MessageChannel#admit` 那条无上限遍历能保证有限的前提：
   *   只要【所有】建立父子关系的路径都过这里，就不存在环。
   *
   * @param {string | symbol} key
   * @param {string | symbol | null} parentKey
   * @param {string} where 报错里标明是哪个入口
   */
  #assertNoCycle(key, parentKey, where) {
    for (const cursor of this.ancestors(parentKey)) {
      if (cursor === key) {
        throw new CordiumError(ErrorCode.SCOPE_CYCLE, `${where}: binding '${String(key)}' under '${String(parentKey)}' would create a cycle`);
      }
    }
  }

  /**
   * 释放一次声明（引用计数 -1，归零才真正回收）。
   *
   * ★ 为什么是引用计数而不是"停用即删"：作用域共享是刻意设计，
   *   若先停用的插件直接把键抹掉，仍在用它的插件会**悄悄丢失整条作用域链** ——
   *   服务解析与事件放行同时改变，且现场无任何报错。
   *
   * @param {string | symbol} key
   */
  releaseScope(key) {
    const existing = this.#scopes.get(key);
    if (!existing) return false;
    if (existing.holders > 0) existing.holders -= 1;   // ★ 不得减到负数（多余的 release 是空操作）
    return this.#collect(key);
  }

  /** 声明者归零且无子键 ⇒ 回收，并沿父链归还子键持有（迭代，避免深链递归） */
  #collect(key) {
    let collected = false;
    let cursor = key;
    while (cursor != null) {
      const entry = this.#scopes.get(cursor);
      if (!entry || entry.holders > 0 || entry.children > 0) break;
      this.#scopes.delete(cursor);
      if (typeof cursor === 'symbol') this.#privateChildren.delete(cursor);
      collected = true;
      const parent = entry.parent != null ? this.#scopes.get(entry.parent) : null;
      if (!parent) break;
      parent.children -= 1;
      cursor = entry.parent;
    }
    return collected;
  }

  /**
   * ★★ 子键【持有】父键 —— 新建子键时给父键 holders +1，子键回收时归还。
   *
   * 修的洞（实测）：旧实现里子键不计入父键的引用。父键的所有声明者都停用后
   * 父键被删，子键的 parent 指针却还指着那个【名字】。之后任何人重建同名父键
   * （可以挂到自己的作用域下面），既有子链就整条被接管：
   *   受害者 emit 的事件流进攻击者的祖先监听器，getService 解析到攻击者的实现。
   * ⇒ 这绕过了 ensureScope 的「加入不改写」。
   * 修法：只要还有子键，父键就不会被回收 —— 名字不会空出来，也就无从被重建。
   */
  #retainParent(parentKey) {
    if (parentKey == null) return;
    let parent = this.#scopes.get(parentKey);
    if (!parent) {
      // ★ 父键尚未声明 ⇒ 以【顶层】入表（无声明者，只被子键持有）。
      //   此前不入表：之后任何人 `ensureScope(父键, 自己的键)` 都能把它【新建】到自己下面，
      //   从而接管已有子链（实测，经宿主 API 可达）。入表后位置即定死，后来者只能加入。
      parent = { parent: null, holders: 0, children: 0 };
      this.#scopes.set(parentKey, parent);
    }
    parent.children += 1;
  }

  /**
   * 取/造私有父键下的专属子键（同一父键下同名标签必须拿到同一个子键，保持幂等）。
   * @param {symbol} parentKey
   * @param {string} label
   */
  #privateChildKey(parentKey, label) {
    let map = this.#privateChildren.get(parentKey);
    if (!map) {
      map = new Map();
      this.#privateChildren.set(parentKey, map);
    }
    let child = map.get(label);
    if (!child) {
      child = Symbol(`cordium.private-scope:${label}`);
      map.set(label, child);
    }
    return child;
  }

  /**
   * 从 `key` 自身出发沿祖先链向上逐个产出（含 `key`，不含顶层之上的 null）：
   * 事件放行、防环、服务解析三处遍历的【唯一实现】。
   * ★ 终止条件 `!= null`：顶层键的 parent 是 `null`，未知键是 `undefined`，两者都该停。
   * ★ 有限性由防环保证：所有建立父子关系的路径都过 `#assertNoCycle`，树里不存在环。
   * @param {string | symbol | null | undefined} key
   */
  *ancestors(key) {
    for (let cursor = key; cursor != null; cursor = this.#scopes.get(cursor)?.parent) yield cursor;
  }

  /**
   * 某作用域的父 key。
   * @returns {string | symbol | null | undefined} `null` = 顶层；`undefined` = 该键未声明
   */
  scopeParentOf(scopeKey) {
    return this.#scopes.get(scopeKey)?.parent;
  }

  /** 当前已声明的键数（诊断用；含顶层键） */
  scopeCount() {
    return this.#scopes.size;
  }

  /** 当前已声明的作用域键列表（诊断用，顺序确定；与 eventNames 对称） */
  scopeKeys() {
    return Array.from(this.#scopes.keys());
  }
}
