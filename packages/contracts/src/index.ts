export const APP_NAME = 'StudySteps';

export type HealthStatus = 'ok';

export type HealthResponse = {
  status: HealthStatus;
  service: 'studysteps-api';
};

export const HEALTH_OK = {
  status: 'ok',
  service: 'studysteps-api',
} as const satisfies HealthResponse;

export const TEST_POLICY_KEYS = {
  UNDER_14: 'TEST_CHILD_CORE_SERVICE',
  AGE_14_TO_17: 'TEST_MINOR_CORE_SERVICE',
} as const;

export const GUARDIAN_DECLARATION_TEXT =
  '我声明自己是该未成年人的监护人，并确认所填信息';

export * from './errors.js';
export * from './auth.js';
export * from './students.js';
export * from './consents.js';
