import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../apps/api/package.json'));
const pg = require('pg');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFile = join(root, '.local', 'stp004-pg', 'runtime.env');

const THROUGH_ELEVEN = [
  '20260914000000_stp004_identity_profiles_consents',
  '20260914170000_stp004_step_up_bound_session',
  '20260914233000_stp004_expand_lookup_replacement',
  '20260915160000_stp004_parent_keys_cycle_clock',
  '20260916120000_stp005_grade_catalog_templates',
  '20260916180000_stp005_legacy_fingerprint_and_version_fks',
  '20260917120000_stp006_study_plans_occurrences',
  '20260918090000_stp006_occurrence_version',
  '20260918120000_stp006_series_revisions',
  '20260918180000_stp006_split_parentage',
  '20260919120000_stp006_task_horizon_jobs',
];
const TWELFTH = '20260922120000_stp006_horizon_job_reason_null_safe';

export const FORBIDDEN = new Set([
  'stp004_identity',
  'stp004_identity_fresh',
  'stp005_four_to_six',
  'stp005_unknown_leftover',
  'stp005_rev_fresh',
  'stp005_rev_four_to_six',
  'stp006_six_to_seven',
  'stp006_seven_to_eight',
  'stp006_eight_to_nine',
  'stp006_nine_to_ten',
  'stp006_ten_to_eleven',
  'stp006_fresh',
]);
export const FIXTURE_DATABASE = 'stp006_eleven_to_twelve';
export const DIRTY_DATABASE = 'stp006_eleven_dirty';
const originalName = 'stp004_identity';

export function rewriteDb(url, name) {
  return url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
}

export function databaseName(url) {
  return new URL(url).pathname.replace(/^\//, '').split('?')[0];
}

export function assertAllowed(name) {
  if (FORBIDDEN.has(name) || !name.startsWith('stp006_')) {
    throw new Error(`refusing database ${name}`);
  }
}

export function recordElevenToTwelveFixtureUrl(fixtureUrl, env = process.env, io = { appendFileSync }) {
  const name = databaseName(fixtureUrl);
  assertAllowed(name);
  env.STP006_ELEVEN_TO_TWELVE_DATABASE_URL = fixtureUrl;
  if (env.GITHUB_ENV) {
    io.appendFileSync(env.GITHUB_ENV, `STP006_ELEVEN_TO_TWELVE_DATABASE_URL=${fixtureUrl}\n`);
  }
}

export function recordElevenDirtyFixtureUrl(fixtureUrl, env = process.env, io = { appendFileSync }) {
  const name = databaseName(fixtureUrl);
  assertAllowed(name);
  env.STP006_ELEVEN_DIRTY_DATABASE_URL = fixtureUrl;
  if (env.GITHUB_ENV) {
    io.appendFileSync(env.GITHUB_ENV, `STP006_ELEVEN_DIRTY_DATABASE_URL=${fixtureUrl}\n`);
  }
}

function loadRuntimeEnv(env = process.env) {
  if (!existsSync(runtimeFile)) return;
  for (const line of readFileSync(runtimeFile, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    if (!env[key]) env[key] = line.slice(index + 1);
  }
}

function sameEndpoint(left, right) {
  const a = new URL(left);
  const b = new URL(right);
  return a.hostname === b.hostname && (a.port || '5432') === (b.port || '5432');
}

export function shouldRequireLocalOriginalIdentity(env = process.env) {
  if (env.CI === 'true' || env.CI === '1') return false;
  if (env.STP004_CI_PREPARED === '1' || env.STP004_CI_PREPARE === '1') return false;
  return true;
}

export function shouldWriteLocalRuntime(localAdminUrl, fixtureUrl) {
  return Boolean(localAdminUrl) && sameEndpoint(localAdminUrl, fixtureUrl);
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
  process.stdout.write(`applied SQL ${folder}\n`);
}

async function currentDb(client) {
  const row = await client.query('SELECT current_database() AS name');
  const name = row.rows[0].name;
  if (FORBIDDEN.has(name) || name === originalName) {
    throw new Error(`query executed on forbidden database ${name}`);
  }
  return name;
}

function digestRows(rows) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function recreateDatabase(adminUrl, name) {
  assertAllowed(name);
  const postgresAdminUrl = rewriteDb(adminUrl, 'postgres');
  const admin = new pg.Client({ connectionString: postgresAdminUrl, connectionTimeoutMillis: 8000 });
  await admin.connect();
  if (shouldRequireLocalOriginalIdentity()) {
    const originalOpen = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [originalName]);
    if (originalOpen.rowCount !== 1) {
      await admin.end();
      throw new Error('original stp004_identity missing; leave it read-only');
    }
  }
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return rewriteDb(adminUrl, name);
}

async function applyThroughEleven(url, name) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000 });
  await client.connect();
  if ((await currentDb(client)) !== name) {
    await client.end();
    throw new Error(`fixture landed on the wrong database ${name}`);
  }
  for (const folder of THROUGH_ELEVEN) {
    await applySql(client, folder);
  }
  return client;
}

