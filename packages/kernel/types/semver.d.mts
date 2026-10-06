/**
 * @file packages/kernel/src/semver.mjs
 * @description 语义化版本范围校验器 —— ★ **零依赖的中立模块**
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────
 * 本函数原先定义在 `host.mjs` 里。而 `packages/plugins/src/ecosystem.mjs`
 * 需要它来做插件依赖解析 —— 于是插件层 `import { satisfiesSemVer }
 * from '../../kernel/src/host.mjs'`，**反向依赖了内核的具体实现文件**。
 *
 * ⇒ 后果：想吃这一个纯函数，**得连带加载整个 host.mjs（1600+ 行）**。
 *   违反**稳定依赖原则（SDP）**：依赖边应指向更稳定的方向，
 *   而 `host.mjs` 是具体实现（不稳定），插件是易变叶 —— 方向正好反了。
 *
 * ⇒ 处置（**抽象抽取 / abstraction extraction**）：
 *   把它抽成一个**零 import 的中立模块**，内核与插件**都依赖它**。
 *
 * ── 边界（★ 务必遵守）──────────────────────────────────────────────
 * · 本文件 **不得 import 任何东西** —— 它必须是依赖图里最稳定的一层。
 * · 本文件 **不得引入宿主概念**（host / plugin / scope / ctx 一律不准出现）。
 * · 诊断/日志能力**不得**加进来：一旦依赖宿主，中立性立刻消失。
 *
 * ── 语义基线─────────────────────────────────────────
 * **node-semver 7.7.4 默认模式**（`loose=false` / `includePrerelease=false`）。
 * 本文件是它的**语义等价移植**，逐条对齐 `classes/range.js` 的脱糖顺序：
 * `BUILD 剥离 → caret → tilde → xrange → star → GTE0`。
 *
 * ★ 两阶段分层（与 npm 自身一致：`new Range()` 抛，`semver.satisfies()` 吞）：
 *   · `parseRange()`      —— 非法输入**抛错**（调用方要诊断就用这个）
 *   · `satisfiesSemVer()` —— **捕获后返回 false**（调用方只要布尔就用这个）
 *   ⇒ 因此 `latest` 之类的 dist-tag **不是** range，会走 false 分支。
 *     旧实现把它特判为「永远 true」，是一条 fail-open。
 *
 * ★ 验证方式：**差分测试**（differential testing）——
 *   以 npm 自带的 `semver@7.7.4` 为权威 oracle，四套语料比对 **全部 0 分歧**：
 *   ① 手挑 range 逐条记 oracle 判定，落成夹具 `test/fixtures/semver-fixtures.mjs`
 *      （107 range × 53 版本 = 5,671 条断言）
 *   ② 随机 8 种子 × 189.6 万 = 1,516.8 万组合
 *   ③ 非法/畸形语料 4,867 range（3,000 随机字节 + 2,000 突变）
 *   ④ ★ **长度维度专项** 675 range × 64 版本 = 43,200 组合
 *      （覆盖 oracle safeRegex 的量化上界，见下）
 *
 * ── ★ 与 npm semver 的已知差异（**有意的，不是遗漏**）──────
 * 后人请勿把下表重新报成「缺陷」—— 每条都写了开工条件，条件出现前不移植。
 *
 * | 差异 | npm | 本实现 | 为什么不移植 | 开工条件 |
 * |---|---|---|---|---|
 * | 对象参数 | 收 `SemVer` / `Range` 实例 | 只收字符串；非字符串抛错（对外入口经 `semver-api.mjs` 转成 `CordiumError(invalid_argument)`） | 输入来自 manifest（JSON）⇒ 永远是字符串；支持实例要引入两个类，破坏「纯函数、零依赖」 | 出现非 JSON 来源的调用方 |
 * | `includePrerelease` | 可选开关 | 未实现（恒为 npm 默认 `false`） | 插件 `^1.0.0` 本就不该匹配 `1.0.1-beta`（npm 默认行为即使用者预期） | 第一个「预发布插件版本」的真实需求 |
 * | `loose` | 可选开关 | 未实现（恒为严格） | 放宽的是不合法的串；与 manifest 校验的 fail-loud 收紧方向相反 | 同上，且须先说明为何要放宽 |
 * | `isValidSemVer` 与 `semver.valid` | `valid('1.2.3+build.1')` / `valid('v1.2.3')` / `valid(' 1.2.3')` 返回规范化后的串（真值） | 返回 `false`：原串必须逐字等于规范串 | manifest 原样入库，宽松形式会让各层判定分叉（实测内核层曾放行 `v1.0.0` 而插件层拒绝）；`+build` 不参与比较，留着只会让「同版本」出现两种写法 | 出现需要记录构建元数据的真实 manifest |
 *
 * ★★★ 曾有的真缺陷（已修，保留作教训）：
 *   官方 `internal/re.js` 的 `makeSafeRegex` 会**把所有无界量词换成有界**——
 *   `\s*` := `\s{0,1}`、`\d*` := `\d{0,256}`、`[a-zA-Z0-9-]+` := `…{1,250}`。
 *   最初**整表漏抄**，后果【实测】：range 侧 build id 超 250 字符时
 *   oracle 判非法，而本实现静默放行 ⇒ 一条 fail-open（`1.2.3+` + `a`×251）。
 *   ⇒ 教训：**「照抄语义」必须连带照抄它的安全边界** —— 只抄「逻辑」不抄「上界」，
 *     就会在维度边缘（长度/量化）上悄悄退化成 fail-open。
 */
