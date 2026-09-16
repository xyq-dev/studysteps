export type ConfirmedAgeBand = 'UNDER_14' | 'AGE_14_TO_17' | 'AGE_18_PLUS';

export type AgeDecision =
  | { ok: true; band: 'UNDER_14' | 'AGE_14_TO_17'; policyKey: string }
  | { ok: false; code: 'AGE_CONFIRMATION_REQUIRED' | 'AGE_BAND_NOT_SUPPORTED' };

export function requiredPolicyKey(
  band: 'UNDER_14' | 'AGE_14_TO_17',
): 'TEST_CHILD_CORE_SERVICE' | 'TEST_MINOR_CORE_SERVICE' {
  return band === 'UNDER_14'
    ? 'TEST_CHILD_CORE_SERVICE'
    : 'TEST_MINOR_CORE_SERVICE';
}

export function decideAgeBand(band: ConfirmedAgeBand | 'UNCONFIRMED'): AgeDecision {
  if (band === 'UNCONFIRMED') {
    return { ok: false, code: 'AGE_CONFIRMATION_REQUIRED' };
  }
  if (band === 'AGE_18_PLUS') {
    return { ok: false, code: 'AGE_BAND_NOT_SUPPORTED' };
  }
  return { ok: true, band, policyKey: requiredPolicyKey(band) };
}

export function educationUnchanged<T extends object>(
  before: T,
  after: T,
): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}
