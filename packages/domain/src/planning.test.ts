import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  expandSeriesOccurrences,
  horizonWindow,
  isoWeekdayFromLocalDate,
  localDateInTimeZone,
  normalizePreviewTasks,
} from './planning.js';
import { consentCoversPlanWrites, TEST_POLICY_V1_SCOPE, TEST_POLICY_V2_SCOPE } from './consent-scope.js';
import { guardianMay, studentMay } from './permissions.js';

describe('STP 006 horizon and repeat expansion', () => {
  it('uses an inclusive 14-day window in the student timezone', () => {
    const today = localDateInTimeZone(new Date('2026-09-17T16:00:00.000Z'), 'Asia/Shanghai');
    expect(today).toBe('2026-09-18');
    const window = horizonWindow(today, null);
    expect(window.from).toBe('2026-09-18');
    expect(window.to).toBe(addLocalDays('2026-09-18', 13));
  });

  it('does not force 14 occurrences; weekly days only hit matching weekdays', () => {
    const window = horizonWindow('2026-09-14', null);
    const dates = expandSeriesOccurrences(
      {
        name: '周练',
        subject: '自定义',
        completionStandard: '完成',
        durationMinutes: null,
        steps: [],
        repeatKind: 'WEEKLY_DAYS',
        weekdays: [1, 3],
        startLocalDate: '2026-09-14',
        endLocalDate: null,
        ongoing: true,
      },
      window,
    );
    expect(dates.length).toBeLessThan(14);
    expect(dates.every((day) => [1, 3].includes(isoWeekdayFromLocalDate(day)))).toBe(true);
  });

  it('keeps occurrence keys as the original local date of that series', () => {
    const dates = expandSeriesOccurrences(
      {
        name: '一次',
        subject: '自定义',
        completionStandard: '完成',
        durationMinutes: null,
        steps: [],
        repeatKind: 'ONCE',
        weekdays: null,
        startLocalDate: '2026-09-20',
        endLocalDate: '2026-09-20',
        ongoing: false,
      },
      horizonWindow('2026-09-17', null),
    );
    expect(dates).toEqual(['2026-09-20']);
  });

  it('normalizes empty preview as invalid', () => {
    expect(() => normalizePreviewTasks([], 'DAILY', '2026-09-17')).toThrow(/PREVIEW_EMPTY/);
  });
});

describe('STP 006 consent purpose vs actions', () => {
  it('does not treat v1 scope as covering plan writes', () => {
    expect(consentCoversPlanWrites(JSON.stringify(TEST_POLICY_V1_SCOPE))).toBe(false);
    expect(consentCoversPlanWrites(JSON.stringify(TEST_POLICY_V2_SCOPE))).toBe(true);
  });

  it('denies plan create on ONBOARDING and RESTRICTED', () => {
    expect(guardianMay('ACTIVE', 'PLAN_CREATE')).toBe(true);
    expect(guardianMay('ONBOARDING', 'PLAN_CREATE')).toBe(false);
    expect(guardianMay('RESTRICTED', 'PLAN_READ')).toBe(false);
    expect(studentMay('ACTIVE', 'PLAN_CREATE')).toBe(true);
    expect(studentMay('ONBOARDING', 'PLAN_CREATE')).toBe(false);
    expect(studentMay('ACTIVE', 'PROFILE_UPDATE_AGE')).toBe(false);
  });
});
