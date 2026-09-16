export const PRIMARY_GUARDIAN_ACTIONS = [
  'PROFILE_LIST',
  'PROFILE_READ',
  'PROFILE_UPDATE_BASIC',
  'PROFILE_UPDATE_AGE',
  'PROFILE_UPDATE_EDUCATION_SNAPSHOT',
  'CONSENT_READ',
  'CONSENT_GRANT',
  'CONSENT_WITHDRAW',
  'STUDENT_MODE_CREATE',
  'PAIRING_CREATE',
  'PAIRING_REVOKE',
  'DEVICE_SESSION_READ',
  'DEVICE_SESSION_REVOKE',
] as const;

export type GuardianAction = (typeof PRIMARY_GUARDIAN_ACTIONS)[number];
export const PROFILE_STATUSES = [
  'ONBOARDING',
  'ACTIVE',
  'RESTRICTED',
  'DELETION_PENDING',
  'DELETED',
] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];
export type SessionScope = 'GUARDIAN' | 'STUDENT';

const RESTRICTED_GUARDIAN = new Set<GuardianAction>([
  'PROFILE_READ',
  'PROFILE_UPDATE_AGE',
  'CONSENT_READ',
  'CONSENT_GRANT',
  'CONSENT_WITHDRAW',
  'DEVICE_SESSION_READ',
  'DEVICE_SESSION_REVOKE',
]);

export function isProfileStatus(status: string): status is ProfileStatus {
  return (PROFILE_STATUSES as readonly string[]).includes(status);
}

export function asProfileStatus(status: string): ProfileStatus {
  if (!isProfileStatus(status)) {
    throw new Error(`unknown profile status: ${status}`);
  }
  return status;
}

export function isDeletionStatus(status: string): boolean {
  return status === 'DELETION_PENDING' || status === 'DELETED';
}

export function guardianListIncludes(status: string): boolean {
  return status === 'ONBOARDING' || status === 'ACTIVE' || status === 'RESTRICTED';
}

export function guardianMay(status: ProfileStatus, action: GuardianAction): boolean {
  if (isDeletionStatus(status)) {
    return false;
  }
  if (status === 'RESTRICTED') {
    return RESTRICTED_GUARDIAN.has(action);
  }
  return PRIMARY_GUARDIAN_ACTIONS.includes(action);
}

export function studentMayReadSelf(status: ProfileStatus): boolean {
  return status === 'ONBOARDING' || status === 'ACTIVE';
}
