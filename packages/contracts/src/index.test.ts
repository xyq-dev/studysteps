import { describe, expect, it } from 'vitest';
import {
  APP_NAME,
  ERROR_CODES,
  HEALTH_OK,
  createSessionSchema,
  createStudentSchema,
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
    expect(ERROR_CODES).toContain('AGE_BAND_NOT_SUPPORTED');
    expect(ERROR_CODES).toContain('RESOURCE_NOT_FOUND');
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
