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
});
