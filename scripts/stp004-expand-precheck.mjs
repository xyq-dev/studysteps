import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../apps/api/package.json'));
const pg = require('pg');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFile = join(root, '.local', 'stp004-pg', 'runtime.env');
if (!existsSync(runtimeFile)) {
  throw new Error('runtime.env missing; ensure isolated PostgreSQL first');
}
const env = {};
for (const line of readFileSync(runtimeFile, 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const index = line.indexOf('=');
  env[line.slice(0, index)] = line.slice(index + 1);
}
const url = process.argv[2] || env.STP004_TEST_DATABASE_URL || env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL missing from runtime.env');
}

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000 });
await client.connect();
const dbName = (await client.query('SELECT current_database() AS n')).rows[0].n;
process.stdout.write(`precheck database: ${dbName}\n`);

const missingAlias = await client.query(`
  SELECT c.id
    FROM auth_challenges c
   WHERE c.auth_identity_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM auth_identity_lookups l
        WHERE l.auth_identity_id = c.auth_identity_id
          AND l.provider = c.provider
          AND l.kind = c.identity_kind
          AND l.lookup_key_version = c.destination_lookup_key_version
          AND l.subject_lookup_digest = c.destination_lookup_digest
     )
`);

const pointerWithoutRevoke = await client.query(`
  SELECT id
    FROM device_sessions
   WHERE replaced_by_session_id IS NOT NULL
     AND (revoked_at IS NULL OR revocation_reason_code IS NULL)
`);

const danglingPointer = await client.query(`
  SELECT s.id
    FROM device_sessions s
    LEFT JOIN device_sessions t ON t.id = s.replaced_by_session_id
   WHERE s.replaced_by_session_id IS NOT NULL
     AND t.id IS NULL
`);

const duplicatePointer = await client.query(`
  SELECT replaced_by_session_id AS id, COUNT(*)::int AS n
    FROM device_sessions
   WHERE replaced_by_session_id IS NOT NULL
   GROUP BY replaced_by_session_id
  HAVING COUNT(*) > 1
`);

const sameScopeReplacement = await client.query(`
  SELECT s.id
    FROM device_sessions s
    JOIN device_sessions t ON t.id = s.replaced_by_session_id
   WHERE s.scope = t.scope
`);

const digestMismatch = await client.query(`
  SELECT s.id
    FROM device_sessions s
    JOIN device_sessions t ON t.id = s.replaced_by_session_id
   WHERE s.device_installation_digest IS DISTINCT FROM t.device_installation_digest
`);

const partialIdentityParent = await client.query(`
  SELECT id
    FROM auth_challenges
   WHERE ("auth_identity_id" IS NULL) IS DISTINCT FROM ("account_id" IS NULL)
`);

await client.end();

const dirty = [
  ['missing lookup alias on identity-stamped challenges', missingAlias.rowCount],
  ['replacement pointer without revoke/reason', pointerWithoutRevoke.rowCount],
  ['dangling replaced_by_session_id', danglingPointer.rowCount],
  ['duplicate replacement successors', duplicatePointer.rowCount],
  ['same-scope replacement rows', sameScopeReplacement.rowCount],
  ['replacement device digest mismatch', digestMismatch.rowCount],
  ['partial identity/account parent keys', partialIdentityParent.rowCount],
];

let failed = false;
for (const [label, count] of dirty) {
  process.stdout.write(`${label}: ${count}\n`);
  if (count > 0) {
    failed = true;
  }
}

if (failed) {
  process.stderr.write(
    'STP004 expand precheck failed. Stopped without deleting, rewriting, or guessing backfill. Use a new disposable isolation database for clean deploy.\n',
  );
  process.exit(2);
}

process.stdout.write('STP004 expand precheck clean.\n');
