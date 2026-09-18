import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  assertDisposableIsolationTarget,
  assertStp004IntegrationReady,
  loadStp004Env,
  shouldSkipStp004Isolation,
} from './test/load-stp004-env';

describe.skipIf(shouldSkipStp004Isolation())('STP 006 eight-to-nine leftover upgrade fixture', () => {
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    loadStp004Env();
    assertStp004IntegrationReady();
    const url = process.env.STP006_EIGHT_TO_NINE_DATABASE_URL;
    if (!url) {
      throw new Error('STP006_EIGHT_TO_NINE_DATABASE_URL is required; run scripts/stp006-eight-to-nine.mjs');
    }
    assertDisposableIsolationTarget(url);
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    const db = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
    expect(db[0]?.current_database).toBe('stp006_eight_to_nine');
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('keeps the eight-baseline student and backfills revision plus exception pointers', async () => {
    const applied = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    expect(applied[0]?.n).toBe(9);
    const ninth = await prisma!.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations
       WHERE migration_name = '20260918120000_stp006_series_revisions'
    `;
    expect(ninth).toHaveLength(1);
    const kept = await prisma!.$queryRaw<Array<{ nickname: string }>>`
      SELECT nickname FROM student_profiles WHERE nickname = '八到九基线'
    `;
    expect(kept).toHaveLength(1);
    const revisions = await prisma!.$queryRaw<Array<{ revision_no: number; change_kind: string }>>`
      SELECT revision_no, change_kind FROM task_series_revisions
    `;
    expect(revisions.length).toBeGreaterThan(0);
    expect(revisions.every((row) => row.revision_no === 1 && row.change_kind === 'BASELINE')).toBe(true);
    const exceptions = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM task_occurrences WHERE content_exception_adjustment_id IS NOT NULL
    `;
    expect(exceptions[0]?.n).toBeGreaterThan(0);
    const scheduleExceptions = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM task_occurrences WHERE schedule_exception_adjustment_id IS NOT NULL
    `;
    expect(scheduleExceptions[0]?.n).toBeGreaterThan(0);
  });

  it('rejects immutable and same-series date writes after the ninth migration', async () => {
    const series = await prisma!.$queryRaw<Array<{ id: string }>>`SELECT id FROM task_series LIMIT 1`;
    expect(series).toHaveLength(1);
    await expect(
      prisma!.$executeRaw`UPDATE task_series SET name = '不该改' WHERE id = ${series[0]!.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      prisma!.$executeRaw`UPDATE task_series_revisions SET name = '不该改' WHERE task_series_id = ${series[0]!.id}::uuid AND revision_no = 1`,
    ).rejects.toThrow();
    const occ = await prisma!.$queryRaw<Array<{ scheduled_local_date: string }>>`
      SELECT scheduled_local_date FROM task_occurrences WHERE series_id = ${series[0]!.id}::uuid LIMIT 1
    `;
    await expect(
      prisma!.$executeRaw`
        INSERT INTO task_occurrences (
          id, series_id, occurrence_key, original_local_date, scheduled_local_date, timezone_snapshot, status,
          name_snapshot, subject_snapshot, completion_standard_snapshot, steps_snapshot_json,
          grade_config_id, grade_config_version_id, stage_code_snapshot, school_system_code_snapshot,
          grade_code_snapshot, grade_label_snapshot, term_code_snapshot, catalog_entry_key_snapshot
        )
        SELECT gen_random_uuid(), ${series[0]!.id}::uuid, '2026-11-01', '2026-11-01', scheduled_local_date, timezone_snapshot, status,
               name_snapshot, subject_snapshot, completion_standard_snapshot, steps_snapshot_json,
               grade_config_id, grade_config_version_id, stage_code_snapshot, school_system_code_snapshot,
               grade_code_snapshot, grade_label_snapshot, term_code_snapshot, catalog_entry_key_snapshot
          FROM task_occurrences
         WHERE series_id = ${series[0]!.id}::uuid
         LIMIT 1
      `,
    ).rejects.toThrow();
    expect(occ[0]?.scheduled_local_date).toBeTruthy();
  });
});
