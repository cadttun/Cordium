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

// ─────────────────────────────────────── 长度上界（照抄 node-semver internal/constants.js）
const MAX_LENGTH = 256;
const MAX_SAFE_INT = Number.MAX_SAFE_INTEGER;
// Max safe length for a build identifier. The max length minus 6 characters for
// the shortest version with a build 0.0.0+BUILD.
const MAX_SAFE_BUILD_LENGTH = MAX_LENGTH - 6; // 250

// ─────────────────────────────────────── 词法片段（照抄 node-semver internal/re.js）
const LETTER_DASH_NUM = '[a-zA-Z0-9-]';

// ★★★ 安全量化（照抄 node-semver internal/re.js 的 makeSafeRegex）
// 官方注释原文：Replace some greedy regex tokens to prevent regex dos issues.
//   ['\\s', 1]                      ⇒ `\s*` := `\s{0,1}`
//   ['\\d', MAX_LENGTH]             ⇒ `\d*` := `\d{0,256}` / `\d+` := `\d{1,256}`
//   [LETTERDASHNUMBER, 250]         ⇒ `[a-zA-Z0-9-]+` := `…{1,250}`
// ★ 漏抄这张表的后果【实测】：range 侧 build id 超 250 字符时 oracle 判非法，
//   而本实现静默放行 ⇒ 一条 fail-open（已复现并修复）。
// ⇒ 两阶段：先用【不安全字面】拼出全部 pattern，再统一过一遍 safe()。
const SAFE_REPLACEMENTS = [
  ['\\s', 1],
  ['\\d', MAX_LENGTH],
  [LETTER_DASH_NUM, MAX_SAFE_BUILD_LENGTH],
];
const safe = (value) => {
  for (const [token, max] of SAFE_REPLACEMENTS) {
    value = value
      .split(`${token}*`).join(`${token}{0,${max}}`)
      .split(`${token}+`).join(`${token}{1,${max}}`);
  }
  return value;
};

const NUM = '0|[1-9]\\d*';
const NUM_L = '\\d+';
const NONNUM_ID = `\\d*[a-zA-Z-]${LETTER_DASH_NUM}*`;
const PRE_ID = `(?:${NONNUM_ID}|${NUM})`;
const PRE = `(?:-(${PRE_ID}(?:\\.${PRE_ID})*))`;
const BUILD_ID = `${LETTER_DASH_NUM}+`;
const BUILD = `(?:\\+(${BUILD_ID}(?:\\.${BUILD_ID})*))`;

const MAIN = `(${NUM})\\.(${NUM})\\.(${NUM})`;
const FULL_PLAIN = `v?${MAIN}${PRE}?${BUILD}?`;

// loose 形式 —— 仅用于 COMPARATORTRIM 的备选分支，与 oracle 的字面构造一致
const PRE_ID_L = `(?:${NONNUM_ID}|${NUM_L})`;
const MAIN_L = `(${NUM_L})\\.(${NUM_L})\\.(${NUM_L})`;
const LOOSE_PLAIN = `[v=\\s]*${MAIN_L}(?:-?(${PRE_ID_L}(?:\\.${PRE_ID_L})*))?${BUILD}?`;

const XID = `${NUM}|x|X|\\*`;
const XRANGE_PLAIN = `[v=\\s]*(${XID})(?:\\.(${XID})(?:\\.(${XID})${PRE}?${BUILD}?)?)?`;

const GTLT = '((?:<|>)?=?)';

