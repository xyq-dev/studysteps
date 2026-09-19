import { createHash } from 'node:crypto';
import { addLocalDays, localDateInTimeZone } from './planning.js';

export const HORIZON_JOB_STATES = ['READY', 'LEASED', 'BLOCKED', 'FAILED', 'RETIRED'] as const;
export type HorizonJobState = (typeof HORIZON_JOB_STATES)[number];

export const HORIZON_BLOCKED_REASONS = [
  'PLAN_PAUSED',
  'PROFILE_NOT_ACTIVE',
  'AGE_NOT_SUPPORTED',
  'ACCOUNT_NOT_ACTIVE',
  'GUARDIAN_LINK_NOT_ACTIVE',
  'CONSENT_REQUIRED',
  'CONSENT_SCOPE_MISSING',
  'EDUCATION_INVALID',
  'DATE_OCCUPIED',
] as const;
export type HorizonBlockedReason = (typeof HORIZON_BLOCKED_REASONS)[number];

export const HORIZON_FAILED_REASONS = ['SCOPE_LIMIT', 'RETRY_EXHAUSTED'] as const;
export type HorizonFailedReason = (typeof HORIZON_FAILED_REASONS)[number];

export const HORIZON_RETIRED_REASONS = ['PLAN_ARCHIVED', 'PROFILE_DELETION'] as const;
export type HorizonRetiredReason = (typeof HORIZON_RETIRED_REASONS)[number];

export const HORIZON_OUTCOMES = [
  'GENERATED',
  'RESTORED',
  'NOOP',
  'BLOCKED',
  'FAILED',
  'RETIRED',
  'REQUEUED',
] as const;
export type HorizonOutcome = (typeof HORIZON_OUTCOMES)[number];

export const HORIZON_EXECUTOR_KEY = 'HORIZON_WORKER_V1';
export const HORIZON_REQUEUE_REASON = 'OPERATOR_RETRY_AFTER_DIAGNOSIS';

export const HORIZON_PROTECTED_CANCEL_REASONS = [
  'USER_CANCELLED',
  'SPLIT',
  'PLAN_PAUSED',
  'PLAN_ARCHIVED',
] as const;

export const HORIZON_MAX_ATTEMPTS = 8;
export const HORIZON_MAX_ROOT_SERIES = 100;
export const HORIZON_MAX_LOCK_ROWS = 5000;

export function isSplitChildSeries(
  occurrences: Array<{ sourceOccurrenceId?: string | null }>,
): boolean {
  return occurrences.some((row) => row.sourceOccurrenceId != null);
}

export function isProtectedCancelReason(reason: string | null | undefined): boolean {
  return reason != null && (HORIZON_PROTECTED_CANCEL_REASONS as readonly string[]).includes(reason);
}

export function canRestoreHorizonOccurrence(row: {
  status: string;
  cancelReason: string | null;
  scheduleExceptionAdjustmentId?: string | null;
}): boolean {
  return (
    row.status === 'CANCELLED' &&
    row.cancelReason === 'SERIES_RULE_REMOVED' &&
    row.scheduleExceptionAdjustmentId == null
  );
}

export function stablePlanJitterSeconds(planId: string, salt = ''): number {
  const digest = createHash('sha256').update(`${planId}:${salt}`).digest();
  return digest.readUInt32BE(0) % 600;
}

export function utcFromZonedLocal(localDate: string, timeHms: string, timeZone: string): Date {
  const desired = `${localDate}T${timeHms}`;
  let guess = new Date(`${desired}Z`);
  for (let i = 0; i < 3; i += 1) {
    const formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(guess);
    const part = (type: string) => formatted.find((item) => item.type === type)?.value ?? '00';
    const actual = `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
    const delta = Date.parse(`${actual}Z`) - Date.parse(`${desired}Z`);
    guess = new Date(guess.getTime() - delta);
  }
  return guess;
}

export function nextHorizonLocalReviewAt(now: Date, timeZone: string, planId: string): Date {
  const today = localDateInTimeZone(now, timeZone);
  const next = addLocalDays(today, 1);
  const base = utcFromZonedLocal(next, '00:05:00', timeZone);
  return new Date(base.getTime() + stablePlanJitterSeconds(planId) * 1000);
}

export function horizonBackoffMs(nextAttempt: number, planId: string): number {
  const exp = Math.min(5000 * 2 ** Math.max(nextAttempt - 1, 0), 15 * 60 * 1000);
  const jitter = createHash('sha256').update(`${planId}:backoff:${nextAttempt}`).digest().readUInt16BE(0) % 1000;
  return exp + jitter;
}

export function classifyHorizonDateOccupation(input: {
  wantedKeys: string[];
  existingByKey: Map<string, { scheduledLocalDate: string }>;
  occupyingByDate: Map<string, { occurrenceKey: string }>;
}): { missing: string[]; occupied: string[] } {
  const missing: string[] = [];
  const occupied: string[] = [];
  for (const key of input.wantedKeys) {
    if (input.existingByKey.has(key)) {
      continue;
    }
    const occupant = input.occupyingByDate.get(key);
    if (occupant && occupant.occurrenceKey !== key) {
      occupied.push(key);
      continue;
    }
    missing.push(key);
  }
  return { missing, occupied };
}
