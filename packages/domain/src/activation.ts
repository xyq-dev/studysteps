import {
  isCompleteEducationSnapshot,
  isLeftoverEducationSnapshot,
  type EducationSnapshot,
} from './grade.js';
import { isDeletionStatus } from './permissions.js';

export type LearningAccess =
  | { allowed: true }
  | { allowed: false; reason: 'ACADEMIC_CONFIGURATION_PENDING' | 'RESTRICTED' | 'CONSENT_REQUIRED' };

export type ActivationInput = {
  storedStatus: string;
  snapshot: EducationSnapshot;
  matchesPublishedVersion: boolean;
  consentCurrent: boolean;
};

export type ActivationResult = {
  status: 'ONBOARDING' | 'ACTIVE' | 'RESTRICTED';
  learningAccess: LearningAccess;
};

export function consentCurrentFromVerifiedProbe(): true {
  return true;
}

export function applyConsentProbeFailure(error: unknown): false {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: unknown }).code === 'CONSENT_REQUIRED'
  ) {
    return false;
  }
  throw error;
}

export function evaluateActivation(input: ActivationInput): ActivationResult {
  if (input.storedStatus === 'RESTRICTED' || isDeletionStatus(input.storedStatus)) {
    return {
      status: 'RESTRICTED',
      learningAccess: { allowed: false, reason: 'RESTRICTED' },
    };
  }
  const complete =
    isCompleteEducationSnapshot(input.snapshot) &&
    input.matchesPublishedVersion &&
    !isLeftoverEducationSnapshot(input.snapshot);
  if (!complete) {
    return {
      status: 'ONBOARDING',
      learningAccess: { allowed: false, reason: 'ACADEMIC_CONFIGURATION_PENDING' },
    };
  }
  if (!input.consentCurrent) {
    return {
      status: 'ONBOARDING',
      learningAccess: { allowed: false, reason: 'CONSENT_REQUIRED' },
    };
  }
  return { status: 'ACTIVE', learningAccess: { allowed: true } };
}
