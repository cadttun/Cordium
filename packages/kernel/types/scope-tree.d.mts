/**
 * @file packages/kernel/src/scope-tree.mjs
 * @description 作用域层级表（键之间的父子关系 + 引用计数 + 私有子键）。
 *
 * ★ 此前住在 MessageChannel 里 —— 消息层兼管作用域层级。
 *   事件放行（channel）与服务解析（host）都要沿同一棵树向上走，树本身不属于任何一方。
 *   字段与方法原样搬出（Extract Class），MessageChannel 以私有字段持有并委托，公开方法签名不变。
 * ★ 内部实现，不经 index / internal 导出。
 */
export declare class ScopeTree {
    #private;
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
    declareScope(childKey: string, parentKey?: string | symbol | null): string | symbol;
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
    ensureScope(childKey: string, parentKey?: string | symbol | null): {
        key: string | symbol;
        parent: string | symbol | null;
        created: boolean;
    };
    /**
     * 释放一次声明（引用计数 -1，归零才真正回收）。
     *
     * ★ 为什么是引用计数而不是"停用即删"：作用域共享是刻意设计，
     *   若先停用的插件直接把键抹掉，仍在用它的插件会**悄悄丢失整条作用域链** ——
     *   服务解析与事件放行同时改变，且现场无任何报错。
     *
     * @param {string | symbol} key
     */
    releaseScope(key: string | symbol): boolean;
    /**
     * 从 `key` 自身出发沿祖先链向上逐个产出（含 `key`，不含顶层之上的 null）：
     * 事件放行、防环、服务解析三处遍历的【唯一实现】。
     * ★ 终止条件 `!= null`：顶层键的 parent 是 `null`，未知键是 `undefined`，两者都该停。
     * ★ 有限性由防环保证：所有建立父子关系的路径都过 `#assertNoCycle`，树里不存在环。
     * @param {string | symbol | null | undefined} key
     */
    ancestors(key: string | symbol | null | undefined): Generator<string | symbol, void, unknown>;
    /**
     * 某作用域的父 key。
     * @returns {string | symbol | null | undefined} `null` = 顶层；`undefined` = 该键未声明
     */
    scopeParentOf(scopeKey: any): string | symbol | null | undefined;
    /** 当前已声明的键数（诊断用；含顶层键） */
    scopeCount(): number;
    /** 当前已声明的作用域键列表（诊断用，顺序确定；与 eventNames 对称） */
    scopeKeys(): (string | symbol)[];
}
