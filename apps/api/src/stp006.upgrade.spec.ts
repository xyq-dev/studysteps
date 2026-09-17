import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  assertDisposableIsolationTarget,
  assertStp004IntegrationReady,
  loadStp004Env,
  shouldSkipStp004Isolation,
} from './test/load-stp004-env';

describe.skipIf(shouldSkipStp004Isolation())('STP 006 six-to-seven leftover upgrade fixture', () => {
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    loadStp004Env();
    assertStp004IntegrationReady();
    const url = process.env.STP006_SIX_TO_SEVEN_DATABASE_URL;
    if (!url) {
      throw new Error('STP006_SIX_TO_SEVEN_DATABASE_URL is required; run scripts/stp006-six-to-seven.mjs');
    }
    assertDisposableIsolationTarget(url);
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    const db = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
    expect(db[0]?.current_database).toBe('stp006_six_to_seven');
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('keeps the six-baseline student and catalog after the seventh migration', async () => {
    const applied = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    expect(applied[0]?.n).toBe(7);
    const kept = await prisma!.$queryRaw<Array<{ nickname: string }>>`
      SELECT nickname FROM student_profiles WHERE nickname = '六到七基线'
    `;
    expect(kept).toHaveLength(1);
    const plans = await prisma!.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM study_plans`;
    expect(plans[0]?.n).toBeGreaterThanOrEqual(1);
    const grades = await prisma!.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM grade_configs`;
    const templates = await prisma!.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM plan_template_versions`;
    expect(grades[0]?.n).toBeGreaterThan(0);
    expect(templates[0]?.n).toBe(39);
  });

  it('enforces occurrence uniqueness on the upgraded fixture', async () => {
    const series = await prisma!.$queryRaw<Array<{ id: string }>>`SELECT id FROM task_series LIMIT 1`;
    expect(series).toHaveLength(1);
    await expect(
      prisma!.$executeRaw`
        INSERT INTO task_occurrences (
          id, series_id, occurrence_key, original_local_date, scheduled_local_date, timezone_snapshot, status,
          name_snapshot, subject_snapshot, completion_standard_snapshot, steps_snapshot_json,
          grade_config_id, grade_config_version_id, stage_code_snapshot, school_system_code_snapshot,
          grade_code_snapshot, grade_label_snapshot, term_code_snapshot, catalog_entry_key_snapshot, created_at, updated_at
        )
        SELECT gen_random_uuid(), ${series[0]!.id}::uuid, occurrence_key, original_local_date, scheduled_local_date, timezone_snapshot, status,
               name_snapshot, subject_snapshot, completion_standard_snapshot, steps_snapshot_json,
               grade_config_id, grade_config_version_id, stage_code_snapshot, school_system_code_snapshot,
               grade_code_snapshot, grade_label_snapshot, term_code_snapshot, catalog_entry_key_snapshot, clock_timestamp(), clock_timestamp()
          FROM task_occurrences
         WHERE series_id = ${series[0]!.id}::uuid
         LIMIT 1
      `,
    ).rejects.toThrow();
  });
});