async function seedLegalJobs(client) {
  const accountId = randomUUID();
  const studentId = randomUUID();
  const planActive = randomUUID();
  const planPaused = randomUUID();
  const planArchived = randomUUID();
  await client.query(
    `INSERT INTO accounts (id, status, auth_version, version, created_at, updated_at)
     VALUES ($1, 'ACTIVE', 1, 1, clock_timestamp(), clock_timestamp())`,
    [accountId],
  );
  await client.query(
    `INSERT INTO student_profiles (
       id, status, nickname, avatar_preset_id, age_band, age_confirmation_source, age_confirmed_at,
       age_confirmed_by_account_id, timezone, created_by_account_id, version, created_at, updated_at
     ) VALUES (
       $1, 'ONBOARDING', '十一到十二基线', 'avatar-03', 'UNDER_14', 'GUARDIAN_DECLARATION', clock_timestamp(),
       $2, 'Asia/Shanghai', $2, 1, clock_timestamp(), clock_timestamp()
     )`,
    [studentId, accountId],
  );
  for (const [id, status] of [
    [planActive, 'ACTIVE'],
    [planPaused, 'PAUSED'],
    [planArchived, 'ARCHIVED'],
  ]) {
    await client.query(
      `INSERT INTO study_plans (id, student_profile_id, status, origin, imported_content_json, timezone_snapshot, version, created_at, updated_at)
       VALUES ($1, $2, $3, 'STUDENT', '[]', 'Asia/Shanghai', 1, clock_timestamp(), clock_timestamp())`,
      [id, studentId, status],
    );
  }
  return { studentId, planActive, planPaused, planArchived };
}

