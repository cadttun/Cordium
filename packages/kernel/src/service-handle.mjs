/**
 * @file packages/kernel/src/service-handle.mjs
 * @description 服务句柄与契约形状的纯函数（不读宿主状态）：句柄 Proxy、可选不可用错误、终态判定、`methods` 校验。
 *
 * ★ 从 host.mjs 原样搬出，零行为变化。**内部实现，不经 index / internal 导出。**
 *   失效判定本身（`check` 闭包）仍在宿主里 —— 它要读插件表与代次，那是宿主的私有状态。
 */

import { LifecycleState } from './types.mjs';
import { summarizeCause } from './host-util.mjs';
import { CordiumError, ErrorCode } from './errors.mjs';

/**
 * 构造「可选依赖不可用」的稳定错误。
 *
 * 两种情形共用同一个错误码：
 *   ① 提供者插件根本没安装；
 *   ② 装了，但版本不满足调用方声明的可选范围。
 * 调用方只需判断 code === 'optional_unavailable' 即可决定是否降级。
 */
export function optionalUnavailable(serviceName, reason) {
  return new CordiumError(ErrorCode.OPTIONAL_UNAVAILABLE, `Optional service '${serviceName}' is unavailable: ${reason}`);
}

/**
 * 插件是否已处于【终态】（停用完成 / 激活失败）。
 *
 * 句柄过期判定只拒绝终态：ACTIVATING / ACTIVE / STOPPING 都视为仍可用 ——
 * 否则「插件在 activate() 里取用自己的服务」与「停用过程中的清理调用」都会被误拦。
 */
export function isTerminated(state) {
  return state === LifecycleState.DISABLED || state === LifecycleState.FAILED;
}

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
export function wrapServiceHandle(serviceName, impl, check, providerId) {
  if (impl === null || (typeof impl !== 'object' && typeof impl !== 'function')) {
    // 原始值没有方法可包，也没有生命周期可言
    return impl;
  }
  /**
   * 包装函数缓存：**每个句柄一份**（不是全局）。
   *
   * ★ 为什么必须按句柄：同一个实现对象可能被多个句柄包着 —— 例如同一个服务被
   *   两个消费者各取一次，或消费者处于不同作用域。它们的 `check` 闭包**各不相同**
   *   （各自捕获自己的 providerId / epoch / slotKey / callerPluginId）。
   *   若把缓存做成模块级 WeakMap（按 target 共享），**先建的那个 check 会串给所有人** ——
   *   于是 B 的句柄按 A 的调用方身份判失效，且**不会有任何报错**。
   *   ⇒ 缓存随 Proxy 一起被回收，天然按句柄隔离。
   */
  const wrappedCache = new Map();

  return new Proxy(impl, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;

      // 不变量：自有 + 不可写 + 不可配置的属性必须原样返回，不能替换成包装函数
      const ownDesc = Object.getOwnPropertyDescriptor(target, prop);
      if (ownDesc && ownDesc.writable === false && ownDesc.configurable === false) {
        return value;
      }

      let wrapped = wrappedCache.get(prop);
      if (!wrapped) {
        // ★ 调用时【重新读】target[prop]（迟绑定），而不是把此刻的 value 捕获进闭包 ——
        //   否则实现方后续替换方法时，句柄会一直调用【旧】方法，且无任何提示。
        wrapped = (...args) => {
          const reason = check();
          if (reason) {
            throw new CordiumError(ErrorCode.SERVICE_UNAVAILABLE, `Service '${serviceName}' is unavailable: ${reason}`);
          }
          // ★ 迟绑定读到的已不是函数（getter 变脸 / 实现方自己删了方法）⇒ 带码失败，
          //   而不是让消费者拿到一条不带 code、不指向提供者的引擎级 TypeError。
          const current = target[prop];
          if (typeof current !== 'function') {
            throw new CordiumError(ErrorCode.INVALID_IMPLEMENTATION,
              `Service '${serviceName}': method '${String(prop)}' is no longer a function on the provider's implementation`);
          }
          const failed = err => new CordiumError(ErrorCode.SERVICE_FAILED,
            `Service '${serviceName}' method '${String(prop)}' (provider '${providerId}') failed: ${summarizeCause(err)}`,
            { cause: err, pluginId: providerId });
          let result;
          try {
            result = current.apply(target, args);
          } catch (err) {
            throw failed(err);
          }
          if (result instanceof Promise) return result.then(undefined, err => { throw failed(err); });
          return result;
        };
        wrappedCache.set(prop, wrapped);
      }
      return wrapped;
    },
    // ★ 句柄只读。此前只有 get 陷阱 ⇒ 写 / 删 / 定义直落共享的实现对象，
    //   一个消费者 `handle.ping = …` 就替所有消费者（含 getInternalService）换掉了方法。
    //   陷阱直接抛错（不返回 false）：返回 false 在严格模式下是不带 code 的 TypeError，
    //   而抛错不受 Proxy 不变量约束。
    set: (_, prop) => readOnly(serviceName, `assign '${String(prop)}'`),
    deleteProperty: (_, prop) => readOnly(serviceName, `delete '${String(prop)}'`),
    defineProperty: (_, prop) => readOnly(serviceName, `define '${String(prop)}'`),
    setPrototypeOf: () => readOnly(serviceName, 'replace the prototype'),
    preventExtensions: () => readOnly(serviceName, 'freeze / seal / preventExtensions')
  });
}

