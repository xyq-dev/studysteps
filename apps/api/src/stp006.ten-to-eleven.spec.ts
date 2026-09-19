import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  assertDisposableIsolationTarget,
  assertStp004IntegrationReady,
  loadStp004Env,
  shouldSkipStp004Isolation,
} from './test/load-stp004-env';

describe.skipIf(shouldSkipStp004Isolation())('STP 006 ten-to-eleven leftover upgrade fixture', () => {
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    loadStp004Env();
    assertStp004IntegrationReady();
    const url = process.env.STP006_TEN_TO_ELEVEN_DATABASE_URL;
    if (!url) {
      throw new Error('STP006_TEN_TO_ELEVEN_DATABASE_URL is required; run scripts/stp006-ten-to-eleven.mjs');
    }
    assertDisposableIsolationTarget(url);
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    const db = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
    expect(db[0]?.current_database).toBe('stp006_ten_to_eleven');
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('keeps existing plans, revisions, exceptions and split rows after the eleventh migration', async () => {
    const applied = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    expect(applied[0]?.n).toBe(11);
    const kept = await prisma!.$queryRaw<Array<{ nickname: string }>>`
      SELECT nickname FROM student_profiles WHERE nickname = '十到十一基线'
    `;
    expect(kept).toHaveLength(1);
    const jobs = await prisma!.$queryRaw<Array<{ state: string; n: number }>>`
      SELECT state, COUNT(*)::int AS n FROM task_horizon_jobs GROUP BY state
    `;
    expect(jobs.find((row) => row.state === 'READY')?.n).toBeGreaterThanOrEqual(1);
    expect(jobs.find((row) => row.state === 'BLOCKED')?.n).toBeGreaterThanOrEqual(1);
    expect(jobs.find((row) => row.state === 'RETIRED')?.n).toBeGreaterThanOrEqual(1);
    const split = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM task_occurrences WHERE cancel_reason = 'SPLIT'
    `;
    expect(split[0]?.n).toBe(1);
    const children = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM task_occurrences WHERE source_occurrence_id IS NOT NULL
    `;
    expect(children[0]?.n).toBe(1);
    const oldGrade = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM task_occurrences WHERE catalog_entry_key_snapshot = 'PRIMARY_G2'
    `;
    expect(oldGrade[0]?.n).toBe(1);
  });

  it('rejects invalid standing-job shapes after the eleventh migration', async () => {
    const ready = await prisma!.$queryRaw<Array<{ plan_id: string }>>`
      SELECT plan_id FROM task_horizon_jobs WHERE state = 'READY' LIMIT 1
    `;
    expect(ready).toHaveLength(1);
    await expect(
      prisma!.$executeRaw`UPDATE task_horizon_jobs SET state = 'LEASED', available_at = NULL WHERE plan_id = ${ready[0]!.plan_id}::uuid`,
    ).rejects.toThrow();
    await expect(
      prisma!.$executeRaw`UPDATE task_horizon_jobs SET available_at = NULL WHERE plan_id = ${ready[0]!.plan_id}::uuid`,
    ).rejects.toThrow();
  });
});
