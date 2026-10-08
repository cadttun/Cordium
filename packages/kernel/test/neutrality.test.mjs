// 边界门禁（CONTRIBUTING「边界」②）：源码不得出现具体服务名 `service.<名>` —— 服务名属上层应用的契约表，不属于通用基座。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// ★ 枚举式词表永远补不完（**具体服务名会漏过** —— 词表是枚举式的）⇒ 对【源码】加一道模式门：
//   不得出现 `service.<名>` 形式的具体服务名。只扫 src —— 测试夹具合法地使用 `service.demo` 等占位名。
const SRC_DIRS = ['packages/kernel/src', 'packages/plugins/src'];
// ★ 前面不得是 `.` 或标识符字符：`\b` 会误伤属性访问 `this.service.get()`（`.` 与 `s` 之间也是词边界）。
// ★ 首字符集是 `[a-z0-9]` 而**不是** `[a-z]`：服务名受 `PLUGIN_ID_PATTERN`（`types.mjs`）约束，
//   段是 `[a-z0-9]+` ⇒ **数字开头的服务名（如 `service.9`、`service.2fa`）是合法的**，
//   此前 `[a-z]` 把它们**整类漏判**（实测：`service.9` 是合法服务名却判不出）。
// ★ **大小写敏感是刻意的**：`service.KV` / `service.Provider` 含大写，**不是合法服务名**，
//   因而不可能是「某个上层应用真实存在的服务名」—— 不属本门禁要拦的泄漏（放进去会与标题名不副实，
//   且会误伤「裸变量 `service` 的属性访问」）。**词维度归 `docs/内部门禁/neutrality-words.test.mjs`**，
//   本门禁只管**形状**；两道分工：形归这里、词归那里。
// ⚠️ 已知绕过（文本门禁的固有上限）：拼接 `'service' + '.x'`、模板串、`['service', 'x'].join('.')`。
const SERVICE_NAME = /(?<![.\w])service\.[a-z0-9]/;

test('★ 源码（含注释）不得出现具体服务名 service.<名>（服务名属上层契约表）', () => {
  const hits = [];
  for (const dir of SRC_DIRS) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (!name.endsWith('.mjs')) continue;
      const lines = fs.readFileSync(path.join(ROOT, dir, name), 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => { if (SERVICE_NAME.test(line)) hits.push(`${dir}/${name}:${i + 1}  ${line.trim()}`); });
    }
  }
  assert.deepEqual(hits, [], '\n' + hits.join('\n'));
});

test('★ 门禁自检：服务名模式能判别，且不误伤通用标识符', () => {
  assert.ok(SERVICE_NAME.test('// 见 service.some_thing'));
  assert.ok(SERVICE_NAME.test("declareServiceContract('service.ui', …)"));
  // ★ 数字开头的合法服务名必须拦下（此前 `[a-z]` 整类漏判）
  assert.ok(SERVICE_NAME.test("declareServiceContract('service.9', …)"), 'service.9 是合法服务名，必须拦下');
  assert.ok(SERVICE_NAME.test("'service.2fa'"), 'service.2fa 同上');
  // ★ 大小写敏感是刻意的：大写开头不是合法服务名（`PLUGIN_ID_PATTERN` 只允许小写段 + 数字）
  assert.ok(!SERVICE_NAME.test('service.KV'), 'service.KV 非合法服务名，故意不拦');
  assert.ok(!SERVICE_NAME.test('service.Provider'), 'service.Provider 同上');
  for (const ok of ['this.#serviceContracts.get(serviceName)', "broadcast('internal/service', x)",
    "path: 'service-contract'", 'registerService(name)', '服务（service）与消息', 'this.service.get()', 'ctx.service.x']) {
    assert.ok(!SERVICE_NAME.test(ok), `不得误伤：${ok}`);
  }
});