const RE_FULL = new RegExp(safe(`^${FULL_PLAIN}$`));
const RE_BUILD = new RegExp(safe(BUILD));
const RE_XRANGE = new RegExp(safe(`^${GTLT}\\s*${XRANGE_PLAIN}$`));
const RE_TILDE = new RegExp(safe(`^~>?${XRANGE_PLAIN}$`));
const RE_CARET = new RegExp(safe(`^\\^${XRANGE_PLAIN}$`));
const RE_COMPARATOR = new RegExp(safe(`^${GTLT}\\s*(${FULL_PLAIN})$|^$`));
const RE_HYPHEN = new RegExp(safe(`^\\s*(${XRANGE_PLAIN})\\s+-\\s+(${XRANGE_PLAIN})\\s*$`));
const RE_COMPARATOR_TRIM = new RegExp(safe(`(\\s*)${GTLT}\\s*(${XRANGE_PLAIN}|${LOOSE_PLAIN})`), 'g');
const RE_TILDE_TRIM = new RegExp(safe(`(\\s*)~>?\\s+`), 'g');
const RE_CARET_TRIM = new RegExp(safe(`(\\s*)\\^\\s+`), 'g');
const RE_STAR = new RegExp(safe(`(<|>)?=?\\s*\\*`));
const RE_GTE0 = new RegExp(safe(`^\\s*>=\\s*0\\.0\\.0\\s*$`));
const RE_SPACES = /\s+/g;
const RE_NUMERIC_ID = /^[0-9]+$/;

const isX = (id) => !id || id.toLowerCase() === 'x' || id === '*';

// ─────────────────────────────────────── 版本
function parseVersion(raw) {
  const src = String(raw);
  if (src.length > MAX_LENGTH) throw new TypeError(`version is longer than ${MAX_LENGTH} characters`);
  const m = src.trim().match(RE_FULL);
  if (!m) throw new TypeError(`Invalid Version: ${raw}`);

  const major = +m[1];
  const minor = +m[2];
  const patch = +m[3];
  if (major > MAX_SAFE_INT || major < 0) throw new TypeError('Invalid major version');
  if (minor > MAX_SAFE_INT || minor < 0) throw new TypeError('Invalid minor version');
  if (patch > MAX_SAFE_INT || patch < 0) throw new TypeError('Invalid patch version');

  // 数字标识符仅在 < MAX_SAFE_INTEGER 时数字化，否则保留字符串（照抄 oracle）
  const prerelease = m[4]
    ? m[4].split('.').map((id) => {
      if (RE_NUMERIC_ID.test(id)) {
        const num = +id;
        if (num >= 0 && num < MAX_SAFE_INT) return num;
      }
      return id;
    })
    : [];

  return {
    major,
    minor,
    patch,
    prerelease,
    version: `${major}.${minor}.${patch}${m[4] ? `-${m[4]}` : ''}`,
  };
}

// 照抄 oracle 的 compareIdentifiers（含「数字字符串重新数字化」这条路径）
function compareIdentifiers(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  const anum = RE_NUMERIC_ID.test(a);
  const bnum = RE_NUMERIC_ID.test(b);
  if (anum && bnum) { a = +a; b = +b; }
  return a === b ? 0
    : (anum && !bnum) ? -1
      : (bnum && !anum) ? 1
        : a < b ? -1 : 1;
}

function cmpPrerelease(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // 无 prerelease > 有 prerelease
  if (!b.length) return -1;
  let i = 0;
  for (;;) {
    const x = a[i];
    const y = b[i];
    if (x === undefined && y === undefined) return 0;
    if (y === undefined) return 1;
    if (x === undefined) return -1;
    if (x !== y) return compareIdentifiers(x, y);
    i++;
  }
}

function cmpVersion(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return cmpPrerelease(a.prerelease, b.prerelease);
}

/**
 * ★ SemVer 优先级比较（`<0` / `0` / `>0`）—— 与 satisfiesSemVer 共用同一套解析与比较（对齐 npm semver）。
 *   catalog 原先手写了一份，`split('-', 2)` 截断含连字符的预发布段
 *   ⇒ `1.0.0-rc-2 → 1.0.0-rc-1` 的降级被放行。全仓只该有这一份比较知识。
 * @throws {TypeError} 任一参数不是合法 SemVer
 */
export function compareSemVer(a, b) {
  return cmpVersion(parseVersion(a), parseVersion(b));
}

/**
 * 是否为【规范形式】的 SemVer 版本字符串（非字符串一律 false）。
 *
 * ★ 严格：必须与解析后的规范串【逐字相同】—— 拒绝 `v1.0.0`、首尾空白、`+build` 段。
 *   parseVersion 本身是宽松的（照 npm semver：会 trim、吃掉 v 前缀）；manifest 若以宽松形式入库，
 *   原样保存的字符串与其它层的判定就会分叉（实测：内核层放行 'v1.0.0' 而插件层拒绝）。
 *   两层 manifest 校验都走这里，保证同一输入同一结论。
 */
