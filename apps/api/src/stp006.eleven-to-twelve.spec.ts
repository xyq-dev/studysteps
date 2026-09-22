import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  assertDisposableIsolationTarget,
  assertStp004IntegrationReady,
  loadStp004Env,
  shouldSkipStp004Isolation,
} from './test/load-stp004-env';

describe.skipIf(shouldSkipStp004Isolation())('STP 006 eleven-to-twelve leftover upgrade fixture', () => {
  let legal: PrismaClient | undefined;
  let dirty: PrismaClient | undefined;

  beforeAll(async () => {
    loadStp004Env();
    assertStp004IntegrationReady();
    const legalUrl = process.env.STP006_ELEVEN_TO_TWELVE_DATABASE_URL;
    const dirtyUrl = process.env.STP006_ELEVEN_DIRTY_DATABASE_URL;
    if (!legalUrl) {
      throw new Error('STP006_ELEVEN_TO_TWELVE_DATABASE_URL is required; run scripts/stp006-eleven-to-twelve.mjs');
    }
    if (!dirtyUrl) {
      throw new Error('STP006_ELEVEN_DIRTY_DATABASE_URL is required; run scripts/stp006-eleven-to-twelve.mjs');
    }
    assertDisposableIsolationTarget(legalUrl);
    assertDisposableIsolationTarget(dirtyUrl);
    legal = new PrismaClient({ datasourceUrl: legalUrl });
    dirty = new PrismaClient({ datasourceUrl: dirtyUrl });
    await legal.$connect();
    await dirty.$connect();
    const legalDb = await legal.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
    const dirtyDb = await dirty.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
    expect(legalDb[0]?.current_database).toBe('stp006_eleven_to_twelve');
    expect(dirtyDb[0]?.current_database).toBe('stp006_eleven_dirty');
  });

  afterAll(async () => {
    await legal?.$disconnect();
    await dirty?.$disconnect();
  });

  it('keeps legal eleventh business rows after the twelfth migration', async () => {
    const applied = await legal!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    expect(applied[0]?.n).toBe(12);
    const twelfth = await legal!.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations
       WHERE migration_name = '20260922120000_stp006_horizon_job_reason_null_safe'
    `;
    expect(twelfth).toHaveLength(1);
    const kept = await legal!.$queryRaw<Array<{ nickname: string }>>`
      SELECT nickname FROM student_profiles WHERE nickname = '十一到十二基线'
    `;
    expect(kept).toHaveLength(1);
    const jobs = await legal!.$queryRaw<Array<{ state: string; n: number }>>`
      SELECT state, COUNT(*)::int AS n FROM task_horizon_jobs GROUP BY state
    `;
    expect(jobs.find((row) => row.state === 'READY')?.n).toBeGreaterThanOrEqual(1);
    expect(jobs.find((row) => row.state === 'BLOCKED')?.n).toBeGreaterThanOrEqual(1);
    expect(jobs.find((row) => row.state === 'RETIRED')?.n).toBeGreaterThanOrEqual(1);
  });

  it('rejects BLOCKED FAILED and RETIRED rows that omit state_reason', async () => {
    const ready = await legal!.$queryRaw<Array<{ plan_id: string }>>`
      SELECT plan_id FROM task_horizon_jobs WHERE state = 'READY' LIMIT 1
    `;
    expect(ready).toHaveLength(1);
    await expect(
      legal!.$executeRaw`
        UPDATE task_horizon_jobs
           SET state = 'BLOCKED', state_reason = NULL, available_at = clock_timestamp()
         WHERE plan_id = ${ready[0]!.plan_id}::uuid
      `,
    ).rejects.toThrow();
    await expect(
      legal!.$executeRaw`
        UPDATE task_horizon_jobs
           SET state = 'FAILED', state_reason = NULL, available_at = NULL
         WHERE plan_id = ${ready[0]!.plan_id}::uuid
      `,
    ).rejects.toThrow();
    await expect(
      legal!.$executeRaw`
        UPDATE task_horizon_jobs
           SET state = 'RETIRED', state_reason = NULL, available_at = NULL
         WHERE plan_id = ${ready[0]!.plan_id}::uuid
      `,
    ).rejects.toThrow();
    await legal!.$executeRaw`
      UPDATE task_horizon_jobs
         SET state = 'FAILED', state_reason = 'RETRY_EXHAUSTED', available_at = NULL
       WHERE plan_id = ${ready[0]!.plan_id}::uuid
    `;
    await legal!.$executeRaw`
      UPDATE task_horizon_jobs
         SET state = 'READY', state_reason = NULL, available_at = clock_timestamp()
       WHERE plan_id = ${ready[0]!.plan_id}::uuid
    `;
  });

  it('refuses a dirty eleventh baseline and leaves the NULL reasons in place', async () => {
    const applied = await dirty!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    expect(applied[0]?.n).toBe(11);
    const twelfth = await dirty!.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations
       WHERE migration_name = '20260922120000_stp006_horizon_job_reason_null_safe'
    `;
    expect(twelfth).toHaveLength(0);
    const nulls = await dirty!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM task_horizon_jobs
       WHERE state IN ('BLOCKED', 'FAILED', 'RETIRED') AND state_reason IS NULL
    `;
    expect(nulls[0]?.n).toBe(3);
  });
});
