// 边界门禁（CONTRIBUTING「边界」②）：源码不得出现具体服务名 `service.<名>` —— 服务名属上层应用的契约表，不属于通用基座。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// ★ 枚举式词表永远补不完（`service.provider` 就漏过）⇒ 对【源码】加一道模式门：
//   不得出现 `service.<名>` 形式的具体服务名。只扫 src —— 测试夹具合法地使用 `service.demo` 等占位名。
const SRC_DIRS = ['packages/kernel/src', 'packages/plugins/src'];
// ★ 前面不得是 `.` 或标识符字符：`\b` 会误伤属性访问 `this.service.get()`（`.` 与 `s` 之间也是词边界）。
// ⚠️ 已知绕过（文本门禁的固有上限）：拼接 `'service' + '.x'`、模板串、`['service', 'x'].join('.')`。
const SERVICE_NAME = /(?<![.\w])service\.[a-z]/;

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
  assert.ok(SERVICE_NAME.test('// 见 service.provider'));
  assert.ok(SERVICE_NAME.test("declareServiceContract('service.ui', …)"));
  for (const ok of ['this.#serviceContracts.get(serviceName)', "broadcast('internal/service', x)",
    "path: 'service-contract'", 'registerService(name)', '服务（service）与消息', 'this.service.get()', 'ctx.service.x']) {
    assert.ok(!SERVICE_NAME.test(ok), `不得误伤：${ok}`);
  }
});
