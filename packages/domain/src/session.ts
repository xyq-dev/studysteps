import { isExpired, type Clock } from './clock.js';

export type SessionTiming = {
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
  absoluteMs: number;
  idleMs: number;
};

export function sessionInvalidReason(
  timing: SessionTiming,
  clock: Clock,
): 'REVOKED' | 'ABSOLUTE' | 'IDLE' | null {
  const now = clock.now();
  if (timing.revokedAt) {
    return 'REVOKED';
  }
  if (isExpired(now, timing.expiresAt)) {
    return 'ABSOLUTE';
  }
  const absoluteDeadline = new Date(timing.createdAt.getTime() + timing.absoluteMs);
  if (isExpired(now, absoluteDeadline)) {
    return 'ABSOLUTE';
  }
  const idleBase = timing.lastSeenAt ?? timing.createdAt;
  if (now.getTime() - idleBase.getTime() >= timing.idleMs) {
    return 'IDLE';
  }
  return null;
}

export function canWriteLastSeen(
  lastSeenAt: Date | null,
  now: Date,
  throttleMs: number,
): boolean {
  if (!lastSeenAt) {
    return true;
  }
  return now.getTime() - lastSeenAt.getTime() >= throttleMs;
}

export function stepUpValid(verifiedAt: Date | null, now: Date, windowMs: number): boolean {
  if (!verifiedAt) {
    return false;
  }
  return now.getTime() - verifiedAt.getTime() < windowMs;
}
