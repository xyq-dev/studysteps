import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  assertStp004IntegrationReady,
  loadStp004Env,
  shouldSkipStp004Isolation,
} from './test/load-stp004-env';
import { expectedTemplateCount } from '@studysteps/domain';

const connectionString = process.env.STP004_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

describe.skipIf(shouldSkipStp004Isolation())('STP 005 catalog constraints and leftover negatives', () => {
  const prisma = new PrismaClient({ datasourceUrl: connectionString });

  beforeAll(async () => {
    loadStp004Env();
    assertStp004IntegrationReady();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('seeds 25 published grades and 39 templates including independent 初四', async () => {
    const grades = await prisma.gradeConfig.count({ where: { currentVersionId: { not: null } } });
    const templates = await prisma.planTemplateVersion.count({ where: { publishedAt: { not: null } } });
    const juniorFour = await prisma.gradeConfigVersion.findMany({
      where: { catalogEntryKey: 'JUNIOR_G4', publishedAt: { not: null } },
    });
    expect(grades).toBe(25);
    expect(templates).toBe(expectedTemplateCount());
    expect(juniorFour).toHaveLength(1);
    expect(juniorFour[0]?.gradeLabel).toBe('初四');
  });

  it('rejects new leftover rows, leftover rewrites, and SET-then-revert', async () => {
    const account = await prisma.account.create({ data: {} });
    await expect(
      prisma.studentProfile.create({
        data: {
          nickname: '新建遗留',
          avatarPresetId: 'avatar-03',
          ageBand: 'UNDER_14',
          ageConfirmationSource: 'GUARDIAN_DECLARATION',
          ageConfirmedAt: new Date(),
          ageConfirmedByAccountId: account.id,
          createdByAccountId: account.id,
          stageCode: 'primary',
          schoolSystemCode: 'liusan',
          gradeCode: 'g3',
          gradeLabel: '三年级',
          termCode: '2026-1',
        },
      }),
    ).rejects.toThrow();
    const empty = await prisma.studentProfile.create({
      data: {
        nickname: '空档案',
        avatarPresetId: 'avatar-03',
        ageBand: 'UNDER_14',
        ageConfirmationSource: 'GUARDIAN_DECLARATION',
        ageConfirmedAt: new Date(),
        ageConfirmedByAccountId: account.id,
        createdByAccountId: account.id,
      },
    });
    await expect(
      prisma.studentProfile.update({
        where: { id: empty.id },
        data: {
          stageCode: 'primary',
          schoolSystemCode: 'liusan',
          gradeCode: 'g3',
          gradeLabel: '三年级',
          termCode: '2026-1',
        },
      }),
    ).rejects.toThrow();
    const assigned = await prisma.gradeConfig.findFirstOrThrow({
      where: { schoolSystemCode: 'SIX_THREE', stageCode: 'PRIMARY', gradeCode: 'G3' },
    });
    const version = await prisma.gradeConfigVersion.findUniqueOrThrow({
      where: { id: assigned.currentVersionId! },
    });
    const complete = await prisma.studentProfile.update({
      where: { id: empty.id },
      data: {
        gradeConfigId: assigned.id,
        gradeConfigVersionId: version.id,
        stageCode: assigned.stageCode,
        schoolSystemCode: assigned.schoolSystemCode,
        gradeCode: assigned.gradeCode,
        gradeLabel: version.gradeLabel,
        termCode: 'FULL_YEAR',
      },
    });
    expect(complete.gradeConfigVersionId).toBe(version.id);
    await expect(
      prisma.studentProfile.update({
        where: { id: complete.id },
        data: {
          gradeConfigId: null,
          gradeConfigVersionId: null,
          stageCode: 'primary',
          schoolSystemCode: 'liusan',
          gradeCode: 'g3',
          gradeLabel: '三年级',
          termCode: '2026-1',
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects history UPDATE/DELETE and unpublished or mismatched current versions', async () => {
    const account = await prisma.account.create({ data: {} });
    const grade = await prisma.gradeConfig.findFirstOrThrow({
      where: { schoolSystemCode: 'SIX_THREE', stageCode: 'PRIMARY', gradeCode: 'G2' },
    });
    const student = await prisma.studentProfile.create({
      data: {
        nickname: '历史不可变',
        avatarPresetId: 'avatar-03',
        ageBand: 'UNDER_14',
        ageConfirmationSource: 'GUARDIAN_DECLARATION',
        ageConfirmedAt: new Date(),
        ageConfirmedByAccountId: account.id,
        createdByAccountId: account.id,
        gradeConfigId: grade.id,
        gradeConfigVersionId: grade.currentVersionId,
        stageCode: grade.stageCode,
        schoolSystemCode: grade.schoolSystemCode,
        gradeCode: grade.gradeCode,
        gradeLabel: '二年级',
        termCode: 'FULL_YEAR',
      },
    });
    const history = await prisma.studentEducationHistory.create({
      data: {
        studentProfileId: student.id,
        changeKind: 'SET',
        toGradeConfigId: grade.id,
        toStageCode: grade.stageCode,
        toSchoolSystemCode: grade.schoolSystemCode,
        toGradeCode: grade.gradeCode,
        toGradeLabel: '二年级',
        toTermCode: 'FULL_YEAR',
        actorAccountId: account.id,
        effectiveLocalDate: '2026-09-16',
        timezoneSnapshot: 'Asia/Shanghai',
      },
    });
    await expect(
      prisma.studentEducationHistory.update({
        where: { id: history.id },
        data: { changeKind: 'PROMOTE' },
      }),
    ).rejects.toThrow();
    await expect(prisma.studentEducationHistory.delete({ where: { id: history.id } })).rejects.toThrow();

    const unpublishedConfig = await prisma.gradeConfig.create({
      data: {
        id: randomUUID(),
        schoolSystemCode: 'CUSTOM',
        stageCode: 'SENIOR',
        gradeCode: `UNPUB_${randomUUID().slice(0, 8)}`,
      },
    });
    const unpublished = await prisma.gradeConfigVersion.create({
      data: {
        id: randomUUID(),
        gradeConfigId: unpublishedConfig.id,
        version: 'v0',
        gradeLabel: '未发布',
        sortOrder: 99,
        allowedTermCodes: '["FULL_YEAR"]',
      },
    });
    await expect(
      prisma.gradeConfig.update({
        where: { id: unpublishedConfig.id },
        data: { currentVersionId: unpublished.id },
      }),
    ).rejects.toThrow();

    const other = await prisma.gradeConfig.findFirstOrThrow({
      where: { schoolSystemCode: 'FIVE_FOUR', stageCode: 'PRIMARY', gradeCode: 'G1' },
    });
    await expect(
      prisma.$executeRaw`
        UPDATE grade_configs
           SET current_version_id = ${other.currentVersionId}::uuid
         WHERE id = ${unpublishedConfig.id}::uuid
      `,
    ).rejects.toThrow();
    await expect(
      prisma.studentProfile.update({
        where: { id: student.id },
        data: { gradeLabel: '二年级（旧标签）' },
      }),
    ).rejects.toThrow();
  });

  it('rejects mutating published grade versions', async () => {
    const version = await prisma.gradeConfigVersion.findFirstOrThrow({ where: { publishedAt: { not: null } } });
    await expect(
      prisma.gradeConfigVersion.update({
        where: { id: version.id },
        data: { gradeLabel: '被改写' },
      }),
    ).rejects.toThrow();
  });
});
