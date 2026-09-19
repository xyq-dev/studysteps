import { describe, expect, it } from 'vitest';
import {
  canRestoreHorizonOccurrence,
  classifyHorizonDateOccupation,
  horizonBackoffMs,
  isProtectedCancelReason,
  isSplitChildSeries,
  nextHorizonLocalReviewAt,
  stablePlanJitterSeconds,
  utcFromZonedLocal,
} from './horizon-job.js';

describe('horizon job domain rules', () => {
  it('recognizes split-child series by sourceOccurrenceId, not ONCE', () => {
    expect(isSplitChildSeries([{ sourceOccurrenceId: null }])).toBe(false);
    expect(isSplitChildSeries([{ sourceOccurrenceId: 'parent-1' }])).toBe(true);
    expect(isSplitChildSeries([])).toBe(false);
  });

  it('protects cancel reasons and only restores SERIES_RULE_REMOVED without schedule exception', () => {
    expect(isProtectedCancelReason('USER_CANCELLED')).toBe(true);
    expect(isProtectedCancelReason('SPLIT')).toBe(true);
    expect(canRestoreHorizonOccurrence({
      status: 'CANCELLED',
      cancelReason: 'SERIES_RULE_REMOVED',
      scheduleExceptionAdjustmentId: null,
    })).toBe(true);
    expect(canRestoreHorizonOccurrence({
      status: 'CANCELLED',
      cancelReason: 'SPLIT',
      scheduleExceptionAdjustmentId: null,
    })).toBe(false);
    expect(canRestoreHorizonOccurrence({
      status: 'CANCELLED',
      cancelReason: 'SERIES_RULE_REMOVED',
      scheduleExceptionAdjustmentId: 'adj',
    })).toBe(false);
  });

  it('treats a different original key on the same series date as occupied', () => {
    const result = classifyHorizonDateOccupation({
      wantedKeys: ['2026-09-20', '2026-09-21'],
      existingByKey: new Map([['2026-09-20', { scheduledLocalDate: '2026-09-20' }]]),
      occupyingByDate: new Map([
        ['2026-09-20', { occurrenceKey: '2026-09-20' }],
        ['2026-09-21', { occurrenceKey: '2026-09-10' }],
      ]),
    });
    expect(result.missing).toEqual([]);
    expect(result.occupied).toEqual(['2026-09-21']);
  });

  it('schedules the next review on the next local day, not UTC+24h', () => {
    const now = new Date('2026-09-18T16:30:00.000Z');
    const next = nextHorizonLocalReviewAt(now, 'Asia/Shanghai', '11111111-1111-1111-1111-111111111111');
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(next);
    expect(local.startsWith('2026-09-20')).toBe(true);
    expect(utcFromZonedLocal('2026-09-19', '00:05:00', 'Asia/Shanghai').toISOString()).toBe(
      '2026-09-18T16:05:00.000Z',
    );
    expect(stablePlanJitterSeconds('11111111-1111-1111-1111-111111111111')).toBeLessThan(600);
    expect(horizonBackoffMs(1, 'plan')).toBeGreaterThanOrEqual(5000);
    expect(horizonBackoffMs(8, 'plan')).toBeLessThanOrEqual(15 * 60 * 1000 + 999);
  });
});
