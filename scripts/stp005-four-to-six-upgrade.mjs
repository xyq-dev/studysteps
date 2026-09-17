import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

const FOUR = [
  '20260914000000_stp004_identity_profiles_consents',
  '20260914170000_stp004_step_up_bound_session',
  '20260914233000_stp004_expand_lookup_replacement',
  '20260915160000_stp004_parent_keys_cycle_clock',
];
const FIFTH = '20260916120000_stp005_grade_catalog_templates';
const SIXTH = '20260916180000_stp005_legacy_fingerprint_and_version_fks';
const FORBIDDEN = new Set(['stp004_identity', 'stp004_identity_fresh', 'stp005_four_to_six', 'stp005_unknown_leftover']);
const originalName = 'stp004_identity';
const fixtureName = 'stp005_rev_four_to_six';
const forgedName = 'stp005_rev_forged';
const dirtyName = 'stp005_rev_dirty';

const adminUrl = process.env.STP004_ADMIN_DATABASE_URL;
if (!adminUrl) {
  throw new Error('STP004_ADMIN_DATABASE_URL is required');
}

function rewriteDb(url, name) {
  return url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
}

function databaseName(url) {
  return new URL(url).pathname.replace(/^\//, '').split('?')[0];
}

function assertAllowed(name) {
  if (FORBIDDEN.has(name) || !name.startsWith('stp005_rev_')) {
    throw new Error(`refusing database ${name}`);
  }
}

function prisma(args, databaseUrl) {
  const name = databaseName(databaseUrl);
  assertAllowed(name);
  const result = spawnSync('pnpm', ['exec', 'prisma', ...args, '--schema', 'prisma/schema.prisma'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    windowsHide: true,
    shell: true,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  return result.status ?? 1;
}

async function applySql(client, folder) {
  const sql = readFileSync(join(root, 'prisma/migrations', folder, 'migration.sql'), 'utf8');
  await client.query(sql);
  process.stdout.write(`applied SQL ${folder} on ${await currentDb(client)}\n`);
}

async function currentDb(client) {
  const row = await client.query('SELECT current_database() AS name');
  const name = row.rows[0].name;
  if (FORBIDDEN.has(name)) {
    throw new Error(`query executed on forbidden database ${name}`);
  }
  return name;
}

function tupleDigest(row) {
  return createHash('md5')
    .update(
      [row.stage_code, row.school_system_code, row.grade_code, row.grade_label, row.term_code]
        .map((value) => value ?? '')
        .join('\x1f'),
    )
    .digest('hex');
}

async function recreateDb(admin, name) {
  assertAllowed(name);
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  process.stdout.write(`created disposable ${name}; original ${originalName} was not modified.\n`);
}

async function seedLeftoverAndEmpty(client) {
  const accountId = randomUUID();
  const leftoverId = randomUUID();
  const emptyId = randomUUID();
  await client.query(
    `INSERT INTO accounts (id, status, auth_version, version, created_at, updated_at)
     VALUES ($1, 'ACTIVE', 1, 1, clock_timestamp(), clock_timestamp())`,
    [accountId],
  );
  await client.query(
    `INSERT INTO student_profiles (
       id, status, nickname, avatar_preset_id, age_band, age_confirmation_source, age_confirmed_at,
       age_confirmed_by_account_id, stage_code, school_system_code, grade_code, grade_label, term_code,
       timezone, created_by_account_id, version, created_at, updated_at
     ) VALUES (
       $1, 'ONBOARDING', '遗留快照', 'avatar-03', 'UNDER_14', 'GUARDIAN_DECLARATION', clock_timestamp(),
       $2, 'primary', 'liusan', 'g3', '三年级', '2026-1', 'Asia/Shanghai', $2, 1, clock_timestamp(), clock_timestamp()
     )`,
    [leftoverId, accountId],
  );
  await client.query(
    `INSERT INTO student_profiles (
       id, status, nickname, avatar_preset_id, age_band, age_confirmation_source, age_confirmed_at,
       age_confirmed_by_account_id, timezone, created_by_account_id, version, created_at, updated_at
     ) VALUES (
       $1, 'ONBOARDING', '空升级档案', 'avatar-03', 'UNDER_14', 'GUARDIAN_DECLARATION', clock_timestamp(),
       $2, 'Asia/Shanghai', $2, 1, clock_timestamp(), clock_timestamp()
     )`,
    [emptyId, accountId],
  );
  const leftover = await client.query(
    `SELECT stage_code, school_system_code, grade_code, grade_label, term_code FROM student_profiles WHERE id = $1`,
    [leftoverId],
  );
  return { accountId, leftoverId, emptyId, digest: tupleDigest(leftover.rows[0]) };
}

async function seedAssigned(client, accountId) {
  const assignedId = randomUUID();
  const grade = await client.query(`
    SELECT g.id, v.grade_label
      FROM grade_configs g
      JOIN grade_config_versions v ON v.id = g.current_version_id
     WHERE g.school_system_code = 'SIX_THREE' AND g.stage_code = 'PRIMARY' AND g.grade_code = 'G3'
  `);
  if (grade.rowCount !== 1) {
    throw new Error('expected published SIX_THREE G3 after migration 5');
  }
  await client.query(
    `INSERT INTO student_profiles (
       id, status, nickname, avatar_preset_id, age_band, age_confirmation_source, age_confirmed_at,
       age_confirmed_by_account_id, grade_config_id, stage_code, school_system_code, grade_code, grade_label,
       term_code, timezone, created_by_account_id, version, created_at, updated_at
     ) VALUES (
       $1, 'ONBOARDING', '已配齐升级档案', 'avatar-03', 'UNDER_14', 'GUARDIAN_DECLARATION', clock_timestamp(),
       $2, $3, 'PRIMARY', 'SIX_THREE', 'G3', $4, 'FULL_YEAR', 'Asia/Shanghai', $2, 1, clock_timestamp(), clock_timestamp()
     )`,
    [assignedId, accountId, grade.rows[0].id, grade.rows[0].grade_label],
  );
  return assignedId;
}

const postgresAdminUrl = rewriteDb(adminUrl, 'postgres');
const admin = new pg.Client({ connectionString: postgresAdminUrl, connectionTimeoutMillis: 8000 });
await admin.connect();
const originalOpen = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [originalName]);
if (originalOpen.rowCount !== 1) {
  await admin.end();
  throw new Error('original stp004_identity missing; leave it read-only');
}
await recreateDb(admin, fixtureName);
await recreateDb(admin, forgedName);
await recreateDb(admin, dirtyName);
await admin.end();

const fixtureUrl = rewriteDb(adminUrl, fixtureName);
assertAllowed(databaseName(fixtureUrl));

const fixture = new pg.Client({ connectionString: fixtureUrl, connectionTimeoutMillis: 8000 });
await fixture.connect();
if ((await currentDb(fixture)) !== fixtureName) throw new Error('fixture landed on the wrong database');
for (const folder of FOUR) {
  await applySql(fixture, folder);
}
const seeded = await seedLeftoverAndEmpty(fixture);
process.stdout.write(`seeded leftover digest=${seeded.digest}\n`);
await fixture.end();
for (const folder of FOUR) {
  if (prisma(['migrate', 'resolve', '--applied', folder], fixtureUrl) !== 0) process.exit(1);
}

const afterFour = new pg.Client({ connectionString: fixtureUrl, connectionTimeoutMillis: 8000 });
await afterFour.connect();
await applySql(afterFour, FIFTH);
const allowAfterFive = await afterFour.query(
  `SELECT stage_code, school_system_code, grade_code, grade_label, term_code, tuple_digest
     FROM stp005_trusted_legacy_allowlist WHERE student_profile_id = $1`,
  [seeded.leftoverId],
);
if (allowAfterFive.rowCount !== 1 || allowAfterFive.rows[0].tuple_digest !== seeded.digest) {
  throw new Error('trusted allowlist did not capture the original leftover tuple in migration 5');
}
await seedAssigned(afterFour, seeded.accountId);
await afterFour.end();
if (prisma(['migrate', 'resolve', '--applied', FIFTH], fixtureUrl) !== 0) process.exit(1);

const afterFive = new pg.Client({ connectionString: fixtureUrl, connectionTimeoutMillis: 8000 });
await afterFive.connect();
await applySql(afterFive, SIXTH);
const leftoverAfterSix = await afterFive.query(
  `SELECT stage_code, school_system_code, grade_code, grade_label, term_code, grade_config_id, grade_config_version_id
     FROM student_profiles WHERE id = $1`,
  [seeded.leftoverId],
);
if (tupleDigest(leftoverAfterSix.rows[0]) !== seeded.digest) {
  throw new Error('leftover tuple changed during migration 6');
}
if (leftoverAfterSix.rows[0].grade_config_id != null || leftoverAfterSix.rows[0].grade_config_version_id != null) {
  throw new Error('migration 6 must not wipe or guess-fill leftover');
}
const prints = await afterFive.query(
  `SELECT tuple_digest FROM stp005_trusted_legacy_allowlist WHERE student_profile_id = $1`,
  [seeded.leftoverId],
);
if (prints.rowCount !== 1 || prints.rows[0].tuple_digest !== seeded.digest) {
  throw new Error(`allowlist digest mismatch: expected ${seeded.digest} got ${prints.rows[0]?.tuple_digest}`);
}
const assigned = await afterFive.query(
  `SELECT sp.grade_config_version_id, g.current_version_id
     FROM student_profiles sp
     JOIN grade_configs g ON g.id = sp.grade_config_id
    WHERE sp.nickname = '已配齐升级档案'`,
);
if (assigned.rowCount !== 1 || assigned.rows[0].grade_config_version_id !== assigned.rows[0].current_version_id) {
  throw new Error('assigned row must receive the published current version id only');
}
await afterFive.end();
if (prisma(['migrate', 'resolve', '--applied', SIXTH], fixtureUrl) !== 0) process.exit(1);
process.stdout.write('four→revised-five→revised-six leftover digest matched; assigned version backfilled.\n');

async function expectSixthBlocked(url, seedFn, label) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000 });
  await client.connect();
  for (const folder of [...FOUR, FIFTH]) {
    await applySql(client, folder);
  }
  await seedFn(client);
  let blocked = false;
  let message = '';
  try {
    await applySql(client, SIXTH);
  } catch (error) {
    message = String(error?.message ?? error);
    blocked = true;
  }
  const versionCol = await client.query(`
    SELECT COUNT(*)::int AS n
      FROM information_schema.columns
     WHERE table_name = 'student_profiles' AND column_name = 'grade_config_version_id'
  `);
  const backfilled = await client.query(`
    SELECT COUNT(*)::int AS n FROM student_profiles WHERE grade_config_id IS NOT NULL
  `).catch(() => ({ rows: [{ n: -1 }] }));
  await client.end();
  if (!blocked) {
    throw new Error(`${label}: migration 6 must fail`);
  }
  if (versionCol.rows[0].n !== 0) {
    throw new Error(`${label}: version id column appeared after a failed precheck`);
  }
  process.stdout.write(`${label} blocked migration 6: ${message.split('\n')[0]}\n`);
  return { blocked, versionCol: versionCol.rows[0].n, assignedSeen: backfilled.rows[0].n };
}

