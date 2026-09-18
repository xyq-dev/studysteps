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
  canAdjustOccurrence,
  canAnchorFutureChange,
  canRescheduleOccurrence,
  classifyFutureContentEffect,
  classifyFutureScheduleEffect,
  contentFromRevision,
  datesToMaterializeFromRevisions,
  futureContentProjectionUnchanged,
  futureScheduleAddedDates,
  futureScheduleConflictCandidateDates,
  futureScheduleInsertConflicts,
  futureScheduleProjectionUnchanged,
  futureScheduleShapeErrors,
  keyHitsEffectiveSchedule,
  occurrenceScheduleEquals,
  scheduleFromRevision,
  scheduleRevisionFromProposal,
  selectEffectiveRevision,
  occurrenceContentDiff,
  occurrenceContentEquals,
  occurrenceContentFromSnapshots,
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
    expect(canAdjustOccurrence('ACTIVE', 'PLANNED')).toBe(true);
    expect(canAdjustOccurrence('PAUSED', 'PLANNED')).toBe(false);
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

  it('compares occurrence content snapshots without treating date as a content field', () => {
    const current = occurrenceContentFromSnapshots({
      nameSnapshot: '朗读',
      subjectSnapshot: '语文',
      completionStandardSnapshot: '读完一页',
      durationMinutesSnapshot: 20,
      stepsSnapshotJson: '["先读","再复述"]',
    });
    expect(
      occurrenceContentEquals(current, {
        name: '朗读',
        subject: '语文',
        completionStandard: '读完一页',
        durationMinutes: 20,
        steps: ['先读', '再复述'],
      }),
    ).toBe(true);
    expect(
      occurrenceContentDiff(current, {
        name: '朗读加长',
        subject: '语文',
        completionStandard: '读完两页',
        durationMinutes: null,
        steps: ['先读'],
      }),
    ).toEqual([
      { field: 'name', from: '朗读', to: '朗读加长' },
      { field: 'completionStandard', from: '读完一页', to: '读完两页' },
      { field: 'durationMinutes', from: 20, to: null },
      { field: 'steps', from: ['先读', '再复述'], to: ['先读'] },
    ]);
  });

  it('selects the highest eligible revision independently for content and schedule', () => {
    const revisions = [
      {
        revisionNo: 1,
        changeKind: 'BASELINE' as const,
        effectiveFromOccurrenceKey: '2026-09-10',
        name: '朗读',
        subject: '语文',
        completionStandard: '读完一页',
        durationMinutes: 20,
        stepsJson: '[]',
        repeatKind: 'DAILY',
        weekdaysJson: null,
        endLocalDate: null,
        ongoing: true,
      },
      {
        revisionNo: 2,
        changeKind: 'CONTENT' as const,
        effectiveFromOccurrenceKey: '2026-09-20',
        name: '晚改',
        subject: '语文',
        completionStandard: '读完一页',
        durationMinutes: 20,
        stepsJson: '[]',
        repeatKind: null,
        weekdaysJson: null,
        endLocalDate: null,
        ongoing: null,
      },
      {
        revisionNo: 3,
        changeKind: 'CONTENT' as const,
        effectiveFromOccurrenceKey: '2026-09-15',
        name: '早改',
        subject: '语文',
        completionStandard: '读完一页',
        durationMinutes: 20,
        stepsJson: '[]',
        repeatKind: null,
        weekdaysJson: null,
        endLocalDate: null,
        ongoing: null,
      },
    ];
    expect(contentFromRevision(selectEffectiveRevision(revisions, ['BASELINE', 'CONTENT'], '2026-09-14')!).name).toBe(
      '朗读',
    );
    expect(contentFromRevision(selectEffectiveRevision(revisions, ['BASELINE', 'CONTENT'], '2026-09-16')!).name).toBe(
      '早改',
    );
    expect(contentFromRevision(selectEffectiveRevision(revisions, ['BASELINE', 'CONTENT'], '2026-09-21')!).name).toBe(
      '早改',
    );
    expect(keyHitsEffectiveSchedule(revisions, '2026-09-18')).toBe(true);
    expect(datesToMaterializeFromRevisions('ACTIVE', revisions, '2026-09-18').length).toBe(14);
    expect(
      futureContentProjectionUnchanged(revisions, '2026-09-15', {
        name: '早改',
        subject: '语文',
        completionStandard: '读完一页',
        durationMinutes: 20,
        steps: [],
      }),
    ).toBe(true);
    expect(
      canAnchorFutureChange({
        planStatus: 'ACTIVE',
        occurrenceStatus: 'PLANNED',
        occurrenceKey: '2026-09-10',
        scheduledLocalDate: '2026-09-20',
        todayLocalDate: '2026-09-18',
      }),
    ).toBe(false);
    expect(
      classifyFutureContentEffect({
        occurrenceKey: '2026-09-20',
        scheduledLocalDate: '2026-09-20',
        status: 'PLANNED',
        cutoffOccurrenceKey: '2026-09-18',
        todayLocalDate: '2026-09-18',
        hasContentException: true,
        currentContent: { name: '例外', subject: '语文', completionStandard: '读完', durationMinutes: null, steps: [] },
        nextContent: { name: '新规则', subject: '语文', completionStandard: '读完', durationMinutes: null, steps: [] },
      }),
    ).toBe('preserved_exception');
  });

  it('classifies SCHEDULE keep/modify/cancel/restore without treating content exceptions as date exceptions', () => {
    const baseline = {
      revisionNo: 1,
      changeKind: 'BASELINE' as const,
      effectiveFromOccurrenceKey: '2026-09-14',
      name: '朗读',
      subject: '语文',
      completionStandard: '读完一页',
      durationMinutes: 20,
      stepsJson: '[]',
      repeatKind: 'DAILY',
      weekdaysJson: null,
      endLocalDate: null,
      ongoing: true,
    };
    const weekly = scheduleRevisionFromProposal(2, '2026-09-18', {
      repeatKind: 'WEEKLY_DAYS',
      weekdays: [5, 1, 1],
      endLocalDate: null,
      ongoing: true,
    });
    expect(weekly.weekdaysJson).toBe('[1,5]');
    expect(futureScheduleShapeErrors({ repeatKind: 'DAILY', weekdays: [1], endLocalDate: null, ongoing: true }, '2026-09-18')).toEqual({
      weekdays: 'forbidden',
    });
    expect(
      futureScheduleShapeErrors(
        { repeatKind: 'WEEKLY_DAYS', weekdays: [5], endLocalDate: '2026-09-17', ongoing: false },
        '2026-09-18',
      ),
    ).toEqual({ endLocalDate: 'beforeCutoff' });
    const projected = [baseline, weekly];
    expect(keyHitsEffectiveSchedule(projected, '2026-09-18')).toBe(true);
    expect(keyHitsEffectiveSchedule(projected, '2026-09-19')).toBe(false);
    expect(scheduleFromRevision(weekly)?.repeatKind).toBe('WEEKLY_DAYS');
    expect(
      occurrenceScheduleEquals(scheduleFromRevision(weekly)!, {
        repeatKind: 'WEEKLY_DAYS',
        weekdays: [5, 1],
        endLocalDate: null,
        ongoing: true,
      }),
    ).toBe(true);
    expect(futureScheduleProjectionUnchanged([baseline], '2026-09-18', scheduleFromRevision(baseline)!)).toBe(true);
    expect(
      futureScheduleProjectionUnchanged([baseline], '2026-09-18', {
        repeatKind: 'WEEKLY_DAYS',
        weekdays: [1, 5],
        endLocalDate: null,
        ongoing: true,
      }),
    ).toBe(false);
    expect(
      classifyFutureScheduleEffect({
        occurrenceKey: '2026-09-19',
        scheduledLocalDate: '2026-09-19',
        status: 'PLANNED',
        cancelReason: null,
        cutoffOccurrenceKey: '2026-09-18',
        todayLocalDate: '2026-09-18',
        hasScheduleException: false,
        hitsNextSchedule: false,
        scheduleRevisionNo: 1,
        nextScheduleRevisionNo: 2,
        applyScheduleRevision: true,
      }),
    ).toBe('cancelled');
    expect(
      classifyFutureScheduleEffect({
        occurrenceKey: '2026-09-19',
        scheduledLocalDate: '2026-09-21',
        status: 'PLANNED',
        cancelReason: null,
        cutoffOccurrenceKey: '2026-09-18',
        todayLocalDate: '2026-09-18',
        hasScheduleException: true,
        hitsNextSchedule: false,
        scheduleRevisionNo: 1,
        nextScheduleRevisionNo: 2,
        applyScheduleRevision: true,
      }),
    ).toBe('preserved_exception');
    expect(
      classifyFutureScheduleEffect({
        occurrenceKey: '2026-09-18',
        scheduledLocalDate: '2026-09-18',
        status: 'CANCELLED',
        cancelReason: 'SERIES_RULE_REMOVED',
        cutoffOccurrenceKey: '2026-09-18',
        todayLocalDate: '2026-09-18',
        hasScheduleException: false,
        hitsNextSchedule: true,
        scheduleRevisionNo: 1,
        nextScheduleRevisionNo: 2,
        applyScheduleRevision: true,
      }),
    ).toBe('restored');
    expect(
      classifyFutureScheduleEffect({
        occurrenceKey: '2026-09-18',
        scheduledLocalDate: '2026-09-18',
        status: 'CANCELLED',
        cancelReason: 'USER_CANCELLED',
        cutoffOccurrenceKey: '2026-09-18',
        todayLocalDate: '2026-09-18',
        hasScheduleException: false,
        hitsNextSchedule: true,
        scheduleRevisionNo: 1,
        nextScheduleRevisionNo: 2,
        applyScheduleRevision: true,
      }),
    ).toBe('preserved_cancelled');
    expect(
      classifyFutureScheduleEffect({
        occurrenceKey: '2026-09-19',
        scheduledLocalDate: '2026-09-19',
        status: 'PLANNED',
        cancelReason: null,
        cutoffOccurrenceKey: '2026-09-18',
        todayLocalDate: '2026-09-18',
        hasScheduleException: false,
        hitsNextSchedule: false,
        scheduleRevisionNo: 1,
        nextScheduleRevisionNo: 1,
        applyScheduleRevision: false,
      }),
    ).toBe('unchanged');
    const added = futureScheduleAddedDates({
      revisions: projected,
      existingKeys: ['2026-09-18', '2026-09-19'],
      cutoffOccurrenceKey: '2026-09-18',
      todayLocalDate: '2026-09-18',
    });
    expect(added).toEqual(['2026-09-21', '2026-09-25', '2026-09-28']);
    const conflicts = futureScheduleInsertConflicts({
      siblings: [
        {
          id: 'occ-moved',
          occurrenceKey: '2026-09-18',
          scheduledLocalDate: '2026-09-25',
          status: 'COMPLETED',
          cancelReason: null,
        },
      ],
      insertDates: futureScheduleConflictCandidateDates({
        revisions: projected,
        existingKeys: ['2026-09-18', '2026-09-19'],
        siblingScheduledDates: ['2026-09-25'],
        cutoffOccurrenceKey: '2026-09-18',
        todayLocalDate: '2026-09-18',
      }),
    });
    expect(conflicts).toEqual([
      {
        scheduledLocalDate: '2026-09-25',
        occupyingId: 'occ-moved',
        occupyingOccurrenceKey: '2026-09-18',
        occupyingStatus: 'COMPLETED',
        occupyingCancelReason: null,
        reason: 'DATE_OCCUPIED',
      },
    ]);
  });
});
