import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { TEST_POLICY_KEYS, TEST_POLICY_V2_VERSION } from '@studysteps/contracts';
import { TEST_POLICY_V1_SCOPE, TEST_POLICY_V2_SCOPE } from '@studysteps/domain';
import { AppModule } from './app.module';
import { expectedTestV1Body, expectedTestV2Body } from './students/policy-publish.service';
import {
  assertDisposableIsolationTarget,
  assertStp004IntegrationReady,
  loadStp004Env,
  shouldSkipStp004Isolation,
} from './test/load-stp004-env';

describe.skipIf(shouldSkipStp004Isolation())('STP 006 seventh migration and constraints', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    loadStp004Env();
    assertStp004IntegrationReady();
    const url = process.env.STP004_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
    assertDisposableIsolationTarget(url);
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    const db = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
    const name = db[0]?.current_database ?? '';
    if (['stp004_identity', 'stp004_identity_fresh', 'stp005_four_to_six'].includes(name)) {
      throw new Error(`refusing STP 006 DB tests against ${name}`);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    await app.close();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('applies seven migrations and does not publish policy in the structure migration', async () => {
    const applied = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    expect(applied[0]?.n).toBe(7);
    const seventh = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations
       WHERE migration_name = '20260917120000_stp006_study_plans_occurrences'
    `;
    expect(seventh).toHaveLength(1);
    const sql = await prisma.$queryRaw<Array<{ checksum: string }>>`
      SELECT checksum FROM _prisma_migrations
       WHERE migration_name = '20260917120000_stp006_study_plans_occurrences'
    `;
    expect(sql[0]?.checksum).toBeTruthy();
  });

  it('keeps test-v1 body/scope and publishes informal test-v2 separately', async () => {
    const policy = await prisma.consentPolicy.findUniqueOrThrow({
      where: { policyKey_locale: { policyKey: TEST_POLICY_KEYS.UNDER_14, locale: 'zh-CN' } },
      include: { documents: true },
    });
    const v1 = policy.documents.find((item) => item.version === 'test-v1');
    const v2 = policy.documents.find((item) => item.version === TEST_POLICY_V2_VERSION);
    expect(v1?.contentBody).toBe(expectedTestV1Body(TEST_POLICY_KEYS.UNDER_14));
    expect(v1?.scopeCanonicalJson).toBe(JSON.stringify(TEST_POLICY_V1_SCOPE));
    expect(v2?.contentBody).toBe(expectedTestV2Body(TEST_POLICY_KEYS.UNDER_14));
    expect(v2?.scopeCanonicalJson).toBe(JSON.stringify(TEST_POLICY_V2_SCOPE));
    expect(policy.currentDocumentVersionId).toBe(v2?.id);
  });

  it('rejects duplicate occurrence keys and assisted plans without attestation', async () => {
    const account = await prisma.account.create({ data: {} });
    const student = await prisma.studentProfile.create({
      data: {
        nickname: `约束${randomUUID().slice(0, 8)}`,
        avatarPresetId: 'avatar-03',
        ageBand: 'UNDER_14',
        ageConfirmationSource: 'GUARDIAN_DECLARATION',
        ageConfirmedAt: new Date(),
        ageConfirmedByAccountId: account.id,
        timezone: 'Asia/Shanghai',
        createdByAccountId: account.id,
      },
    });
    const plan = await prisma.studyPlan.create({
      data: {
        studentProfileId: student.id,
        origin: 'STUDENT',
        importedContentJson: '[]',
        timezoneSnapshot: 'Asia/Shanghai',
      },
    });
    const series = await prisma.taskSeries.create({
      data: {
        planId: plan.id,
        name: '去重',
        subject: '自定义',
        completionStandard: '完成',
        repeatKind: 'ONCE',
        startLocalDate: '2026-09-17',
        endLocalDate: '2026-09-17',
        ongoing: false,
        effectiveFromLocalDate: '2026-09-17',
      },
    });
    const grade = await prisma.gradeConfig.findFirstOrThrow({
      where: { schoolSystemCode: 'SIX_THREE', stageCode: 'PRIMARY', gradeCode: 'G1' },
    });
    const occ = {
      seriesId: series.id,
      occurrenceKey: '2026-09-17',
      originalLocalDate: '2026-09-17',
      scheduledLocalDate: '2026-09-17',
      timezoneSnapshot: 'Asia/Shanghai',
      status: 'PLANNED',
      nameSnapshot: '去重',
      subjectSnapshot: '自定义',
      completionStandardSnapshot: '完成',
      stepsSnapshotJson: '[]',
      gradeConfigId: grade.id,
      gradeConfigVersionId: grade.currentVersionId!,
      stageCodeSnapshot: 'PRIMARY',
      schoolSystemCodeSnapshot: 'SIX_THREE',
      gradeCodeSnapshot: 'G1',
      gradeLabelSnapshot: '一年级',
      termCodeSnapshot: 'FULL_YEAR',
      catalogEntryKeySnapshot: 'PRIMARY_G1',
    };
    await prisma.taskOccurrence.create({ data: occ });
    await expect(prisma.taskOccurrence.create({ data: occ })).rejects.toThrow();
    await expect(
      prisma.studyPlan.create({
        data: {
          studentProfileId: student.id,
          origin: 'GUARDIAN_ASSISTED',
          importedContentJson: '[]',
          timezoneSnapshot: 'Asia/Shanghai',
        },
      }),
    ).rejects.toThrow();
  });
});
