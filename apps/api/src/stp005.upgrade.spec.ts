import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  assertDisposableIsolationTarget,
  assertStp004IntegrationReady,
  loadStp004Env,
  shouldSkipStp004Isolation,
} from './test/load-stp004-env';

function digest(row: {
  stage_code: string | null;
  school_system_code: string | null;
  grade_code: string | null;
  grade_label: string | null;
  term_code: string | null;
}): string {
  return createHash('md5')
    .update(
      [row.stage_code, row.school_system_code, row.grade_code, row.grade_label, row.term_code]
        .map((value) => value ?? '')
        .join('\x1f'),
    )
    .digest('hex');
}

describe.skipIf(shouldSkipStp004Isolation())('STP 005 four-to-six leftover upgrade fixture', () => {
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    loadStp004Env();
    assertStp004IntegrationReady();
    const url = process.env.STP005_FOUR_TO_SIX_DATABASE_URL;
    if (!url) {
      throw new Error('STP005_FOUR_TO_SIX_DATABASE_URL is required; run scripts/stp005-four-to-six-upgrade.mjs');
    }
    assertDisposableIsolationTarget(url);
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    const db = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
    expect(db[0]?.current_database.startsWith('stp005_rev_') || db[0]?.current_database === 'studysteps').toBe(
      true,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('keeps the proven leftover tuple on the trusted allowlist and backfills assigned versions only', async () => {
    const leftover = await prisma!.$queryRaw<
      Array<{
        id: string;
        nickname: string;
        grade_config_id: string | null;
        grade_config_version_id: string | null;
        stage_code: string | null;
        school_system_code: string | null;
        grade_code: string | null;
        grade_label: string | null;
        term_code: string | null;
      }>
    >`SELECT id, nickname, grade_config_id, grade_config_version_id, stage_code, school_system_code, grade_code, grade_label, term_code
        FROM student_profiles
       WHERE nickname = '遗留快照'`;
    expect(leftover).toHaveLength(1);
    expect(leftover[0]?.grade_config_id).toBeNull();
    expect(leftover[0]?.grade_config_version_id).toBeNull();
    expect(leftover[0]?.grade_code).toBe('g3');
    expect(leftover[0]?.term_code).toBe('2026-1');
    const allowlist = await prisma!.$queryRaw<
      Array<{
        student_profile_id: string;
        tuple_digest: string;
        stage_code: string | null;
        school_system_code: string | null;
        grade_code: string | null;
        grade_label: string | null;
        term_code: string | null;
      }>
    >`SELECT student_profile_id, tuple_digest, stage_code, school_system_code, grade_code, grade_label, term_code
        FROM stp005_trusted_legacy_allowlist`;
    expect(allowlist).toHaveLength(1);
    expect(allowlist[0]?.student_profile_id).toBe(leftover[0]?.id);
    expect(allowlist[0]?.tuple_digest).toBe(digest(leftover[0]!));
    expect(allowlist[0]?.tuple_digest).toBe(digest(allowlist[0]!));

    const oldFingerprints = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'stp005_legacy_education_fingerprints'
    `;
    expect(oldFingerprints[0]?.n).toBe(0);

    const empty = await prisma!.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM student_profiles WHERE nickname = '空升级档案'
    `;
    expect(empty).toHaveLength(1);
    const emptyPrint = await prisma!.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM stp005_trusted_legacy_allowlist WHERE student_profile_id = ${empty[0]!.id}::uuid
    `;
    expect(emptyPrint[0]?.n).toBe(0);

    const assigned = await prisma!.$queryRaw<
      Array<{ grade_config_version_id: string | null; current_version_id: string | null }>
    >`
      SELECT sp.grade_config_version_id, g.current_version_id
        FROM student_profiles sp
        JOIN grade_configs g ON g.id = sp.grade_config_id
       WHERE sp.nickname = '已配齐升级档案'
    `;
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.grade_config_version_id).toBe(assigned[0]?.current_version_id);
    expect(assigned[0]?.grade_config_version_id).toBeTruthy();
  });

  it('rejects allowlist mutation and leftover rewrite on the fixture row', async () => {
    const leftover = await prisma!.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM student_profiles WHERE nickname = '遗留快照'
    `;
    await expect(
      prisma!.$executeRaw`UPDATE stp005_trusted_legacy_allowlist SET tuple_digest = 'tampered'`,
    ).rejects.toThrow();
    await expect(prisma!.$executeRaw`DELETE FROM stp005_trusted_legacy_allowlist`).rejects.toThrow();
    await expect(
      prisma!.$executeRaw`INSERT INTO stp005_trusted_legacy_allowlist
        (student_profile_id, stage_code, school_system_code, grade_code, grade_label, term_code, tuple_digest)
        VALUES (${leftover[0]!.id}::uuid, 'x', 'y', 'z', 'w', 'v', 'deadbeef')`,
    ).rejects.toThrow();
    await expect(
      prisma!.$executeRaw`
        UPDATE student_profiles
           SET grade_label = '被改写'
         WHERE id = ${leftover[0]!.id}::uuid
      `,
    ).rejects.toThrow();
  });

  it('has composite version FKs and published-current constraint objects', async () => {
    const objects = await prisma!.$queryRaw<Array<{ kind: string; name: string }>>`
      SELECT 'fk' AS kind, conname AS name
        FROM pg_constraint
       WHERE conname IN ('grade_configs_current_version_fk', 'student_profiles_grade_version_fk', 'student_profiles_education_shape_ck')
      UNION ALL
      SELECT 'trg', tgname
        FROM pg_trigger
       WHERE tgname IN (
         'grade_configs_current_published',
         'student_profiles_education_guard',
         'stp005_trusted_legacy_allowlist_immutable'
       )
      ORDER BY 1, 2
    `;
    expect(objects.map((row) => `${row.kind}:${row.name}`).sort()).toEqual([
      'fk:grade_configs_current_version_fk',
      'fk:student_profiles_education_shape_ck',
      'fk:student_profiles_grade_version_fk',
      'trg:grade_configs_current_published',
      'trg:stp005_trusted_legacy_allowlist_immutable',
      'trg:student_profiles_education_guard',
    ]);
  });
});
