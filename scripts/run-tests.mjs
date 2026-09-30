// 列出两包的 *.test.mjs 交给 `node --test`，不依赖 shell 展开 glob。
// Windows 的 cmd 不展开 `*.test.mjs`，Node 20 的 --test 也不认 glob，直接写在 npm script 里会在 Windows + Node 20 上找不到文件。
// 额外参数原样转给 node（如 `--experimental-test-coverage`）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(ROOT, 'packages');
const files = [];

/** 递归收集目录下的 *.test.mjs（只走目录，不进 fixtures 之外的子目录也无所谓——按后缀判定即可） */
function collect(dir, rel) {
  for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = `${rel}/${ent.name}`;
    if (ent.isDirectory()) collect(`${dir}/${ent.name}`, r);
    else if (ent.name.endsWith('.test.mjs')) files.push(r);
  }
}

for (const pkg of fs.readdirSync(packagesDir).sort()) {
  const dir = path.join('packages', pkg, 'test');
  if (!fs.existsSync(path.join(ROOT, dir))) continue;
  collect(dir, dir);
}
if (files.length === 0) {
  console.error('run-tests: no *.test.mjs found under packages/*/test');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: ROOT, stdio: 'inherit' });
process.exit(result.status ?? 1);