/**
 * ★ SemVer 优先级比较（`<0` / `0` / `>0`）—— 与 satisfiesSemVer 共用同一套解析与比较（对齐 npm semver）。
 *   catalog 原先手写了一份，`split('-', 2)` 截断含连字符的预发布段
 *   ⇒ `1.0.0-rc-2 → 1.0.0-rc-1` 的降级被放行。全仓只该有这一份比较知识。
 * @param {string} a 版本 A（须为合法 SemVer，否则抛 TypeError）
 * @param {string} b 版本 B（须为合法 SemVer，否则抛 TypeError）
 * @returns {number} `<0` / `0` / `>0`
 * @throws {TypeError} 任一参数不是合法 SemVer
 */
export declare function compareSemVer(a: string, b: string): number;
/**
 * 是否为【规范形式】的 SemVer 版本字符串（非字符串一律 false）。
 *
 * ★ 严格：必须与解析后的规范串【逐字相同】—— 拒绝 `v1.0.0`、首尾空白、`+build` 段。
 *   parseVersion 本身是宽松的（照 npm semver：会 trim、吃掉 v 前缀）；manifest 若以宽松形式入库，
 *   原样保存的字符串与其它层的判定就会分叉（实测：内核层放行 'v1.0.0' 而插件层拒绝）。
 *   两层 manifest 校验都走这里，保证同一输入同一结论。
 * @param {unknown} value 任意值；非字符串一律 false
 * @returns {boolean}
 */
export declare function isValidSemVer(value: unknown): boolean;
export declare const ANY: unique symbol;
export declare class Comparator {
    operator: any;
    semver: typeof ANY | {
        major: number;
        minor: number;
        patch: number;
        prerelease: (string | number)[];
        version: string;
    };
    value: string;
    constructor(comp: any);
    test(v: any): boolean;
}
/**
 * ★ 阶段一：解析。**非法输入抛错。**
 * @param {string} range
 * @returns {Array<Array<Comparator>>} comparator set 列表
 */
export declare function parseRange(range: string): Array<Array<Comparator>>;
/**
 * ★ 阶段二：求值。**非法输入返回 false，不抛错。**
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
export declare function satisfiesSemVer(version: string, range: string): boolean;
