// 打包内容门禁：两包的 tarball 只含 package.json、LICENSE、README.md、src/*.mjs 与 types/*.d.mts，
// 且 src 下每个模块都在、每个模块的类型声明也都在。
// ★ README.md 是【要】进包的：npm 只认包目录下的 README，缺了它 npm 页面会显示「This package does not have a README」。
// ★ 为什么跑真的 `npm pack --dry-run`，而不是只读 `files` 字段：`files` 之外还有 npm 的默认包含 / 排除规则
//   （README、LICENSE、.npmignore 等），判据取打包器的实际输出，才不会与真相漂移（「以实际输出为准」口径）。
// ⚠️ 依赖 PATH 上有 npm（本仓 `npm test` 本身就经 npm 跑）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function packedFiles(workspace) {
  // 用整条命令串（而非 execFileSync + shell:true 传参数组）：Windows 上 npm 是 .cmd，需要 shell
  const out = execSync(`npm pack --dry-run --json --workspace ${workspace}`, {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
  });
  const [entry] = JSON.parse(out);
  return entry.files.map(f => f.path.replace(/\\/g, '/')).sort();
}

for (const [workspace, dir] of [['@cordium/kernel', 'packages/kernel'], ['@cordium/plugins', 'packages/plugins']]) {
  test(`★ ${workspace} 打包内容：只含 package.json + LICENSE + README.md + src/*.mjs + types/*.d.mts，且模块与声明一个不少`, () => {
    const files = packedFiles(workspace);
    assert.ok(files.includes('LICENSE'), 'tarball 缺 LICENSE（MIT 要求随副本附带许可声明）');
    assert.ok(files.includes('README.md'), 'tarball 缺 README.md（npm 页面会显示「does not have a README」）');
    const allowed = new Set(['package.json', 'LICENSE', 'README.md']);
    const stray = files.filter(f => !allowed.has(f)
      && !/^src\/[\w.-]+\.mjs$/.test(f)
      && !/^types\/[\w.-]+\.d\.mts$/.test(f));
    assert.deepEqual(stray, [], `不该进包的文件（测试 / 文档 / 夹具等）：\n${stray.join('\n')}`);

    const modules = fs.readdirSync(path.join(ROOT, dir, 'src')).filter(n => n.endsWith('.mjs'));
    const expected = modules.map(n => `src/${n}`);
    const missing = expected.filter(f => !files.includes(f));
    assert.deepEqual(missing, [], `src 下有模块没进包：\n${missing.join('\n')}`);

    // ★ 声明文件必须与 src **一一对应**。这是「exports 的 types 条件指向的文件存在」
    //   之外的另一半：少一个，消费方在那个子路径上就静默退回「无类型」，
    //   而包本身看着完全正常 —— 又是一次「宣称成立、判据不成立」。
    const expectedDecl = modules.map(n => `types/${n.replace(/\.mjs$/, '.d.mts')}`);
    const missingDecl = expectedDecl.filter(f => !files.includes(f));
    assert.deepEqual(missingDecl, [], `types 下缺了对应模块的声明（跑一次 npm run types:emit）：\n${missingDecl.join('\n')}`);
  });
}

test('★ 包内 LICENSE 与仓库根 LICENSE 逐字一致（改了根文件忘了同步即红）', () => {
  const root = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  for (const dir of ['packages/kernel', 'packages/plugins']) {
    assert.equal(fs.readFileSync(path.join(ROOT, dir, 'LICENSE'), 'utf8'), root, `${dir}/LICENSE 与根 LICENSE 不一致`);
  }
});