function readOnly(serviceName, what) {
  throw new CordiumError(ErrorCode.ACCESS_DENIED,
    `Service '${serviceName}': handles are read-only — consumers cannot ${what} on the provider's implementation`);
}

/**
 * 契约 `methods` 字段的声明期校验。
 * 未写 ⇒ null（不查形状）；写了就必须是「非空、不重复的字符串数组」，否则 invalid_contract。
 * ★ 不 trim、不去重后放行：方法名是精确匹配的键，`' chat'` 与 `'chat'` 是两个名字 ——
 *   静默修正会让契约表写的和实际查的不是同一个东西。
 * @returns {readonly string[] | null}
 */
export function normalizeContractMethods(serviceName, methods) {
  if (methods === undefined || methods === null) return null;
  const bad = detail => new CordiumError(ErrorCode.INVALID_CONTRACT,
    `Service Violation: contract '${serviceName}' declares invalid methods — ${detail}`);
  if (!Array.isArray(methods)) throw bad(`expected an array of method names, got ${typeof methods}`);
  const seen = new Set();
  for (const name of methods) {
    if (typeof name !== 'string' || !name) throw bad(`entries must be non-empty strings, got ${JSON.stringify(name)}`);
    if (seen.has(name)) throw bad(`duplicate method '${name}'`);
    seen.add(name);
  }
  return Object.freeze([...methods]);
}

/**
 * 实现缺了契约里的哪些方法 —— 一次列全，不是撞到第一个就停。
 * ★ 用 `impl[name]`（含原型链）而非自有属性：类实例的方法在原型上，按自有属性查会误拒。
 *   与服务句柄 Proxy 的 `target[prop]` 读取口径一致。
 * ★ 声明过的方法若是【访问器】（getter）也算缺失 —— 注册时读一次拿到函数，
 *   之后每次读都可能变脸；而 getInternalService 交出的是裸实现，没有句柄那层兜底。
 *   找不到描述符（Proxy 实现、只有 get 陷阱）按数据属性处理，只看 typeof。
 */
export function missingMethods(impl, methods) {
  if (impl === null || (typeof impl !== 'object' && typeof impl !== 'function')) return [...methods];
  return methods.filter(name => isAccessor(impl, name) || typeof impl[name] !== 'function');
}

/** 沿原型链找到 `name` 的第一个描述符；是 get / set 访问器即 true */
function isAccessor(obj, name) {
  for (let o = obj; o !== null; o = Object.getPrototypeOf(o)) {
    const desc = Object.getOwnPropertyDescriptor(o, name);
    if (desc) return 'get' in desc || 'set' in desc;
  }
  return false;
}
