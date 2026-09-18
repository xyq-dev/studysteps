import { describe, expect, it } from 'vitest';
import {
  APP_NAME,
  ERROR_CODES,
  HEALTH_OK,
  createSessionSchema,
  createStudentSchema,
  patchStudentSchema,
  requestAuthCodeSchema,
  withdrawConsentSchema,
  createManualPlanSchema,
  patchPlanSchema,
  editOccurrenceSchema,
  futureChangeConfirmSchema,
  futureChangePreviewSchema,
  rescheduleTaskSchema,
  splitConfirmSchema,
  splitPreviewSchema,
  taskHorizonSchema,
} from './index.js';

describe('@studysteps/contracts export boundary', () => {
  it('exports the application name and health payload', () => {
    expect(APP_NAME).toBe('StudySteps');
    expect(HEALTH_OK).toEqual({
      status: 'ok',
      service: 'studysteps-api',
    });
  });

  it('keeps a stable error-code set for /v1', () => {
    expect(ERROR_CODES).toContain('GRADE_CONFIG_INVALID');
    expect(ERROR_CODES).toContain('TEMPLATE_IMPORT_NOT_ALLOWED');
    expect(ERROR_CODES).toContain('PLAN_PREVIEW_STALE');
    expect(ERROR_CODES).toContain('PLAN_STATUS_INVALID');
    expect(ERROR_CODES).toContain('TASK_DATE_CONFLICT');
    expect(ERROR_CODES).toContain('TASK_NOT_ADJUSTABLE');
    expect(ERROR_CODES).toContain('TASK_FUTURE_PREVIEW_STALE');
    expect(ERROR_CODES).toContain('TASK_SPLIT_PREVIEW_STALE');
  });
});

