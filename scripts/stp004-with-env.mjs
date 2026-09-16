import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFile = join(root, '.local', 'stp004-pg', 'runtime.env');
if (!existsSync(runtimeFile)) {
  throw new Error('runtime.env missing');
}
const env = { ...process.env };
for (const line of readFileSync(runtimeFile, 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const index = line.indexOf('=');
  env[line.slice(0, index)] = line.slice(index + 1);
}
const args = process.argv.slice(2);
if (args.length === 0) {
  throw new Error('missing command');
}
const result = spawnSync(args[0], args.slice(1), {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: true,
  windowsHide: true,
});
process.exit(result.status ?? 1);
