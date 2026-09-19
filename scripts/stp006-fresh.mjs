import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../apps/api/package.json'));
const pg = require('pg');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFile = join(root, '.local', 'stp004-pg', 'runtime.env');
if (existsSync(runtimeFile)) {
  for (const line of readFileSync(runtimeFile, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    if (!process.env[key]) process.env[key] = line.slice(index + 1);
  }
}

const FORBIDDEN = new Set([
  'stp004_identity',
  'stp004_identity_fresh',
  'stp005_four_to_six',
  'stp005_unknown_leftover',
  'stp005_rev_fresh',
  'stp005_rev_four_to_six',
]);
const freshName = 'stp006_fresh';
const originalName = 'stp004_identity';

const adminUrl = process.env.STP004_ADMIN_DATABASE_URL;
const apiUrl = process.env.STP004_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl || !apiUrl) {
  throw new Error('admin or api database URL missing');
}

function rewriteDb(url, name) {
  return url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
}

function databaseName(url) {
  return new URL(url).pathname.replace(/^\//, '').split('?')[0];
}

const postgresAdminUrl = rewriteDb(adminUrl, 'postgres');
const admin = new pg.Client({ connectionString: postgresAdminUrl, connectionTimeoutMillis: 8000 });
await admin.connect();
const originalOpen = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [originalName]);
if (originalOpen.rowCount !== 1) {
  await admin.end();
  throw new Error('original stp004_identity missing; leave existing databases untouched');
}
for (const name of FORBIDDEN) {
  const open = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  process.stdout.write(`existing ${name}: ${open.rowCount === 1 ? 'kept' : 'absent'}\n`);
}
await admin.query(
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
  [freshName],
);
await admin.query(`DROP DATABASE IF EXISTS ${freshName}`);
await admin.query(`CREATE DATABASE ${freshName} OWNER stp004_api`);
await admin.end();
process.stdout.write(`created exclusive disposable ${freshName}; existing databases were not reset.\n`);

const freshUrl = rewriteDb(apiUrl.includes('stp004_api') ? apiUrl : rewriteDb(apiUrl, freshName), freshName);
const freshAdminUrl = rewriteDb(adminUrl, freshName);
if (databaseName(freshUrl) !== freshName || FORBIDDEN.has(databaseName(freshUrl))) {
  throw new Error(`refusing migrate target ${databaseName(freshUrl)}`);
}

const migrate = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: freshUrl },
  encoding: 'utf8',
  windowsHide: true,
  shell: true,
});
process.stdout.write(migrate.stdout || '');
process.stderr.write(migrate.stderr || '');
if (migrate.status !== 0) {
  process.exit(migrate.status ?? 1);
}

const verify = new pg.Client({ connectionString: freshUrl, connectionTimeoutMillis: 8000 });
await verify.connect();
const db = await verify.query('SELECT current_database() AS name');
if (db.rows[0].name !== freshName) {
  await verify.end();
  throw new Error(`migrate landed on ${db.rows[0].name}, not ${freshName}`);
}
const applied = await verify.query(
  `SELECT COUNT(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
);
const tables = await verify.query(`SELECT to_regclass('study_plans') AS plans, to_regclass('task_occurrences') AS occ, to_regclass('task_horizon_jobs') AS jobs`);
await verify.end();
if (applied.rows[0].n !== 11) {
  throw new Error(`expected 11 applied migrations on ${freshName}, found ${applied.rows[0].n}`);
}
if (!tables.rows[0].plans || !tables.rows[0].occ || !tables.rows[0].jobs) {
  throw new Error('seventh or eleventh migration tables missing');
}
process.stdout.write(`verified current_database=${freshName} applied=${applied.rows[0].n}\n`);

if (existsSync(runtimeFile)) {
  let text = readFileSync(runtimeFile, 'utf8');
  const setLine = (key, value) => {
    if (new RegExp(`^${key}=`, 'm').test(text)) {
      text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
    } else {
      text += `${key}=${value}\n`;
    }
  };
  setLine('DATABASE_URL', freshUrl);
  setLine('STP004_TEST_DATABASE_URL', freshUrl);
  setLine('STP004_ADMIN_DATABASE_URL', freshAdminUrl);
  setLine('STP006_FRESH_DATABASE_URL', freshUrl);
  writeFileSync(runtimeFile, text);
  process.stdout.write('runtime.env now points tests at stp006_fresh; existing STP005 libraries unchanged.\n');
}

process.exit(0);