describe('request validation', () => {
  it('accepts a local sign-in request shape', () => {
    const parsed = requestAuthCodeSchema.parse({
      purpose: 'SIGN_IN',
      identity: { kind: 'PHONE', value: '13800138000' },
      device: { installationId: 'install-001' },
    });
    expect(parsed.purpose).toBe('SIGN_IN');
  });

  it('rejects create-student payloads that omit consent', () => {
    const result = createStudentSchema.safeParse({
      profile: {
        nickname: '小树',
        avatarPresetId: 'avatar-03',
      },
      ageConfirmation: {
        band: 'UNDER_14',
        source: 'GUARDIAN_DECLARATION',
      },
      consentAcceptances: [],
    });
    expect(result.success).toBe(false);
  });

  it('T10-3 strips forged accountId and studentId from write bodies', () => {
    const created = createStudentSchema.parse({
      accountId: 'forged-account',
      studentId: 'forged-student',
      profile: { nickname: '小树', avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
      ageConfirmation: { band: 'UNDER_14', source: 'GUARDIAN_DECLARATION' },
      consentAcceptances: [{ policyKey: 'TEST_CHILD_CORE_SERVICE', version: 'test-v1' }],
    });
    expect(created).not.toHaveProperty('accountId');
    expect(created).not.toHaveProperty('studentId');
    const session = createSessionSchema.parse({
      grantType: 'STUDENT_MODE',
      studentId: '11111111-1111-1111-1111-111111111111',
      accountId: 'forged-account',
    });
    expect(session).not.toHaveProperty('accountId');
    expect(session.studentId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('rejects non-empty education on create and requires EDUCATION patch fields', () => {
    const base = {
      profile: { nickname: '小树', avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
      ageConfirmation: { band: 'UNDER_14' as const, source: 'GUARDIAN_DECLARATION' as const },
      consentAcceptances: [{ policyKey: 'TEST_CHILD_CORE_SERVICE', version: 'test-v1' }],
    };
    expect(createStudentSchema.safeParse(base).success).toBe(true);
    expect(
      createStudentSchema.safeParse({
        ...base,
        education: {
          stageCode: 'PRIMARY',
          schoolSystemCode: 'SIX_THREE',
          gradeCode: 'G3',
          gradeLabel: '三年级',
          termCode: 'FULL_YEAR',
        },
      }).success,
    ).toBe(false);
    expect(
      patchStudentSchema.safeParse({
        kind: 'EDUCATION',
        expectedVersion: 1,
        gradeConfigId: '11111111-1111-4111-8111-111111111111',
        termCode: 'FIRST_TERM',
        changeKind: 'SET',
      }).success,
    ).toBe(true);
  });

  it('does not require expectedStudentVersion on withdraw', () => {
    expect(withdrawConsentSchema.parse({ reasonCode: 'GUARDIAN_REQUEST' })).toEqual({
      reasonCode: 'GUARDIAN_REQUEST',
    });
    expect(
      withdrawConsentSchema.safeParse({
        reasonCode: 'GUARDIAN_REQUEST',
        expectedStudentVersion: 3,
      }).success,
    ).toBe(true);
    expect(Object.keys(withdrawConsentSchema.shape)).not.toContain(
      'expectedStudentVersion',
    );
  });

  it('accepts manual plan confirm bodies without a template id', () => {
    const parsed = createManualPlanSchema.parse({
      expectedStudentVersion: 2,
      previewDigest: 'd'.repeat(16),
      tasks: [{ name: '自主阅读', subject: '自定义', standard: '完成' }],
      coCreationAttested: true,
      templateId: 'should-be-stripped-or-ignored',
    });
    expect(parsed.tasks[0]?.name).toBe('自主阅读');
    expect(parsed).not.toHaveProperty('templateId');
  });

  it('accepts plan status patch bodies without co-creation fields', () => {
    expect(
      patchPlanSchema.parse({
        action: 'PAUSE',
        expectedVersion: 1,
        coCreationAttested: true,
      }),
    ).toEqual({ action: 'PAUSE', expectedVersion: 1 });
    expect(patchPlanSchema.safeParse({ action: 'UNARCHIVE', expectedVersion: 1 }).success).toBe(false);
  });

  it('accepts single-occurrence reschedule bodies and rejects extra fields', () => {
    expect(
      rescheduleTaskSchema.parse({
        scheduledLocalDate: '2026-10-02',
        reason: '调到周末',
        expectedVersion: 1,
      }),
    ).toEqual({
      scheduledLocalDate: '2026-10-02',
      reason: '调到周末',
      expectedVersion: 1,
    });
    expect(
      rescheduleTaskSchema.safeParse({
        scheduledLocalDate: '2026-10-02',
        reason: '调到周末',
        expectedVersion: 1,
        occurrenceKey: '2026-09-18',
      }).success,
    ).toBe(false);
  });

  it('accepts this-occurrence content edits and rejects date or key fields', () => {
    expect(
      editOccurrenceSchema.parse({
        name: '朗读',
        subject: '语文',
        standard: '读完一页',
        durationMinutes: 15,
        steps: ['先读'],
        expectedVersion: 2,
      }),
    ).toEqual({
      name: '朗读',
      subject: '语文',
      standard: '读完一页',
      durationMinutes: 15,
      steps: ['先读'],
      expectedVersion: 2,
    });
    expect(
      editOccurrenceSchema.safeParse({
        name: '朗读',
        subject: '语文',
        standard: '读完一页',
        durationMinutes: 15,
        steps: ['先读'],
        expectedVersion: 2,
        scheduledLocalDate: '2026-10-02',
      }).success,
    ).toBe(false);
    expect(
      editOccurrenceSchema.safeParse({
        name: '',
        subject: '语文',
        standard: '读完一页',
        durationMinutes: null,
        steps: [],
        expectedVersion: 1,
      }).success,
    ).toBe(false);
  });

  it('rejects client-chosen task horizon windows', () => {
    expect(taskHorizonSchema.parse({})).toEqual({});
    expect(taskHorizonSchema.parse({ expectedStudentVersion: 3 })).toEqual({ expectedStudentVersion: 3 });
    expect(taskHorizonSchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(false);
    expect(taskHorizonSchema.safeParse({ studentId: 'other' }).success).toBe(false);
  });

  it('accepts FUTURE content or schedule preview/confirm and rejects mixed or history fields', () => {
    const proposal = {
      kind: 'CONTENT',
      name: '朗读',
      subject: '语文',
      standard: '读完一页',
      durationMinutes: 15,
      steps: ['先读'],
      reason: '统一后续课文',
    };
    const preview = {
      expectedStudentVersion: 2,
      expectedPlanVersion: 1,
      expectedSeriesVersion: 1,
      expectedOccurrenceVersion: 3,
      proposal,
    };
    expect(futureChangePreviewSchema.parse(preview)).toEqual(preview);
    expect(
      futureChangeConfirmSchema.parse({
        ...preview,
        previewDigest: 'd'.repeat(16),
      }).previewDigest,
    ).toHaveLength(16);
    const schedule = {
      kind: 'SCHEDULE' as const,
      repeatKind: 'WEEKLY_DAYS' as const,
      weekdays: [1, 3, 5],
      endLocalDate: null,
      ongoing: true,
      reason: '改成指定日',
    };
    expect(
      futureChangePreviewSchema.parse({
        ...preview,
        proposal: schedule,
      }).proposal,
    ).toEqual(schedule);
    expect(
      futureChangePreviewSchema.safeParse({
        ...preview,
        proposal: { ...proposal, kind: 'SCHEDULE', repeatKind: 'DAILY' },
      }).success,
    ).toBe(false);
    expect(
      futureChangePreviewSchema.safeParse({
        ...preview,
        proposal: { ...schedule, weekdays: null },
      }).success,
    ).toBe(false);
    expect(
      futureChangePreviewSchema.safeParse({
        ...preview,
        proposal: { ...schedule, repeatKind: 'DAILY', weekdays: [1] },
      }).success,
    ).toBe(false);
    expect(
      futureChangeConfirmSchema.safeParse({
        ...preview,
        previewDigest: 'd'.repeat(16),
        coCreationAttested: true,
      }).success,
    ).toBe(false);
    expect(
      futureChangePreviewSchema.safeParse({
        ...preview,
        fromLocalDate: '2026-09-20',
      }).success,
    ).toBe(false);
  });

  it('accepts split preview and confirm and rejects co-creation or one child', () => {
    const child = {
      name: '朗读上',
      subject: '语文',
      standard: '读完前半',
      durationMinutes: 10,
      steps: ['先读'],
      scheduledLocalDate: '2026-09-18',
    };
    const preview = {
      expectedStudentVersion: 3,
      expectedPlanVersion: 1,
      expectedSeriesVersion: 1,
      expectedOccurrenceVersion: 2,
      children: [child, { ...child, name: '朗读下' }],
      reason: '拆成两次完成',
    };
    expect(splitPreviewSchema.parse(preview).children).toHaveLength(2);
    expect(splitConfirmSchema.parse({ ...preview, previewDigest: 'd'.repeat(16) }).reason).toBe('拆成两次完成');
    expect(splitPreviewSchema.safeParse({ ...preview, children: [child] }).success).toBe(false);
    expect(splitPreviewSchema.safeParse({ ...preview, coCreationAttested: true }).success).toBe(false);
    expect(
      splitConfirmSchema.safeParse({
        ...preview,
        previewDigest: 'd'.repeat(16),
        studentConfirmedAt: '2026-09-18T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
