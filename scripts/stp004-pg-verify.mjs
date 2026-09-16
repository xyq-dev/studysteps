import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../apps/api/package.json'));
const pg = require('pg');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.local', 'stp004-pg', 'runtime.env');
const env = {};
for (const line of readFileSync(runtime, 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) {
    continue;
  }
  const index = line.indexOf('=');
  env[line.slice(0, index)] = line.slice(index + 1);
}

const client = new pg.Client({ connectionString: env.STP004_ADMIN_DATABASE_URL });
await client.connect();
const isolation = (
  await client.query(
    "SELECT current_database() || '|' || coalesce(inet_server_addr()::text, '127.0.0.1') || '|' || inet_server_port() || '|' || current_setting('listen_addresses') AS v",
  )
).rows[0].v;
const roles = (
  await client.query(
    "SELECT rolname || '|super=' || rolsuper || '|createdb=' || rolcreatedb AS v FROM pg_roles WHERE rolname IN ('stp004_admin','stp004_api') ORDER BY rolname",
  )
).rows.map((row) => row.v);
const owner = (
  await client.query(
    "SELECT d.datname || '|owner=' || r.rolname AS v FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = 'stp004_identity'",
  )
).rows[0].v;
const tables = (
  await client.query("SELECT count(*)::text AS v FROM information_schema.tables WHERE table_schema = 'public'")
).rows[0].v;
await client.end();

process.stdout.write(
  [
    `listen_loopback=${String(isolation).includes('127.0.0.1')}`,
    `roles=${roles.join(';')}`,
    `db=${owner}`,
    `public_tables=${tables}`,
    '',
  ].join('\n'),
);
