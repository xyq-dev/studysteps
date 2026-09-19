import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../apps/api/package.json'));
const pg = require('pg');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFile = join(root, '.local', 'stp004-pg', 'runtime.env');

const SEVEN = [
  '20260914000000_stp004_identity_profiles_consents',
  '20260914170000_stp004_step_up_bound_session',
  '20260914233000_stp004_expand_lookup_replacement',
  '20260915160000_stp004_parent_keys_cycle_clock',
  '20260916120000_stp005_grade_catalog_templates',
  '20260916180000_stp005_legacy_fingerprint_and_version_fks',
  '20260917120000_stp006_study_plans_occurrences',
];
const EIGHTH = '20260918090000_stp006_occurrence_version';
export const FORBIDDEN = new Set([
  'stp004_identity',
  'stp004_identity_fresh',
  'stp005_four_to_six',
  'stp005_unknown_leftover',
  'stp005_rev_fresh',
  'stp005_rev_four_to_six',
  'stp006_six_to_seven',
  'stp006_fresh',
  'stp006_eight_to_nine',
  'stp006_nine_to_ten',
  'stp006_ten_to_eleven',
]);
export const FIXTURE_DATABASE = 'stp006_seven_to_eight';
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

export function recordSevenToEightFixtureUrl(fixtureUrl, env = process.env, io = { appendFileSync }) {
  const name = databaseName(fixtureUrl);
  assertAllowed(name);
  env.STP006_SEVEN_TO_EIGHT_DATABASE_URL = fixtureUrl;
  if (env.GITHUB_ENV) {
    io.appendFileSync(env.GITHUB_ENV, `STP006_SEVEN_TO_EIGHT_DATABASE_URL=${fixtureUrl}\n`);
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
  if (FORBIDDEN.has(name)) {
    throw new Error(`query executed on forbidden database ${name}`);
  }
  return name;
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
  const fixtureName = FIXTURE_DATABASE;
  assertAllowed(fixtureName);
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
    [fixtureName],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${fixtureName}`);
  await admin.query(`CREATE DATABASE ${fixtureName}`);
  await admin.end();
  const fixtureUrl = rewriteDb(adminUrl, fixtureName);
  const fixture = new pg.Client({ connectionString: fixtureUrl, connectionTimeoutMillis: 8000 });
  await fixture.connect();
  if ((await currentDb(fixture)) !== fixtureName) {
    throw new Error('fixture landed on the wrong database');
  }
  for (const folder of SEVEN) {
    await applySql(fixture, folder);
  }
  const accountId = randomUUID();
  const studentId = randomUUID();
  const planId = randomUUID();
  const seriesId = randomUUID();
  const occurrenceId = randomUUID();
  await fixture.query(
    `INSERT INTO accounts (id, status, auth_version, version, created_at, updated_at)
     VALUES ($1, 'ACTIVE', 1, 1, clock_timestamp(), clock_timestamp())`,
    [accountId],
  );
  await fixture.query(
    `INSERT INTO student_profiles (
       id, status, nickname, avatar_preset_id, age_band, age_confirmation_source, age_confirmed_at,
       age_confirmed_by_account_id, timezone, created_by_account_id, version, created_at, updated_at
     ) VALUES (
       $1, 'ONBOARDING', '七到八基线', 'avatar-03', 'UNDER_14', 'GUARDIAN_DECLARATION', clock_timestamp(),
       $2, 'Asia/Shanghai', $2, 1, clock_timestamp(), clock_timestamp()
     )`,
    [studentId, accountId],
  );
  await fixture.query(
    `INSERT INTO study_plans (
       id, student_profile_id, status, origin, imported_content_json, timezone_snapshot, version, created_at, updated_at
     ) VALUES ($1, $2, 'ACTIVE', 'STUDENT', '[]', 'Asia/Shanghai', 1, clock_timestamp(), clock_timestamp())`,
    [planId, studentId],
  );
  await fixture.query(
    `INSERT INTO task_series (
       id, plan_id, name, subject, completion_standard, repeat_kind, start_local_date, end_local_date, ongoing,
       effective_from_local_date, version, created_at, updated_at
     ) VALUES ($1, $2, '改期基线', '自定义', '完成', 'ONCE', '2026-09-17', '2026-09-17', false, '2026-09-17', 1, clock_timestamp(), clock_timestamp())`,
    [seriesId, planId],
  );
  const beforeVersion = await fixture.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'task_occurrences' AND column_name = 'version'`,
  );
  if (beforeVersion.rowCount !== 0) {
    throw new Error('seventh-state fixture already has occurrence version');
  }
  await fixture.query(
    `INSERT INTO task_occurrences (
      id, series_id, occurrence_key, original_local_date, scheduled_local_date, timezone_snapshot, status,
      name_snapshot, subject_snapshot, completion_standard_snapshot, steps_snapshot_json,
      grade_config_id, grade_config_version_id, stage_code_snapshot, school_system_code_snapshot,
      grade_code_snapshot, grade_label_snapshot, term_code_snapshot, catalog_entry_key_snapshot, created_at, updated_at
    ) SELECT $1, $2, '2026-09-17', '2026-09-17', '2026-09-17', 'Asia/Shanghai', 'PLANNED',
             '改期基线', '自定义', '完成', '[]', g.id, g.current_version_id, 'PRIMARY', 'SIX_THREE', 'G1', '一年级', 'FULL_YEAR', 'PRIMARY_G1',
             clock_timestamp(), clock_timestamp()
        FROM grade_configs g
        JOIN grade_config_versions v ON v.grade_config_id = g.id AND v.id = g.current_version_id
       WHERE g.grade_code = 'G1' AND g.stage_code = 'PRIMARY' AND g.school_system_code = 'SIX_THREE'
       LIMIT 1`,
    [occurrenceId, seriesId],
  );
  const beforeCount = await fixture.query(`SELECT COUNT(*)::int AS n FROM task_occurrences`);
  await fixture.end();
  for (const folder of SEVEN) {
    if (prisma(['migrate', 'resolve', '--applied', folder], fixtureUrl) !== 0) process.exit(1);
  }
  // Ninth+ must not ride along. migrate deploy would apply every pending folder.
  const afterSeven = new pg.Client({ connectionString: fixtureUrl, connectionTimeoutMillis: 8000 });
  await afterSeven.connect();
  await applySql(afterSeven, EIGHTH);
  await afterSeven.end();
  if (prisma(['migrate', 'resolve', '--applied', EIGHTH], fixtureUrl) !== 0) process.exit(1);

  const after = new pg.Client({ connectionString: fixtureUrl, connectionTimeoutMillis: 8000 });
  await after.connect();
  const applied = await after.query(`
    SELECT COUNT(*)::int AS n
      FROM _prisma_migrations
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  `);
  if (applied.rows[0].n !== 8) {
    throw new Error(`expected 8 applied migrations, found ${applied.rows[0].n}`);
  }
  const eighth = await after.query(
    `SELECT migration_name FROM _prisma_migrations WHERE migration_name = $1`,
    [EIGHTH],
  );
  if (eighth.rowCount !== 1) {
    throw new Error('eighth migration was not recorded as applied');
  }
  const revisions = await after.query(`SELECT to_regclass('task_series_revisions') AS revisions`);
  if (revisions.rows[0]?.revisions) {
    throw new Error('seven-to-eight fixture must not receive revision tables');
  }
  const kept = await after.query(`SELECT nickname FROM student_profiles WHERE id = $1`, [studentId]);
  if (kept.rows[0]?.nickname !== '七到八基线') {
    throw new Error('baseline student was not preserved');
  }
  const versioned = await after.query(`SELECT version, occurrence_key FROM task_occurrences WHERE id = $1`, [
    occurrenceId,
  ]);
  if (versioned.rows[0]?.version !== 1 || versioned.rows[0]?.occurrence_key !== '2026-09-17') {
    throw new Error('existing occurrence did not receive version=1');
  }
  const afterCount = await after.query(`SELECT COUNT(*)::int AS n FROM task_occurrences`);
  if (afterCount.rows[0].n !== beforeCount.rows[0].n) {
    throw new Error('seven-to-eight changed occurrence counts');
  }
  let duplicateBlocked = false;
  try {
    await after.query(
      `INSERT INTO task_occurrences (
        id, series_id, occurrence_key, original_local_date, scheduled_local_date, timezone_snapshot, status,
        name_snapshot, subject_snapshot, completion_standard_snapshot, steps_snapshot_json,
        grade_config_id, grade_config_version_id, stage_code_snapshot, school_system_code_snapshot,
        grade_code_snapshot, grade_label_snapshot, term_code_snapshot, catalog_entry_key_snapshot, created_at, updated_at
      ) SELECT gen_random_uuid(), $1, '2026-09-17', '2026-09-17', '2026-09-18', 'Asia/Shanghai', 'PLANNED',
               '改期基线', '自定义', '完成', '[]', grade_config_id, grade_config_version_id, stage_code_snapshot, school_system_code_snapshot,
               grade_code_snapshot, grade_label_snapshot, term_code_snapshot, catalog_entry_key_snapshot, clock_timestamp(), clock_timestamp()
          FROM task_occurrences WHERE id = $2`,
      [seriesId, occurrenceId],
    );
  } catch (error) {
    duplicateBlocked = /unique|duplicate/i.test(String(error.message));
  }
  if (!duplicateBlocked) {
    throw new Error('duplicate occurrence_key was not rejected after eight');
  }
  await after.end();

  recordSevenToEightFixtureUrl(fixtureUrl, process.env);
  if (existsSync(runtimeFile) && shouldWriteLocalRuntime(process.env.STP004_ADMIN_DATABASE_URL, fixtureUrl)) {
    let text = readFileSync(runtimeFile, 'utf8');
    if (/^STP006_SEVEN_TO_EIGHT_DATABASE_URL=/m.test(text)) {
      text = text.replace(/^STP006_SEVEN_TO_EIGHT_DATABASE_URL=.*$/m, `STP006_SEVEN_TO_EIGHT_DATABASE_URL=${fixtureUrl}`);
    } else {
      text += `STP006_SEVEN_TO_EIGHT_DATABASE_URL=${fixtureUrl}\n`;
    }
    writeFileSync(runtimeFile, text);
  }
  process.stdout.write(`seven→eight fixture ready: ${fixtureName}; version defaulted; unique key kept.\n`);
}
