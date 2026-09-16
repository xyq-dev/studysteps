import { createHmac, randomUUID } from 'node:crypto';
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

const twoMigName = 'stp004_two_mig';
const originalName = 'stp004_identity';
const adminUrl = env.STP004_ADMIN_DATABASE_URL;
const originalUrl = env.STP004_UPGRADE_DATABASE_URL;
if (!adminUrl || !originalUrl) {
  throw new Error('STP004_ADMIN_DATABASE_URL and STP004_UPGRADE_DATABASE_URL are required');
}

function rewriteDb(url, name) {
  return url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
}

const postgresAdminUrl = rewriteDb(adminUrl, 'postgres');
const twoMigUrl = rewriteDb(originalUrl, twoMigName);

const admin = new pg.Client({ connectionString: postgresAdminUrl, connectionTimeoutMillis: 8000 });
await admin.connect();
const originalOpen = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [originalName]);
if (originalOpen.rowCount !== 1) {
  await admin.end();
  throw new Error('original stp004_identity missing; leave it read-only and do not recreate it here');
}
await admin.query(
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
  [twoMigName],
);
await admin.query(`DROP DATABASE IF EXISTS ${twoMigName}`);
await admin.query(`CREATE DATABASE ${twoMigName} OWNER stp004_api`);
await admin.end();
process.stdout.write(`created disposable two-migration database ${twoMigName}; original ${originalName} was not modified.\n`);

const twoMig = new pg.Client({ connectionString: twoMigUrl, connectionTimeoutMillis: 8000 });
await twoMig.connect();
for (const folder of [
  '20260914000000_stp004_identity_profiles_consents',
  '20260914170000_stp004_step_up_bound_session',
]) {
  const sql = readFileSync(join(root, 'prisma/migrations', folder, 'migration.sql'), 'utf8');
  await twoMig.query(sql);
  process.stdout.write(`applied SQL ${folder}\n`);
}
await twoMig.end();

