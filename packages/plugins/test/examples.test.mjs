/**
 * @file packages/plugins/test/examples.test.mjs
 * @description 仓库 examples/ 目录的示例必须真的能跑：以子进程运行，核对输出。
 *
 * 示例是读者照抄的起点；接口一改示例就过时，只有跑起来才知道。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples');

/** 删临时目录；清理失败只留痕（t.diagnostic），绝不掩盖测试本身的失败。
 *  force: true 只忽略 ENOENT，不吞 EBUSY/EPERM ⇒ 靠 maxRetries: 3 兜住 Windows 上的句柄延迟释放。 */
function cleanup(dir, t) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    const msg = `临时目录清理失败：${dir} —— ${err.message}`;
    if (t?.diagnostic) t.diagnostic(msg); else process.emitWarning(msg);
  }
}

test('★ examples/basic：加载、调用、级联停用与恢复的输出与预期一致', () => {
  const out = execFileSync(process.execPath, [path.join(EXAMPLES, 'basic/main.mjs')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(out.replace(/\r\n/g, '\n'), [
    'booted: example.store=active example.greeter=active example.audit=active',
    'Hello, Ada! (#1)',
    'Hello, Ada! (#2)',
    'Hello, Linus! (#1)',
    "audit: [ 'Ada#1', 'Ada#2', 'Linus#1' ]",
    'store off: example.store=disabled example.greeter=disabled example.audit=active',
    'greeter now: no_provider',
    'stale greeter: scope_disposed',
    'store on: example.store=active example.greeter=active example.audit=active',
    'Hello, Ada! (#1)',
    ''
  ].join('\n'));
});

test('★ examples/hot-reload：改插件文件并保存 ⇒ 不重启进程换上新代码', async (t) => {
  // 在临时目录里改一份副本，不动仓库里的示例
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cordium-example-'));
  let child;
  try {
    for (const name of ['greeting.mjs', 'ticker.mjs']) fs.copyFileSync(path.join(EXAMPLES, 'hot-reload/plugins', name), path.join(dir, name));

    child = spawn(process.execPath, [path.join(EXAMPLES, 'hot-reload/main.mjs'), dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const waitFor = (re, ms = 15_000) => new Promise((resolve, reject) => {
      const until = Date.now() + ms;
      const poll = () => {
        if (re.test(out)) return resolve();
        if (Date.now() > until || child.exitCode !== null) return reject(new Error(`waiting for ${re}; output so far:\n${out}`));
        setTimeout(poll, 50);
      };
      poll();
    });
    await waitFor(/watching /);
    await waitFor(/\[tick\] Hello, Cordium!/);
    const file = path.join(dir, 'greeting.mjs');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
      .replace("version: '1.0.0'", "version: '1.0.1'")
      .replace("const text = 'Hello';", "const text = 'Hi';"));
    await waitFor(/\[reload\] example\.greeting 1\.0\.0 -> 1\.0\.1/);
    await waitFor(/\[tick\] Hi, Cordium!/);
    assert.doesNotMatch(out, /reload failed/);
  } finally {
    // ★ 先结束子进程并等它退出（Windows 上它可能仍持有目录句柄），再删临时目录
    if (child) {
      child.kill();
      await new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    cleanup(dir, t);
  }
});