const forgedUrl = rewriteDb(adminUrl, forgedName);
await expectSixthBlocked(
  forgedUrl,
  async (client) => {
    const accountId = randomUUID();
    await client.query(
      `INSERT INTO accounts (id, status, auth_version, version, created_at, updated_at)
       VALUES ($1, 'ACTIVE', 1, 1, clock_timestamp(), clock_timestamp())`,
      [accountId],
    );
    await client.query(
      `INSERT INTO student_profiles (
         id, status, nickname, avatar_preset_id, age_band, age_confirmation_source, age_confirmed_at,
         age_confirmed_by_account_id, stage_code, school_system_code, grade_code, grade_label, term_code,
         timezone, created_by_account_id, version, created_at, updated_at, grade_config_id
       ) VALUES (
         $1, 'ONBOARDING', '伪造更早created_at', 'avatar-03', 'UNDER_14', 'GUARDIAN_DECLARATION', clock_timestamp(),
         $2, 'primary', 'liusan', 'g3', '三年级', '2026-1', 'Asia/Shanghai', $2, 1, '2020-01-01 00:00:00+00', clock_timestamp(), NULL
       )`,
      [randomUUID(), accountId],
    );
  },
  'forged earlier created_at',
);

const dirtyUrl = rewriteDb(adminUrl, dirtyName);
await expectSixthBlocked(
  dirtyUrl,
  async (client) => {
    const accountId = randomUUID();
    const grade = await client.query(`
      SELECT g.id FROM grade_configs g
       WHERE g.school_system_code = 'SIX_THREE' AND g.stage_code = 'PRIMARY' AND g.grade_code = 'G3'
    `);
    await client.query(
      `INSERT INTO accounts (id, status, auth_version, version, created_at, updated_at)
       VALUES ($1, 'ACTIVE', 1, 1, clock_timestamp(), clock_timestamp())`,
      [accountId],
    );
    await client.query(
      `INSERT INTO student_profiles (
         id, status, nickname, avatar_preset_id, age_band, age_confirmation_source, age_confirmed_at,
         age_confirmed_by_account_id, grade_config_id, stage_code, school_system_code, grade_code, grade_label,
         term_code, timezone, created_by_account_id, version, created_at, updated_at
       ) VALUES (
         $1, 'ONBOARDING', '脏assigned', 'avatar-03', 'UNDER_14', 'GUARDIAN_DECLARATION', clock_timestamp(),
         $2, $3, 'PRIMARY', 'SIX_THREE', 'G3', '错误标签', 'FULL_YEAR', 'Asia/Shanghai', $2, 1, clock_timestamp(), clock_timestamp()
       )`,
      [randomUUID(), accountId, grade.rows[0].id],
    );
    const unpublishedId = randomUUID();
    const configId = randomUUID();
    await client.query(
      `INSERT INTO grade_configs (id, school_system_code, stage_code, grade_code, updated_at)
       VALUES ($1, 'CUSTOM', 'SENIOR', $2, clock_timestamp())`,
      [configId, `DIRTY_${unpublishedId.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO grade_config_versions (id, grade_config_id, version, grade_label, sort_order, allowed_term_codes)
       VALUES ($1, $2, 'v0', '未发布', 99, '["FULL_YEAR"]')`,
      [unpublishedId, configId],
    );
    await client.query(`UPDATE grade_configs SET current_version_id = $1 WHERE id = $2`, [unpublishedId, configId]);
  },
  'dirty assigned / unpublished current',
);

const drop = new pg.Client({ connectionString: postgresAdminUrl, connectionTimeoutMillis: 8000 });
await drop.connect();
for (const name of [forgedName, dirtyName]) {
  await drop.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  );
  await drop.query(`DROP DATABASE IF EXISTS ${name}`);
  process.stdout.write(`dropped this-round disposable ${name}\n`);
}
await drop.end();

if (existsSync(runtimeFile)) {
  let text = readFileSync(runtimeFile, 'utf8');
  if (text.includes('STP005_FOUR_TO_SIX_DATABASE_URL=')) {
    text = text.replace(/^STP005_FOUR_TO_SIX_DATABASE_URL=.*$/m, `STP005_FOUR_TO_SIX_DATABASE_URL=${fixtureUrl}`);
  } else {
    text += `STP005_FOUR_TO_SIX_DATABASE_URL=${fixtureUrl}\n`;
  }
  writeFileSync(runtimeFile, text);
  process.stdout.write('recorded STP005_FOUR_TO_SIX_DATABASE_URL to revised fixture; old fixture URL not reused.\n');
}

process.env.STP005_FOUR_TO_SIX_DATABASE_URL = fixtureUrl;
const githubEnv = process.env.GITHUB_ENV;
if (githubEnv) {
  appendFileSync(githubEnv, `STP005_FOUR_TO_SIX_DATABASE_URL=${fixtureUrl}\n`);
}

process.stdout.write(`revised four-to-six fixture ready: ${fixtureName}\n`);
process.exit(0);
