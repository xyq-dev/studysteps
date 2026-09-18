import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  assertDisposableIsolationTarget,
  assertStp004IntegrationReady,
  loadStp004Env,
  shouldSkipStp004Isolation,
} from './test/load-stp004-env';

describe.skipIf(shouldSkipStp004Isolation())('STP 006 nine-to-ten leftover upgrade fixture', () => {
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    loadStp004Env();
    assertStp004IntegrationReady();
    const url = process.env.STP006_NINE_TO_TEN_DATABASE_URL;
    if (!url) {
      throw new Error('STP006_NINE_TO_TEN_DATABASE_URL is required; run scripts/stp006-nine-to-ten.mjs');
    }
    assertDisposableIsolationTarget(url);
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    const db = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
    expect(db[0]?.current_database).toBe('stp006_nine_to_ten');
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('keeps the nine-baseline student, revisions and exceptions after the tenth migration', async () => {
    const applied = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    expect(applied[0]?.n).toBe(10);
    const tenth = await prisma!.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations
       WHERE migration_name = '20260918180000_stp006_split_parentage'
    `;
    expect(tenth).toHaveLength(1);
    const kept = await prisma!.$queryRaw<Array<{ nickname: string }>>`
      SELECT nickname FROM student_profiles WHERE nickname = '九到十基线'
    `;
    expect(kept).toHaveLength(1);
    const revisions = await prisma!.$queryRaw<Array<{ revision_no: number; change_kind: string }>>`
      SELECT revision_no, change_kind FROM task_series_revisions
    `;
    expect(revisions.length).toBeGreaterThan(0);
    expect(revisions.every((row) => row.revision_no >= 1)).toBe(true);
    const exceptions = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM task_occurrences WHERE content_exception_adjustment_id IS NOT NULL
    `;
    expect(exceptions[0]?.n).toBeGreaterThan(0);
    const scheduleExceptions = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM task_occurrences WHERE schedule_exception_adjustment_id IS NOT NULL
    `;
    expect(scheduleExceptions[0]?.n).toBeGreaterThan(0);
    const split = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM task_occurrences WHERE cancel_reason = 'SPLIT'
    `;
    expect(split[0]?.n).toBe(1);
    const children = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM task_occurrences WHERE source_occurrence_id IS NOT NULL
    `;
    expect(children[0]?.n).toBe(1);
  });

  it('rejects cross-plan, one-level and immutable source pointers after the tenth migration', async () => {
    const parent = await prisma!.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM task_occurrences WHERE cancel_reason = 'SPLIT' LIMIT 1
    `;
    const child = await prisma!.$queryRaw<Array<{ id: string; source_occurrence_id: string }>>`
      SELECT id, source_occurrence_id FROM task_occurrences WHERE source_occurrence_id IS NOT NULL LIMIT 1
    `;
    expect(parent).toHaveLength(1);
    expect(child).toHaveLength(1);
    await expect(
      prisma!.$executeRaw`UPDATE task_occurrences SET source_occurrence_id = NULL WHERE id = ${child[0]!.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      prisma!.$executeRaw`UPDATE task_occurrences SET cancel_reason = 'BOGUS' WHERE id = ${parent[0]!.id}::uuid`,
    ).rejects.toThrow();
  });
});