async function resolveApplied(url, folders) {
  for (const folder of folders) {
    if (prisma(['migrate', 'resolve', '--applied', folder], url) !== 0) {
      throw new Error(`migrate resolve failed for ${folder}`);
    }
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(entry).toLowerCase();
}

if (isDirectRun()) {
  loadRuntimeEnv();
  const adminUrl = process.env.STP004_ADMIN_DATABASE_URL;
  const apiUrl = process.env.STP004_TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!adminUrl || !apiUrl) {
    throw new Error('admin or api database URL missing');
  }

  const legalUrl = await recreateDatabase(adminUrl, FIXTURE_DATABASE);
  const legal = await applyThroughEleven(legalUrl, FIXTURE_DATABASE);
  const ids = await seedLegalJobs(legal);
  const beforePlans = await legal.query(`SELECT id, status, version FROM study_plans ORDER BY id`);
  const beforeJobs = await legal.query(
    `SELECT plan_id, state, state_reason FROM task_horizon_jobs ORDER BY plan_id`,
  );
  const beforeDigest = digestRows({ plans: beforePlans.rows, jobs: beforeJobs.rows });
  await applySql(legal, TWELFTH);
  await legal.end();
  await resolveApplied(legalUrl, [...THROUGH_ELEVEN, TWELFTH]);

  const after = new pg.Client({ connectionString: legalUrl, connectionTimeoutMillis: 8000 });
  await after.connect();
  if ((await currentDb(after)) !== FIXTURE_DATABASE) {
    throw new Error('legal fixture switched database');
  }
  const applied = await after.query(`
    SELECT COUNT(*)::int AS n FROM _prisma_migrations
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  `);
  if (applied.rows[0].n !== 12) {
    throw new Error(`expected 12 applied migrations, found ${applied.rows[0].n}`);
  }
  const afterPlans = await after.query(`SELECT id, status, version FROM study_plans ORDER BY id`);
  const afterJobs = await after.query(
    `SELECT plan_id, state, state_reason FROM task_horizon_jobs ORDER BY plan_id`,
  );
  if (digestRows({ plans: afterPlans.rows, jobs: afterJobs.rows }) !== beforeDigest) {
    throw new Error('eleven-to-twelve changed existing business digest');
  }
  const nickname = await after.query(`SELECT nickname FROM student_profiles WHERE id = $1`, [ids.studentId]);
  if (nickname.rows[0]?.nickname !== '十一到十二基线') {
    throw new Error('legal fixture lost baseline student');
  }

  async function expectReject(label, work) {
    let blocked = false;
    try {
      await work();
    } catch {
      blocked = true;
    }
    if (!blocked) {
      throw new Error(`${label} was not rejected`);
    }
  }

  await expectReject('BLOCKED null reason', () =>
    after.query(
      `UPDATE task_horizon_jobs
          SET state = 'BLOCKED', state_reason = NULL, available_at = clock_timestamp()
        WHERE plan_id = $1`,
      [ids.planActive],
    ),
  );
  await expectReject('FAILED null reason', () =>
    after.query(
      `UPDATE task_horizon_jobs
          SET state = 'FAILED', state_reason = NULL, available_at = NULL
        WHERE plan_id = $1`,
      [ids.planActive],
    ),
  );
  await expectReject('RETIRED null reason', () =>
    after.query(
      `UPDATE task_horizon_jobs
          SET state = 'RETIRED', state_reason = NULL, available_at = NULL
        WHERE plan_id = $1`,
      [ids.planActive],
    ),
  );
  await after.query(
    `UPDATE task_horizon_jobs
        SET state = 'FAILED',
            state_reason = 'RETRY_EXHAUSTED',
            available_at = NULL
      WHERE plan_id = $1`,
    [ids.planActive],
  );
  await after.query(
    `UPDATE task_horizon_jobs
        SET state = 'READY',
            state_reason = NULL,
            available_at = clock_timestamp()
      WHERE plan_id = $1`,
    [ids.planActive],
  );
  await after.end();

  const dirtyUrl = await recreateDatabase(adminUrl, DIRTY_DATABASE);
  const dirty = await applyThroughEleven(dirtyUrl, DIRTY_DATABASE);
  const dirtyIds = await seedLegalJobs(dirty);
  await dirty.end();
  await resolveApplied(dirtyUrl, THROUGH_ELEVEN);
  const dirtyAfterEleven = new pg.Client({ connectionString: dirtyUrl, connectionTimeoutMillis: 8000 });
  await dirtyAfterEleven.connect();
  if ((await currentDb(dirtyAfterEleven)) !== DIRTY_DATABASE) {
    throw new Error('dirty fixture switched database');
  }
  await dirtyAfterEleven.query(
    `UPDATE task_horizon_jobs
        SET state = 'BLOCKED', state_reason = NULL, available_at = clock_timestamp()
      WHERE plan_id = $1`,
    [dirtyIds.planActive],
  );
  await dirtyAfterEleven.query(
    `UPDATE task_horizon_jobs
        SET state = 'FAILED', state_reason = NULL, available_at = NULL
      WHERE plan_id = $1`,
    [dirtyIds.planPaused],
  );
  await dirtyAfterEleven.query(
    `UPDATE task_horizon_jobs
        SET state = 'RETIRED', state_reason = NULL, available_at = NULL
      WHERE plan_id = $1`,
    [dirtyIds.planArchived],
  );
  let dirtyBlocked = false;
  try {
    await applySql(dirtyAfterEleven, TWELFTH);
  } catch (error) {
    dirtyBlocked = /NULL state_reason|stp006 twelfth/i.test(String(error?.message ?? error));
    if (!dirtyBlocked) {
      await dirtyAfterEleven.end();
      throw error;
    }
  }
  if (!dirtyBlocked) {
    await dirtyAfterEleven.end();
    throw new Error('dirty eleventh baseline was not rejected by twelfth precheck');
  }
  const dirtyCount = await dirtyAfterEleven.query(`
    SELECT COUNT(*)::int AS n FROM _prisma_migrations
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  `);
  const twelfthName = await dirtyAfterEleven.query(
    `SELECT migration_name FROM _prisma_migrations WHERE migration_name = $1`,
    [TWELFTH],
  );
  const dirtyNulls = await dirtyAfterEleven.query(`
    SELECT COUNT(*)::int AS n FROM task_horizon_jobs
     WHERE state IN ('BLOCKED', 'FAILED', 'RETIRED') AND state_reason IS NULL
  `);
  await dirtyAfterEleven.end();
  if (dirtyCount.rows[0].n !== 11) {
    throw new Error(`dirty fixture must stay at eleven migrations, found ${dirtyCount.rows[0].n}`);
  }
  if (twelfthName.rowCount !== 0) {
    throw new Error('dirty fixture must not apply the twelfth migration');
  }
  if (dirtyNulls.rows[0].n !== 3) {
    throw new Error(`dirty fixture must keep three NULL reasons, found ${dirtyNulls.rows[0].n}`);
  }

  recordElevenToTwelveFixtureUrl(legalUrl, process.env);
  recordElevenDirtyFixtureUrl(dirtyUrl, process.env);
  if (existsSync(runtimeFile) && shouldWriteLocalRuntime(process.env.STP004_ADMIN_DATABASE_URL, legalUrl)) {
    let text = readFileSync(runtimeFile, 'utf8');
    const setLine = (key, value) => {
      if (new RegExp(`^${key}=`, 'm').test(text)) {
        text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
      } else {
        text += `${key}=${value}\n`;
      }
    };
    setLine('STP006_ELEVEN_TO_TWELVE_DATABASE_URL', legalUrl);
    setLine('STP006_ELEVEN_DIRTY_DATABASE_URL', dirtyUrl);
    writeFileSync(runtimeFile, text);
  }
  process.stdout.write('eleven→twelve fixture ready; dirty eleventh baseline blocked.\n');
}
