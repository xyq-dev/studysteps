import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../apps/api/package.json'));
const pg = require('pg');
const runtime = join(dirname(fileURLToPath(import.meta.url)), '..', '.local', 'stp004-pg', 'runtime.env');
const env = {};
for (const line of readFileSync(runtime, 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const index = line.indexOf('=');
  env[line.slice(0, index)] = line.slice(index + 1);
}
const client = new pg.Client({ connectionString: env.STP004_ADMIN_DATABASE_URL });
await client.connect();
const result = await client.query(
  `SELECT pg_terminate_backend(pid) AS killed
     FROM pg_stat_activity
    WHERE datname = 'stp004_identity'
      AND pid <> pg_backend_pid()
      AND state = 'idle in transaction'`,
);
process.stdout.write(`cleared_idle_in_transaction=${result.rowCount}\n`);
await client.end();
