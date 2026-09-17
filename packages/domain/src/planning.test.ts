import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  datesToMaterializeForPlan,
  missingOccurrenceDates,
  expandSeriesOccurrences,
  horizonWindow,
  isoWeekdayFromLocalDate,
  localDateInTimeZone,
  manualPreviewCanonicalPayload,
  normalizePreviewTasks,
  canRescheduleOccurrence,
  occurrenceCancellableOnPlanHalt,
  occurrenceRestorableOnResume,
  planAllowsOccurrenceGeneration,
  previewCanonicalPayload,
  rescheduleTargetAllowed,
  scheduledDateConflicts,
  resolvePlanStatusTransition,
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

  it('keeps manual preview fingerprints distinct from template imports', () => {
    const series = normalizePreviewTasks(
      [{ name: '自主阅读', subject: '自定义', standard: '完成' }],
      'DAILY',
      '2026-09-17',
    );
    const education = {
      gradeConfigId: 'g1',
      gradeConfigVersionId: 'v1',
      catalogEntryKey: '',
      timezone: 'Asia/Shanghai',
    };
    expect(manualPreviewCanonicalPayload({ education, series }).source).toBe('MANUAL');
    expect(previewCanonicalPayload({ templateId: 't1', templateVersion: '1', education, series })).not.toHaveProperty(
      'source',
    );
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
    expect(guardianMay('ACTIVE', 'PLAN_UPDATE')).toBe(true);
    expect(studentMay('ACTIVE', 'PLAN_UPDATE')).toBe(true);
    expect(studentMay('ACTIVE', 'PLAN_CREATE')).toBe(true);
    expect(studentMay('ONBOARDING', 'PLAN_CREATE')).toBe(false);
    expect(studentMay('ACTIVE', 'PROFILE_UPDATE_AGE')).toBe(false);
  });
});

describe('STP 006 plan status transitions', () => {
  const daily = {
    name: '阅读',
    subject: '自定义',
    completionStandard: '完成',
    durationMinutes: null,
    steps: [],
    repeatKind: 'DAILY' as const,
    weekdays: null,
    startLocalDate: '2026-09-17',
    endLocalDate: null,
    ongoing: true,
  };

  it('allows pause, resume and archive, and rejects unarchive', () => {
    expect(resolvePlanStatusTransition('ACTIVE', 'PAUSE')).toEqual({
      ok: true,
      next: 'PAUSED',
      reasonCode: 'PLAN_PAUSED',
    });
    expect(resolvePlanStatusTransition('PAUSED', 'RESUME')).toEqual({
      ok: true,
      next: 'ACTIVE',
      reasonCode: 'PLAN_RESUMED',
    });
    expect(resolvePlanStatusTransition('ACTIVE', 'ARCHIVE')).toMatchObject({ ok: true, next: 'ARCHIVED' });
    expect(resolvePlanStatusTransition('PAUSED', 'ARCHIVE')).toMatchObject({ ok: true, next: 'ARCHIVED' });
    expect(resolvePlanStatusTransition('ARCHIVED', 'RESUME')).toEqual({ ok: false, code: 'PLAN_STATUS_INVALID' });
    expect(resolvePlanStatusTransition('ARCHIVED', 'PAUSE')).toEqual({ ok: false, code: 'PLAN_STATUS_INVALID' });
    expect(resolvePlanStatusTransition('PAUSED', 'PAUSE')).toEqual({ ok: false, code: 'PLAN_STATUS_INVALID' });
    expect(resolvePlanStatusTransition('ACTIVE', 'RESUME')).toEqual({ ok: false, code: 'PLAN_STATUS_INVALID' });
  });

  it('does not materialize occurrences while paused or archived', () => {
    expect(planAllowsOccurrenceGeneration('ACTIVE')).toBe(true);
    expect(planAllowsOccurrenceGeneration('PAUSED')).toBe(false);
    expect(planAllowsOccurrenceGeneration('ARCHIVED')).toBe(false);
    expect(datesToMaterializeForPlan('ACTIVE', daily, '2026-09-17').length).toBeGreaterThan(0);
    expect(datesToMaterializeForPlan('PAUSED', daily, '2026-09-17')).toEqual([]);
    expect(datesToMaterializeForPlan('ARCHIVED', daily, '2026-09-17')).toEqual([]);
    expect(missingOccurrenceDates('ACTIVE', daily, '2026-09-17', datesToMaterializeForPlan('ACTIVE', daily, '2026-09-17'))).toEqual(
      [],
    );
    expect(missingOccurrenceDates('ACTIVE', daily, '2026-09-18', ['2026-09-18'])).toContain('2026-10-01');
    expect(missingOccurrenceDates('PAUSED', daily, '2026-09-18', [])).toEqual([]);
  });

  it('cancels future planned rows and restores PLAN_PAUSED rows from today onward', () => {
    expect(occurrenceCancellableOnPlanHalt('PLANNED', '2026-09-17', '2026-09-17')).toBe(true);
    expect(occurrenceCancellableOnPlanHalt('PLANNED', '2026-09-16', '2026-09-17')).toBe(false);
    expect(occurrenceCancellableOnPlanHalt('COMPLETED', '2026-09-18', '2026-09-17')).toBe(false);
    expect(
      occurrenceRestorableOnResume({
        status: 'CANCELLED',
        cancelReason: 'PLAN_PAUSED',
        scheduledLocalDate: '2026-09-20',
        todayLocalDate: '2026-09-18',
      }),
    ).toBe(true);
    expect(
      occurrenceRestorableOnResume({
        status: 'CANCELLED',
        cancelReason: 'PLAN_PAUSED',
        scheduledLocalDate: '2026-10-20',
        todayLocalDate: '2026-09-18',
      }),
    ).toBe(true);
    expect(
      occurrenceRestorableOnResume({
        status: 'CANCELLED',
        cancelReason: 'PLAN_ARCHIVED',
        scheduledLocalDate: '2026-09-20',
        todayLocalDate: '2026-09-18',
      }),
    ).toBe(false);
    expect(
      occurrenceRestorableOnResume({
        status: 'CANCELLED',
        cancelReason: 'PLAN_PAUSED',
        scheduledLocalDate: '2026-09-10',
        todayLocalDate: '2026-09-18',
      }),
    ).toBe(false);
  });

  it('allows only planned active occurrences to move to a free future date', () => {
    expect(canRescheduleOccurrence('ACTIVE', 'PLANNED')).toBe(true);
    expect(canRescheduleOccurrence('PAUSED', 'PLANNED')).toBe(false);
    expect(canRescheduleOccurrence('ACTIVE', 'CANCELLED')).toBe(false);
    expect(rescheduleTargetAllowed('2026-09-18', '2026-09-18')).toBe(true);
    expect(rescheduleTargetAllowed('2026-09-18', '2026-10-20')).toBe(true);
    expect(rescheduleTargetAllowed('2026-09-18', '2026-09-17')).toBe(false);
    expect(
      scheduledDateConflicts('2026-09-20', 'self', [
        { id: 'self', scheduledLocalDate: '2026-09-18' },
        { id: 'other', scheduledLocalDate: '2026-09-20' },
      ]),
    ).toBe(true);
    expect(
      scheduledDateConflicts('2026-09-21', 'self', [
        { id: 'self', scheduledLocalDate: '2026-09-18' },
        { id: 'other', scheduledLocalDate: '2026-09-20' },
      ]),
    ).toBe(false);
  });
});
