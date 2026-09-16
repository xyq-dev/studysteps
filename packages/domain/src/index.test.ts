import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decideAgeBand,
  domainBoundary,
  guardianMay,
  studentMayReadSelf,
  isExpired,
  nextAttemptState,
  normalizeMainlandMobile,
  normalizePairingCode,
  replayWithdrawEffect,
  canWriteLastSeen,
  sessionInvalidReason,
  shouldRestrictAfterWithdraw,
} from './index.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('@studysteps/domain export boundary', () => {
  it('exports a framework-free boundary marker', () => {
    expect(domainBoundary()).toBe('domain');
  });

  it('does not declare framework or I/O runtime dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});

describe('phone and age rules', () => {
  it('normalizes mainland mobiles and rejects other shapes', () => {
    expect(normalizeMainlandMobile('138-0013-8000')).toBe('+8613800138000');
    expect(normalizeMainlandMobile('+86 13900139000')).toBe('+8613900139000');
    expect(normalizeMainlandMobile('+1 2025551234')).toBeNull();
    expect(normalizeMainlandMobile('1380013800a')).toBeNull();
  });

  it('rejects unconfirmed and adult bands for formal profiles', () => {
    expect(decideAgeBand('UNCONFIRMED').ok).toBe(false);
    expect(decideAgeBand('AGE_18_PLUS')).toEqual({
      ok: false,
      code: 'AGE_BAND_NOT_SUPPORTED',
    });
    expect(decideAgeBand('UNDER_14')).toEqual({
      ok: true,
      band: 'UNDER_14',
      policyKey: 'TEST_CHILD_CORE_SERVICE',
    });
  });
});

describe('permissions, session and withdraw replay', () => {
  it('blocks student mode after restriction', () => {
    expect(guardianMay('RESTRICTED', 'STUDENT_MODE_CREATE')).toBe(false);
    expect(guardianMay('RESTRICTED', 'CONSENT_GRANT')).toBe(true);
    expect(guardianMay('ONBOARDING', 'PAIRING_CREATE')).toBe(true);
    expect(guardianMay('ACTIVE', 'PAIRING_CREATE')).toBe(true);
    expect(guardianMay('DELETION_PENDING', 'PROFILE_READ')).toBe(false);
    expect(guardianMay('DELETED', 'CONSENT_GRANT')).toBe(false);
  });

  it('lets students read ONBOARDING and ACTIVE selves only', () => {
    expect(studentMayReadSelf('ONBOARDING')).toBe(true);
    expect(studentMayReadSelf('ACTIVE')).toBe(true);
    expect(studentMayReadSelf('RESTRICTED')).toBe(false);
    expect(studentMayReadSelf('DELETION_PENDING')).toBe(false);
    expect(studentMayReadSelf('DELETED')).toBe(false);
  });

  it('does not refresh lastSeen before the throttle window', () => {
    const lastSeenAt = new Date('2026-09-14T00:00:00.000Z');
    expect(canWriteLastSeen(lastSeenAt, new Date('2026-09-14T00:00:30.000Z'), 60_000)).toBe(false);
    expect(canWriteLastSeen(lastSeenAt, new Date('2026-09-14T00:01:00.000Z'), 60_000)).toBe(true);
  });

  it('treats idle and absolute boundaries as expired', () => {
    const createdAt = new Date('2026-09-14T00:00:00.000Z');
    const clock = { now: () => new Date('2026-09-14T02:00:00.000Z') };
    expect(
      sessionInvalidReason(
        {
          createdAt,
          lastSeenAt: createdAt,
          expiresAt: new Date('2026-09-15T00:00:00.000Z'),
          revokedAt: null,
          absoluteMs: 24 * 60 * 60 * 1000,
          idleMs: 2 * 60 * 60 * 1000,
        },
        clock,
      ),
    ).toBe('IDLE');
    expect(isExpired(new Date('2026-09-14T00:05:00.000Z'), new Date('2026-09-14T00:05:00.000Z'))).toBe(
      true,
    );
    const now = new Date('2026-09-14T00:05:00.000Z');
    expect(
      sessionInvalidReason(
        {
          createdAt: new Date('2026-09-13T00:05:00.000Z'),
          lastSeenAt: now,
          expiresAt: now,
          revokedAt: null,
          absoluteMs: 24 * 60 * 60 * 1000,
          idleMs: 2 * 60 * 60 * 1000,
        },
        { now: () => now },
      ),
    ).toBe('ABSOLUTE');
  });

  it('does not re-apply withdraw side effects to an already withdrawn record', () => {
    expect(
      replayWithdrawEffect({
        id: 'c1',
        withdrawnAt: new Date('2026-09-14T00:00:00.000Z'),
        supersededAt: null,
      }),
    ).toBe('NOOP');
    expect(shouldRestrictAfterWithdraw(1)).toBe(false);
    expect(shouldRestrictAfterWithdraw(0)).toBe(true);
  });

  it('locks a credential after the last failed attempt and rejects a later correct guess', () => {
    expect(nextAttemptState(4, 5, false)).toEqual({
      attemptCount: 5,
      locked: true,
      accepted: false,
    });
    expect(nextAttemptState(5, 5, true)).toEqual({
      attemptCount: 5,
      locked: true,
      accepted: false,
    });
    expect(normalizePairingCode('7K9M-2P4R')).toBe('7K9M2P4R');
  });
});
