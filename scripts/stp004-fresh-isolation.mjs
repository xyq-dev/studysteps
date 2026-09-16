import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../apps/api/package.json'));
const pg = require('pg');

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

const adminUrl = env.STP004_ADMIN_DATABASE_URL;
const apiUrl = env.STP004_TEST_DATABASE_URL || env.DATABASE_URL;
if (!adminUrl || !apiUrl) {
  throw new Error('admin or api database URL missing');
}

const freshName = 'stp004_identity_fresh';
const upgradeApiUrl = env.STP004_UPGRADE_DATABASE_URL || apiUrl.replace(/\/stp004_identity_fresh(?:\?|$)/, '/stp004_identity');
const postgresAdminUrl = adminUrl.replace(/\/[^/]+(?:\?|$)/, '/postgres');
const admin = new pg.Client({ connectionString: postgresAdminUrl, connectionTimeoutMillis: 8000 });
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [freshName]);
if (exists.rowCount === 0) {
  await admin.query(`CREATE DATABASE ${freshName} OWNER stp004_api`);
  process.stdout.write(`created disposable database ${freshName}\n`);
} else {
  process.stdout.write(`disposable database ${freshName} already exists\n`);
}
await admin.end();

const freshUrl = apiUrl.includes(freshName)
  ? apiUrl
  : apiUrl.replace(/\/stp004_identity(?:\?|$)/, `/${freshName}`);
const freshAdminUrl = adminUrl.includes(freshName)
  ? adminUrl
  : adminUrl.replace(/\/stp004_identity(?:\?|$)/, `/${freshName}`);

function rewriteRuntime() {
  let text = readFileSync(runtimeFile, 'utf8');
  if (!text.includes('STP004_UPGRADE_DATABASE_URL=')) {
    text += `STP004_UPGRADE_DATABASE_URL=${upgradeApiUrl}\n`;
  }
  text = text
    .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${freshUrl}`)
    .replace(/^STP004_TEST_DATABASE_URL=.*$/m, `STP004_TEST_DATABASE_URL=${freshUrl}`)
    .replace(/^STP004_ADMIN_DATABASE_URL=.*$/m, `STP004_ADMIN_DATABASE_URL=${freshAdminUrl}`);
  writeFileSync(runtimeFile, text);
  process.stdout.write('runtime.env now points tests at disposable fresh DB; original stp004_identity was not emptied.\n');
}

rewriteRuntime();

const migrate = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
  cwd: root,
  env: { ...env, DATABASE_URL: freshUrl },
  encoding: 'utf8',
  windowsHide: true,
  shell: true,
});
process.stdout.write(migrate.stdout || '');
process.stderr.write(migrate.stderr || '');
if (migrate.status !== 0) {
  process.exit(migrate.status ?? 1);
}

process.stdout.write('\n--- fresh migrate status ---\n');
const status = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'status', '--schema', 'prisma/schema.prisma'], {
  cwd: root,
  env: { ...env, DATABASE_URL: freshUrl },
  encoding: 'utf8',
  windowsHide: true,
  shell: true,
});
process.stdout.write(status.stdout || '');
process.stderr.write(status.stderr || '');

process.stdout.write('\n--- upgrade-path migrate status (original stp004_identity, not applied) ---\n');
const upgrade = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'status', '--schema', 'prisma/schema.prisma'], {
  cwd: root,
  env: { ...env, DATABASE_URL: upgradeApiUrl },
  encoding: 'utf8',
  windowsHide: true,
  shell: true,
});
process.stdout.write(upgrade.stdout || '');
process.stderr.write(upgrade.stderr || '');

const catalog = new pg.Client({ connectionString: freshUrl, connectionTimeoutMillis: 8000 });
await catalog.connect();
const objects = await catalog.query(`
  SELECT 'fk' AS kind, conname AS name FROM pg_constraint
   WHERE conname IN ('auth_challenges_lookup_alias_fkey', 'device_sessions_replaced_pointer_ck')
  UNION ALL
  SELECT 'trg', tgname FROM pg_trigger
   WHERE tgname IN (
     'ss_auth_challenges_step_up_bound_trg',
     'ss_device_sessions_issue_immutable_trg',
     'ss_device_sessions_replacement_guard_trg'
   )
  ORDER BY 1, 2
`);
process.stdout.write(`pg_catalog objects:\n${objects.rows.map((row) => `${row.kind}:${row.name}`).join('\n')}\n`);
await catalog.end();
process.exit(status.status ?? 0);
