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

const EIGHT = [
  '20260914000000_stp004_identity_profiles_consents',
  '20260914170000_stp004_step_up_bound_session',
  '20260914233000_stp004_expand_lookup_replacement',
  '20260915160000_stp004_parent_keys_cycle_clock',
  '20260916120000_stp005_grade_catalog_templates',
  '20260916180000_stp005_legacy_fingerprint_and_version_fks',
  '20260917120000_stp006_study_plans_occurrences',
  '20260918090000_stp006_occurrence_version',
];
const NINTH = '20260918120000_stp006_series_revisions';
export const FORBIDDEN = new Set([
  'stp004_identity',
  'stp004_identity_fresh',
  'stp005_four_to_six',
  'stp005_unknown_leftover',
  'stp005_rev_fresh',
  'stp005_rev_four_to_six',
  'stp006_six_to_seven',
  'stp006_seven_to_eight',
  'stp006_fresh',
  'stp006_nine_to_ten',
  'stp006_ten_to_eleven',
]);
export const FIXTURE_DATABASE = 'stp006_eight_to_nine';
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

export function recordEightToNineFixtureUrl(fixtureUrl, env = process.env, io = { appendFileSync }) {
  const name = databaseName(fixtureUrl);
  assertAllowed(name);
  env.STP006_EIGHT_TO_NINE_DATABASE_URL = fixtureUrl;
  if (env.GITHUB_ENV) {
    io.appendFileSync(env.GITHUB_ENV, `STP006_EIGHT_TO_NINE_DATABASE_URL=${fixtureUrl}\n`);
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

function digestRows(rows) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
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
  for (const folder of EIGHT) {
    await applySql(fixture, folder);
  }

  const accountId = randomUUID();
  const studentId = randomUUID();
  const planId = randomUUID();
  const seriesId = randomUUID();
  const otherSeriesId = randomUUID();
  const occIds = {
    past: randomUUID(),
    planned: randomUUID(),
    edited: randomUUID(),
    reverted: randomUUID(),
    moved: randomUUID(),
    cancelled: randomUUID(),
    other: randomUUID(),
  };
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
       $1, 'ONBOARDING', '八到九基线', 'avatar-03', 'UNDER_14', 'GUARDIAN_DECLARATION', clock_timestamp(),
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
     ) VALUES ($1, $2, '修订基线', '语文', '读完一页', 'DAILY', '2026-09-10', NULL, true, '2026-09-10', 1, clock_timestamp(), clock_timestamp())`,
    [seriesId, planId],
  );
  await fixture.query(
    `INSERT INTO task_series (
       id, plan_id, name, subject, completion_standard, repeat_kind, start_local_date, end_local_date, ongoing,
       effective_from_local_date, effective_to_local_date, version, created_at, updated_at
     ) VALUES ($1, $2, '另一规则', '数学', '完成', 'ONCE', '2026-09-18', '2026-09-18', false, '2026-09-18', '2026-09-18', 1, clock_timestamp(), clock_timestamp())`,
    [otherSeriesId, planId],
  );

  async function insertOcc(id, series, key, scheduled, status, name, extra = '') {
    await fixture.query(
      `INSERT INTO task_occurrences (
        id, series_id, occurrence_key, original_local_date, scheduled_local_date, timezone_snapshot, status,
        name_snapshot, subject_snapshot, completion_standard_snapshot, steps_snapshot_json, version,
        grade_config_id, grade_config_version_id, stage_code_snapshot, school_system_code_snapshot,
        grade_code_snapshot, grade_label_snapshot, term_code_snapshot, catalog_entry_key_snapshot, created_at, updated_at
      ) SELECT $1, $2, $3, $3, $4, 'Asia/Shanghai', $5,
               $6, s.subject, s.completion_standard, COALESCE(s.steps_json, '[]'), 1,
               g.id, g.current_version_id, 'PRIMARY', 'SIX_THREE', 'G1', '一年级', 'FULL_YEAR', 'PRIMARY_G1',
               clock_timestamp(), clock_timestamp()
          FROM task_series s
          JOIN grade_configs g ON g.grade_code = 'G1' AND g.stage_code = 'PRIMARY' AND g.school_system_code = 'SIX_THREE'
          JOIN grade_config_versions v ON v.grade_config_id = g.id AND v.id = g.current_version_id
         WHERE s.id = $2
         LIMIT 1`,
      [id, series, key, scheduled, status, name],
    );
    if (extra) {
      await fixture.query(extra, [id]);
    }
  }

  await insertOcc(occIds.past, seriesId, '2026-09-10', '2026-09-10', 'COMPLETED', '修订基线');
  await insertOcc(occIds.planned, seriesId, '2026-09-18', '2026-09-18', 'PLANNED', '修订基线');
  await insertOcc(occIds.edited, seriesId, '2026-09-19', '2026-09-19', 'PLANNED', '单次改过');
  await insertOcc(occIds.reverted, seriesId, '2026-09-20', '2026-09-20', 'PLANNED', '修订基线');
  await insertOcc(occIds.moved, seriesId, '2026-09-21', '2026-10-01', 'PLANNED', '修订基线');
  await insertOcc(
    occIds.cancelled,
    seriesId,
    '2026-09-22',
    '2026-09-22',
    'CANCELLED',
    '修订基线',
    `UPDATE task_occurrences SET cancel_reason = 'USER_CANCELLED' WHERE id = $1`,
  );
  await insertOcc(occIds.other, otherSeriesId, '2026-09-18', '2026-09-18', 'PLANNED', '另一规则');

  const editAdj = randomUUID();
  const revertFirst = randomUUID();
  const revertSecond = randomUUID();
  const moveAdj = randomUUID();
  await fixture.query(
    `INSERT INTO plan_adjustments (id, plan_id, series_id, occurrence_id, reason_code, payload_json, created_at)
     VALUES ($1, $2, $3, $4, 'TASK_CONTENT_EDITED', $5, clock_timestamp())`,
    [
      editAdj,
      planId,
      seriesId,
      occIds.edited,
      JSON.stringify({
        fields: [{ field: 'name', from: '修订基线', to: '单次改过' }],
        actorScope: 'GUARDIAN',
      }),
    ],
  );
  await fixture.query(
    `INSERT INTO plan_adjustments (id, plan_id, series_id, occurrence_id, reason_code, payload_json, created_at)
     VALUES ($1, $2, $3, $4, 'TASK_CONTENT_EDITED', $5, clock_timestamp())`,
    [
      revertFirst,
      planId,
      seriesId,
      occIds.reverted,
      JSON.stringify({
        fields: [{ field: 'name', from: '修订基线', to: '临时改名' }],
        actorScope: 'GUARDIAN',
      }),
    ],
  );
  await fixture.query(
    `INSERT INTO plan_adjustments (id, plan_id, series_id, occurrence_id, reason_code, payload_json, created_at)
     VALUES ($1, $2, $3, $4, 'TASK_CONTENT_EDITED', $5, clock_timestamp())`,
    [
      revertSecond,
      planId,
      seriesId,
      occIds.reverted,
      JSON.stringify({
        fields: [{ field: 'name', from: '临时改名', to: '修订基线' }],
        actorScope: 'GUARDIAN',
      }),
    ],
  );
  await fixture.query(
    `INSERT INTO plan_adjustments (id, plan_id, series_id, occurrence_id, reason_code, payload_json, created_at)
     VALUES ($1, $2, $3, $4, 'TASK_RESCHEDULED', $5, clock_timestamp())`,
    [
      moveAdj,
      planId,
      seriesId,
      occIds.moved,
      JSON.stringify({
        fromScheduledLocalDate: '2026-09-21',
        toScheduledLocalDate: '2026-10-01',
        occurrenceKey: '2026-09-21',
        originalLocalDate: '2026-09-21',
        reason: '改期',
      }),
    ],
  );

  const beforeOcc = await fixture.query(
    `SELECT id, series_id, occurrence_key, original_local_date, scheduled_local_date, status, cancel_reason,
            name_snapshot, subject_snapshot, completion_standard_snapshot, duration_minutes_snapshot,
            steps_snapshot_json, version, grade_label_snapshot
       FROM task_occurrences ORDER BY id`,
  );
  const beforeAdj = await fixture.query(
    `SELECT id, plan_id, series_id, occurrence_id, reason_code, payload_json FROM plan_adjustments ORDER BY id`,
  );
  const beforeDigest = digestRows({ occ: beforeOcc.rows, adj: beforeAdj.rows });
  await fixture.end();

  for (const folder of EIGHT) {
    if (prisma(['migrate', 'resolve', '--applied', folder], fixtureUrl) !== 0) process.exit(1);
  }
  // Tenth+ must not ride along. migrate deploy would apply every pending folder.
  const afterEight = new pg.Client({ connectionString: fixtureUrl, connectionTimeoutMillis: 8000 });
  await afterEight.connect();
  await applySql(afterEight, NINTH);
  await afterEight.end();
  if (prisma(['migrate', 'resolve', '--applied', NINTH], fixtureUrl) !== 0) process.exit(1);

  const after = new pg.Client({ connectionString: fixtureUrl, connectionTimeoutMillis: 8000 });
  await after.connect();
  const applied = await after.query(`
    SELECT COUNT(*)::int AS n
      FROM _prisma_migrations
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  `);
  if (applied.rows[0].n !== 9) {
    throw new Error(`expected 9 applied migrations, found ${applied.rows[0].n}`);
  }
  const ninth = await after.query(`SELECT migration_name FROM _prisma_migrations WHERE migration_name = $1`, [NINTH]);
  if (ninth.rowCount !== 1) {
    throw new Error('ninth migration was not recorded as applied');
  }
  const kept = await after.query(`SELECT nickname FROM student_profiles WHERE id = $1`, [studentId]);
  if (kept.rows[0]?.nickname !== '八到九基线') {
    throw new Error('baseline student was not preserved');
  }
  const afterOcc = await after.query(
    `SELECT id, series_id, occurrence_key, original_local_date, scheduled_local_date, status, cancel_reason,
            name_snapshot, subject_snapshot, completion_standard_snapshot, duration_minutes_snapshot,
            steps_snapshot_json, version, grade_label_snapshot
       FROM task_occurrences ORDER BY id`,
  );
  const afterAdj = await after.query(
    `SELECT id, plan_id, series_id, occurrence_id, reason_code, payload_json FROM plan_adjustments ORDER BY id`,
  );
  if (digestRows({ occ: afterOcc.rows, adj: afterAdj.rows }) !== beforeDigest) {
    throw new Error('eight-to-nine changed business occurrence/audit digest');
  }
  const edited = await after.query(
    `SELECT content_exception_adjustment_id, schedule_exception_adjustment_id, content_revision_no
       FROM task_occurrences WHERE id = $1`,
    [occIds.edited],
  );
  if (edited.rows[0]?.content_exception_adjustment_id !== editAdj || edited.rows[0]?.content_revision_no !== 1) {
    throw new Error('content exception pointer was not backfilled from audit');
  }
  const reverted = await after.query(
    `SELECT name_snapshot, content_exception_adjustment_id FROM task_occurrences WHERE id = $1`,
    [occIds.reverted],
  );
  if (reverted.rows[0]?.name_snapshot !== '修订基线' || reverted.rows[0]?.content_exception_adjustment_id !== revertFirst) {
    throw new Error('reverted content must remain an exception');
  }
  const moved = await after.query(
    `SELECT scheduled_local_date, schedule_exception_adjustment_id FROM task_occurrences WHERE id = $1`,
    [occIds.moved],
  );
  if (moved.rows[0]?.scheduled_local_date !== '2026-10-01' || moved.rows[0]?.schedule_exception_adjustment_id !== moveAdj) {
    throw new Error('reschedule exception pointer missing');
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

  await expectReject('legacy series update', () =>
    after.query(`UPDATE task_series SET name = '不该改' WHERE id = $1`, [seriesId]),
  );
  await expectReject('revision update', () =>
    after.query(`UPDATE task_series_revisions SET name = '不该改' WHERE task_series_id = $1 AND revision_no = 1`, [seriesId]),
  );
  await expectReject('adjustment delete', () =>
    after.query(`DELETE FROM plan_adjustments WHERE id = $1`, [editAdj]),
  );
  await expectReject('same-series date clash', () =>
    after.query(
      `INSERT INTO task_occurrences (
        id, series_id, occurrence_key, original_local_date, scheduled_local_date, timezone_snapshot, status,
        name_snapshot, subject_snapshot, completion_standard_snapshot, steps_snapshot_json,
        grade_config_id, grade_config_version_id, stage_code_snapshot, school_system_code_snapshot,
        grade_code_snapshot, grade_label_snapshot, term_code_snapshot, catalog_entry_key_snapshot
      ) SELECT gen_random_uuid(), $1, '2026-09-28', '2026-09-28', '2026-09-18', timezone_snapshot, 'PLANNED',
               name_snapshot, subject_snapshot, completion_standard_snapshot, steps_snapshot_json,
               grade_config_id, grade_config_version_id, stage_code_snapshot, school_system_code_snapshot,
               grade_code_snapshot, grade_label_snapshot, term_code_snapshot, catalog_entry_key_snapshot
          FROM task_occurrences WHERE id = $2`,
      [seriesId, occIds.planned],
    ),
  );
  const otherSameDay = await after.query(`SELECT scheduled_local_date FROM task_occurrences WHERE id = $1`, [occIds.other]);
  if (otherSameDay.rows[0]?.scheduled_local_date !== '2026-09-18') {
    throw new Error('cross-series same-day row was not preserved');
  }
  await after.end();

  recordEightToNineFixtureUrl(fixtureUrl, process.env);
  if (existsSync(runtimeFile) && shouldWriteLocalRuntime(process.env.STP004_ADMIN_DATABASE_URL, fixtureUrl)) {
    let text = readFileSync(runtimeFile, 'utf8');
    if (/^STP006_EIGHT_TO_NINE_DATABASE_URL=/m.test(text)) {
      text = text.replace(/^STP006_EIGHT_TO_NINE_DATABASE_URL=.*$/m, `STP006_EIGHT_TO_NINE_DATABASE_URL=${fixtureUrl}`);
    } else {
      text += `STP006_EIGHT_TO_NINE_DATABASE_URL=${fixtureUrl}\n`;
    }
    writeFileSync(runtimeFile, text);
  }
  process.stdout.write(`eight→nine fixture ready: ${fixtureName}; revisions and exception pointers kept.\n`);
}