export function isValidSemVer(value) {
  if (typeof value !== 'string') return false;
  try { return parseVersion(value).version === value; } catch { return false; }
}

// ─────────────────────────────────────── 脱糖
function replaceTilde(comp) {
  return comp.replace(RE_TILDE, (_, M, m, p, pr) => {
    if (isX(M)) return '';
    if (isX(m)) return `>=${M}.0.0 <${+M + 1}.0.0-0`;
    if (isX(p)) return `>=${M}.${m}.0 <${M}.${+m + 1}.0-0`;
    if (pr) return `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
    return `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`;
  });
}

function replaceCaret(comp) {
  return comp.replace(RE_CARET, (_, M, m, p, pr) => {
    if (isX(M)) return '';
    if (isX(m)) return `>=${M}.0.0 <${+M + 1}.0.0-0`;
    if (isX(p)) {
      return M === '0'
        ? `>=${M}.${m}.0 <${M}.${+m + 1}.0-0`
        : `>=${M}.${m}.0 <${+M + 1}.0.0-0`;
    }
    if (pr) {
      if (M === '0') {
        return m === '0'
          ? `>=${M}.${m}.${p}-${pr} <${M}.${m}.${+p + 1}-0`
          : `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
      }
      return `>=${M}.${m}.${p}-${pr} <${+M + 1}.0.0-0`;
    }
    if (M === '0') {
      return m === '0'
        ? `>=${M}.${m}.${p} <${M}.${m}.${+p + 1}-0`
        : `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`;
    }
    return `>=${M}.${m}.${p} <${+M + 1}.0.0-0`;
  });
}

function replaceXRange(comp) {
  return comp.replace(RE_XRANGE, (ret, gtlt, M, m, p) => {
    const xM = isX(M);
    const xm = xM || isX(m);
    const xp = xm || isX(p);

    if (gtlt === '=' && xp) gtlt = '';

    if (xM) return gtlt === '>' || gtlt === '<' ? '<0.0.0-0' : '*';

    if (gtlt && xp) {
      if (xm) m = 0;
      p = 0;
      if (gtlt === '>') {
        gtlt = '>=';
        if (xm) { M = +M + 1; m = 0; } else { m = +m + 1; }
      } else if (gtlt === '<=') {
        gtlt = '<';
        if (xm) M = +M + 1; else m = +m + 1;
      }
      return `${gtlt}${M}.${m}.${p}${gtlt === '<' ? '-0' : ''}`;
    }
    if (xm) return `>=${M}.0.0 <${+M + 1}.0.0-0`;
    if (xp) return `>=${M}.${m}.0 <${M}.${+m + 1}.0-0`;
    return ret;
  });
}

// Because * is AND-ed with everything else in the comparator,
// and '' means "any version", just remove the *s entirely.
const replaceStars = (comp) => comp.trim().replace(RE_STAR, '');
const replaceGTE0 = (comp) => comp.trim().replace(RE_GTE0, '');

// ★ 顺序与 oracle 的 parseComparator 严格一致，不得调换
function parseComparator(comp) {
  return replaceStars(replaceXRange(replaceTilde(replaceCaret(comp.replace(RE_BUILD, '')))));
}

// 1.2 - 3.4.5 => >=1.2.0 <=3.4.5；1.2.3 - 3.4 => >=1.2.0 <3.5.0-0
function hyphenReplace(_0, from, fM, fm, fp, fpr, _fb, to, tM, tm, tp, tpr) {
  let lo;
  let hi;
  if (isX(fM)) lo = '';
  else if (isX(fm)) lo = `>=${fM}.0.0`;
  else if (isX(fp)) lo = `>=${fM}.${fm}.0`;
  else lo = `>=${from}`;

  if (isX(tM)) hi = '';
  else if (isX(tm)) hi = `<${+tM + 1}.0.0-0`;
  else if (isX(tp)) hi = `<${tM}.${+tm + 1}.0-0`;
  else if (tpr) hi = `<=${tM}.${tm}.${tp}-${tpr}`;
  else hi = `<=${to}`;

  return `${lo} ${hi}`.trim();
}

