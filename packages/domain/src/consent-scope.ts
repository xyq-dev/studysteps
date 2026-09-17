export const TEST_POLICY_V1_SCOPE = {
  nickname: true,
  avatar: true,
  age: true,
  educationSnapshot: true,
  timezone: true,
  guardianLink: true,
  authDevice: true,
  consentAudit: true,
} as const;

export const PLAN_PURPOSE_SCOPE = {
  studyPlan: true,
  templateImport: true,
  taskOccurrence: true,
  gradeSnapshot: true,
  actorAudit: true,
} as const;

export const TEST_POLICY_V2_SCOPE = {
  ...TEST_POLICY_V1_SCOPE,
  ...PLAN_PURPOSE_SCOPE,
} as const;

export const PLAN_PURPOSE_KEYS = Object.keys(PLAN_PURPOSE_SCOPE) as Array<keyof typeof PLAN_PURPOSE_SCOPE>;

export function consentCoversPlanWrites(scopeCanonicalJson: string): boolean {
  try {
    const parsed = JSON.parse(scopeCanonicalJson) as Record<string, unknown>;
    return PLAN_PURPOSE_KEYS.every((key) => parsed[key] === true);
  } catch {
    return false;
  }
}
