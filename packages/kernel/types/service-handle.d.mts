/**
 * @file packages/kernel/src/service-handle.mjs
 * @description 服务句柄与契约形状的纯函数（不读宿主状态）：句柄 Proxy、可选不可用错误、终态判定、`methods` 校验。
 *
 * ★ 从 host.mjs 原样搬出，零行为变化。**内部实现，不经 index / internal 导出。**
 *   失效判定本身（`check` 闭包）仍在宿主里 —— 它要读插件表与代次，那是宿主的私有状态。
 */
import { CordiumError } from './errors.mjs';
/**
 * 构造「可选依赖不可用」的稳定错误。
 *
 * 两种情形共用同一个错误码：
 *   ① 提供者插件根本没安装；
 *   ② 装了，但版本不满足调用方声明的可选范围。
 * 调用方只需判断 code === 'optional_unavailable' 即可决定是否降级。
 */
export declare function optionalUnavailable(serviceName: any, reason: any): CordiumError;
/**
 * 插件是否已处于【终态】（停用完成 / 激活失败）。
 *
 * 句柄过期判定只拒绝终态：ACTIVATING / ACTIVE / STOPPING 都视为仍可用 ——
 * 否则「插件在 activate() 里取用自己的服务」与「停用过程中的清理调用」都会被误拦。
 */
export declare function isTerminated(state: any): boolean;
/**
 * ★★ 插件记录是否处于「存活」态（可调用、可被级联停用、算作活着的依赖方）。
 *
 * ★ 为什么抽出来：这个判定此前以 `state === ACTIVE || state === ACTIVATING` 的形状
 *   **散落在 5 处**（调用方鉴权 / 派发鉴权 / 级联停用 / 停用时的依赖方扫描 / action 注册）。
 *   按需激活引入第三种存活态（`ready`）后，逐处修改必然漏 —— 而漏的表现是
 *   **某一处不认 `ready` 的插件**（例如级联停用找不到它，于是留下一个依赖已下线的活插件）。
 *   ⇒ 一处判定，五处共用。
 *
 * ⚠️ `TERMINATED`（`disabled` / `failed`）与「等待触发」（`discovered`）都不是存活态：
 *   前者是终态；后者还没跑过依赖检查，不算「活着」。
 *
 * @param {string} state
 * @returns {boolean}
 */
export declare function isLiveState(state: string): boolean;
/**
 * ★ 该插件是否**已跑完** `activate()`（即它的能力都已登记、可被别人取用）。
 *
 * ⚠️ 与 `isLiveState` 的差别是刻意的，不是笔误：
 *   `ready` 的插件算「活着」（要能级联停它、要能被当作依赖方看待），
 *   但它的 `activate()` **还没跑**，所以任何「依赖必须已就绪」的判定**不得**接受 `ready` ——
 *   否则一个 `ready` 的提供者会被当成已上线，消费者取服务时才炸。
 *   （服务取用侧的 `#resolveProvider` 本就按「注册表里有没有实现」判，天然正确；这里管的是状态判定。）
 *
 * @param {string} state
 * @returns {boolean}
 */
export declare function hasRunActivate(state: string): boolean;
/**
 * 把服务实现包一层薄壳：每次方法调用先跑一次失效检查，再以【原对象】为 this 调用。
 *
 * ★ 为什么 this 必须绑定原对象：
 *   Proxy 的 get 陷阱触发时，方法调用里的 this 会指向 Proxy 而不是原对象 ——
 *   私有字段（#x）与内置槽（Map / Set 等）都会因此访问失败并直接抛错。
 *   所以取值用 target[prop]、调用用 value.apply(target, args)，
 *   【不要】用 Reflect.get(target, prop, receiver)。
 *
 * ★ Proxy 不变量的硬约束：
 *   若某属性是「自有 + 不可写 + 不可配置」（被 Object.freeze 过就是这样），
 *   get 陷阱【必须返回与原属性完全相同的值】，否则引擎抛 TypeError。
 *   ⇒ 这类属性退化为直接返回原方法，代价是它不做生命周期检查。
 *   当前项目所有服务实现都是普通对象字面量，未冻结。
 *
 * ★ 口径：读取侧只包装方法调用入口（非函数属性原样返回）；写入侧一律拒绝（句柄只读）。
 *   `getInternalService` 返回的是裸实现（宿主装配路径，刻意不包），不受这两条约束。
 *
 * ★ 失败口径：实现的方法抛出的任意值（同步抛出或返回的 Promise 拒绝）⇒
 *   CordiumError(service_failed, { pluginId: 提供者, cause: 原值 })。此前原样透传：抛字符串 / undefined 时
 *   消费者拿不到码、归属与栈。句柄自身的判定（service_unavailable / invalid_implementation）不包。
 *   只认原生 Promise 的拒绝；自制 thenable 原样返回（不替它调 then —— 那可能有副作用）。
 *
 * @param {string} serviceName
 * @param {any} impl
 * @param {() => (string | null)} check 返回 null 表示有效，否则返回失效原因
 * @param {string} providerId 失败信封的归属
 */
export declare function wrapServiceHandle(serviceName: string, impl: any, check: () => (string | null), providerId: string): any;
/**
 * 契约 `methods` 字段的声明期校验。
 * 未写 ⇒ null（不查形状）；写了就必须是「非空、不重复的字符串数组」，否则 invalid_contract。
 * ★ 不 trim、不去重后放行：方法名是精确匹配的键，`' chat'` 与 `'chat'` 是两个名字 ——
 *   静默修正会让契约表写的和实际查的不是同一个东西。
 * @returns {readonly string[] | null}
 */
export declare function normalizeContractMethods(serviceName: any, methods: any): readonly string[] | null;
/**
 * 实现缺了契约里的哪些方法 —— 一次列全，不是撞到第一个就停。
 * ★ 用 `impl[name]`（含原型链）而非自有属性：类实例的方法在原型上，按自有属性查会误拒。
 *   与服务句柄 Proxy 的 `target[prop]` 读取口径一致。
 * ★ 声明过的方法若是【访问器】（getter）也算缺失 —— 注册时读一次拿到函数，
 *   之后每次读都可能变脸；而 getInternalService 交出的是裸实现，没有句柄那层兜底。
 *   找不到描述符（Proxy 实现、只有 get 陷阱）按数据属性处理，只看 typeof。
 */
export declare function missingMethods(impl: any, methods: any): any;