function prisma(args, databaseUrl) {
  const result = spawnSync('pnpm', ['exec', 'prisma', ...args, '--schema', 'prisma/schema.prisma'], {
    cwd: root,
    env: { ...env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    windowsHide: true,
    shell: true,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  return result.status ?? 1;
}

const resolvedFirst = prisma(['migrate', 'resolve', '--applied', '20260914000000_stp004_identity_profiles_consents'], twoMigUrl);
if (resolvedFirst !== 0) {
  process.exit(resolvedFirst);
}
const resolvedSecond = prisma(['migrate', 'resolve', '--applied', '20260914170000_stp004_step_up_bound_session'], twoMigUrl);
if (resolvedSecond !== 0) {
  process.exit(resolvedSecond);
}

const lookupKeyRaw = env.IDENTITY_LOOKUP_KEY_V1 ?? '';
const lookupKey = Buffer.from(lookupKeyRaw.replace(/^hex:/, ''), 'hex');
const destination = '+8613800138299';
const digest = createHmac('sha256', lookupKey).update(`PHONE_OTP:PHONE:${destination}`).digest('hex');
const accountId = randomUUID();
const identityId = randomUUID();
const lookupId = randomUUID();
const pendingChallengeId = randomUUID();
const consumedChallengeId = randomUUID();
const sessionId = randomUUID();
const seed = new pg.Client({ connectionString: twoMigUrl, connectionTimeoutMillis: 8000 });
await seed.connect();
await seed.query('BEGIN');
await seed.query(`INSERT INTO accounts (id, status, auth_version, version, created_at, updated_at) VALUES ($1, 'ACTIVE', 1, 1, clock_timestamp(), clock_timestamp())`, [
  accountId,
]);
await seed.query(
  `INSERT INTO auth_identities (id, account_id, kind, provider, encrypted_identifier, encryption_key_version, verified_at, created_at, updated_at)
   VALUES ($1, $2, 'PHONE', 'PHONE_OTP', $3, 'v1', clock_timestamp(), clock_timestamp(), clock_timestamp())`,
  [identityId, accountId, Buffer.from('two-mig-seed')],
);
await seed.query(
  `INSERT INTO auth_identity_lookups (id, auth_identity_id, kind, provider, lookup_key_version, subject_lookup_digest, created_at)
   VALUES ($1, $2, 'PHONE', 'PHONE_OTP', 'v1', $3, clock_timestamp())`,
  [lookupId, identityId, digest],
);
await seed.query(
  `INSERT INTO auth_challenges (
     id, purpose, identity_kind, provider, device_installation_digest, destination_lookup_digest,
     destination_lookup_key_version, code_digest, code_digest_key_version, expires_at, created_at
   ) VALUES (
     $1, 'SIGN_IN', 'PHONE', 'PHONE_OTP', $2, $3, 'v1', $4, 'v1', clock_timestamp() + interval '5 minutes', clock_timestamp()
   )`,
  [pendingChallengeId, randomUUID(), `pending-${randomUUID()}`, randomUUID()],
);
await seed.query(
  `INSERT INTO auth_challenges (
     id, purpose, identity_kind, provider, account_id, auth_identity_id, device_installation_digest,
     destination_lookup_digest, destination_lookup_key_version, code_digest, code_digest_key_version,
     consumed_at, expires_at, created_at
   ) VALUES (
     $1, 'SIGN_IN', 'PHONE', 'PHONE_OTP', $2, $3, $4, $5, 'v1', $6, 'v1',
     clock_timestamp(), clock_timestamp() + interval '5 minutes', clock_timestamp()
   )`,
  [consumedChallengeId, accountId, identityId, randomUUID(), digest, randomUUID()],
);
await seed.query(
  `INSERT INTO device_sessions (
     id, scope, account_id, origin, credential_digest, csrf_digest, account_auth_version_at_issue,
     device_installation_digest, authenticated_at, last_seen_at, expires_at, version, created_at, updated_at
   ) VALUES (
     $1, 'GUARDIAN', $2, 'http://127.0.0.1:5173', $3, $4, 1, $5, clock_timestamp(), clock_timestamp(),
     clock_timestamp() + interval '1 hour', 1, clock_timestamp(), clock_timestamp()
   )`,
  [sessionId, accountId, randomUUID(), randomUUID(), randomUUID()],
);
await seed.query('COMMIT');
await seed.end();
process.stdout.write('seeded legitimate two-migration rows; did not guess-fill lookup aliases.\n');

const precheck = spawnSync(process.execPath, [join(root, 'scripts/stp004-expand-precheck.mjs'), twoMigUrl], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
});
process.stdout.write(precheck.stdout || '');
process.stderr.write(precheck.stderr || '');
if (precheck.status !== 0) {
  process.exit(precheck.status ?? 2);
}

process.stdout.write('\n--- two-mig migrate deploy (3rd then this-round) ---\n');
const deployed = prisma(['migrate', 'deploy'], twoMigUrl);
if (deployed !== 0) {
  process.exit(deployed);
}
process.stdout.write('\n--- two-mig migrate status ---\n');
const twoStatus = prisma(['migrate', 'status'], twoMigUrl);
process.stdout.write('\n--- original upgrade-path migrate status (read-only, expand may stay pending) ---\n');
prisma(['migrate', 'status'], originalUrl);

const catalog = new pg.Client({ connectionString: twoMigUrl, connectionTimeoutMillis: 8000 });
await catalog.connect();
const objects = await catalog.query(`
  SELECT 'ck' AS kind, conname AS name FROM pg_constraint
   WHERE conname IN (
     'auth_challenges_identity_parent_ck',
     'auth_challenges_lookup_parent_ck',
     'auth_challenges_lookup_alias_fkey',
     'device_sessions_replaced_pointer_ck'
   )
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
const counts = await catalog.query('SELECT COUNT(*)::int AS n FROM auth_challenges');
process.stdout.write(`seeded challenges remaining: ${counts.rows[0].n}\n`);
await catalog.end();

let text = readFileSync(runtimeFile, 'utf8');
if (!text.includes('STP004_TWO_MIG_DATABASE_URL=')) {
  text += `STP004_TWO_MIG_DATABASE_URL=${twoMigUrl}\n`;
  writeFileSync(runtimeFile, text);
  process.stdout.write('recorded STP004_TWO_MIG_DATABASE_URL; DATABASE_URL unchanged.\n');
}

if (twoStatus !== 0) {
  process.exit(twoStatus);
}
process.exit(0);
