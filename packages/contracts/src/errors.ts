export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'AUTH_SESSION_INVALID',
  'AUTH_GRANT_INVALID',
  'PAIRING_INVALID',
  'SESSION_SCOPE_FORBIDDEN',
  'STEP_UP_REQUIRED',
  'LEARNING_ACCESS_BLOCKED',
  'RESOURCE_NOT_FOUND',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'CONSENT_VERSION_CHANGED',
  'AGE_CONFIRMATION_REQUIRED',
  'AGE_BAND_NOT_SUPPORTED',
  'CONSENT_REQUIRED',
  'RATE_LIMITED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorBody = {
  code: ErrorCode;
  message: string;
  requestId: string;
  fields?: Record<string, string>;
};