// ─────────────────────────────────────── Comparator
const ANY = Symbol('SemVer ANY');

class Comparator {
  constructor(comp) {
    const m = comp.match(RE_COMPARATOR);
    if (!m) throw new TypeError(`Invalid comparator: ${comp}`);
    this.operator = m[1] !== undefined && m[1] !== '=' ? m[1] : '';
    // 「字面上就是 '>' 或 ''」⇒ 放行一切（oracle 原文注释：allow anything）
    this.semver = m[2] ? parseVersion(m[2]) : ANY;
    this.value = this.semver === ANY ? '' : this.operator + this.semver.version;
  }

  test(v) {
    if (this.semver === ANY) return true;
    const d = cmpVersion(v, this.semver);
    switch (this.operator) {
      case '': return d === 0;
      case '>': return d > 0;
      case '>=': return d >= 0;
      case '<': return d < 0;
      case '<=': return d <= 0;
      default: throw new TypeError(`Invalid operator: ${this.operator}`);
    }
  }
}

const isNullSet = (c) => c.value === '<0.0.0-0';
const isAny = (c) => c.value === '';

/**
 * ★ 阶段一：解析。**非法输入抛错。**
 * @param {string} range
 * @returns {Array<Array<Comparator>>} comparator set 列表
 */
export function parseRange(range) {
  if (typeof range !== 'string') throw new TypeError(`Invalid SemVer Range: ${range}`);

  const raw = range.trim().replace(RE_SPACES, ' ');

  let sets = raw
    .split('||')
    .map((part) => {
      // 六步脱糖 —— 顺序照抄 oracle 的 Range#parseRange
      let r = part.trim();
      r = r.replace(RE_HYPHEN, hyphenReplace);
      r = r.replace(RE_COMPARATOR_TRIM, '$1$2$3');
      r = r.replace(RE_TILDE_TRIM, '$1~');
      r = r.replace(RE_CARET_TRIM, '$1^');

      const comparators = r
        .replace(RE_SPACES, ' ')
        .split(' ')
        .map(parseComparator)
        .join(' ')
        .split(/\s+/)
        .map(replaceGTE0)
        .map((c) => new Comparator(c));

      // 照抄 oracle：任一 comparator 是 null set ⇒ 该组即 null set
      // 否则按 value 去重；去重后不止一个且含 ANY ⇒ 丢掉 ANY（★ 去重必须早于判 ANY）
      const map = new Map();
      for (const c of comparators) {
        if (isNullSet(c)) return [c];
        map.set(c.value, c);
      }
      if (map.size > 1) map.delete('');
      return [...map.values()];
    })
    .filter((set) => set.length);

  if (!sets.length) throw new TypeError(`Invalid SemVer Range: ${raw}`);

  // 多组时的折叠：null set 全丢（全 null 则保留第一组）；有一组是 ANY ⇒ 整条就是 ANY
  if (sets.length > 1) {
    const first = sets[0];
    const nonNull = sets.filter((set) => !isNullSet(set[0]));
    if (nonNull.length === 0) sets = [first];
    else {
      sets = nonNull;
      if (sets.length > 1) {
        const anySet = sets.find((set) => set.length === 1 && isAny(set[0]));
        if (anySet) sets = [anySet];
      }
    }
  }
  return sets;
}

// ─────────────────────────────────────── 求值
function testSet(set, v) {
  for (const c of set) if (!c.test(v)) return false;
  if (v.prerelease.length) {
    // prerelease 门：仅当**同一 comparator set 内**存在「同 major.minor.patch
    // 且自身带 prerelease」的 comparator 才放行（per comparator set，非全 range）
    for (const c of set) {
      const s = c.semver;
      if (s !== ANY && s.prerelease.length > 0 &&
          s.major === v.major && s.minor === v.minor && s.patch === v.patch) return true;
    }
    return false;
  }
  return true;
}

/**
 * ★ 阶段二：求值。**非法输入返回 false，不抛错。**
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
export function satisfiesSemVer(version, range) {
  let sets;
  let v;
  try {
    sets = parseRange(range);
    v = parseVersion(version);
  } catch {
    return false;
  }
  return sets.some((set) => testSet(set, v));
}
