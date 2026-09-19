import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  canRestoreHorizonOccurrence,
  classifyHorizonDateOccupation,
  contentFromRevision,
  datesToMaterializeForPlan,
  datesToMaterializeFromRevisions,
  HORIZON_MAX_LOCK_ROWS,
  HORIZON_MAX_ROOT_SERIES,
  horizonWindow,
  isSplitChildSeries,
  localDateInTimeZone,
  planAllowsOccurrenceGeneration,
  selectEffectiveRevision,
  type HorizonBlockedReason,
  type HorizonFailedReason,
  type SeriesRevisionRecord,
  type SeriesRule,
} from '@studysteps/domain';

type Tx = Prisma.TransactionClient;

export type HorizonCoreSkip = {
  reason: 'NO_PLAN' | 'PLAN_PAUSED' | 'PLAN_ARCHIVED' | 'ALREADY_EXISTS' | 'SERIES_ENDED' | 'NO_DATES_IN_WINDOW' | 'SPLIT_CHILD';
  planId?: string;
  seriesId?: string;
};

export type HorizonCoreResult = {
  from: string;
  to: string;
  insertedCount: number;
  restoredCount: number;
  alreadyPresentCount: number;
  protectedCount: number;
  skipped: HorizonCoreSkip[];
  blocked?: { reason: HorizonBlockedReason };
  failed?: { reason: HorizonFailedReason };
};

type OccurrenceSnapshot = {
  timezone: string;
  gradeConfigId: string;
  gradeConfigVersionId: string;
  stageCode: string;
  schoolSystemCode: string;
  gradeCode: string;
  gradeLabel: string;
  termCode: string;
  catalogEntryKey: string;
  name: string;
  subject: string;
  completionStandard: string;
  durationMinutes: number | null;
  stepsJson: string;
  contentRevisionNo?: number;
  scheduleRevisionNo?: number;
};

type HorizonSeries = {
  id: string;
  name: string;
  subject: string;
  completionStandard: string;
  durationMinutes: number | null;
  stepsJson: string;
  repeatKind: string;
  weekdaysJson: string | null;
  startLocalDate: string;
  endLocalDate: string | null;
  ongoing: boolean;
  occurrences: Array<{
    id: string;
    occurrenceKey: string;
    scheduledLocalDate: string;
    status: string;
    cancelReason: string | null;
    version: number;
    contentRevisionNo: number;
    scheduleRevisionNo: number;
    contentExceptionAdjustmentId: string | null;
    scheduleExceptionAdjustmentId: string | null;
    sourceOccurrenceId: string | null;
    nameSnapshot: string;
    subjectSnapshot: string;
    completionStandardSnapshot: string;
    durationMinutesSnapshot: number | null;
    stepsSnapshotJson: string;
  }>;
  revisions?: Array<{
    revisionNo: number;
    changeKind: string;
    effectiveFromOccurrenceKey: string;
    name: string | null;
    subject: string | null;
    completionStandard: string | null;
    durationMinutes: number | null;
    stepsJson: string | null;
    repeatKind: string | null;
    weekdaysJson: string | null;
    endLocalDate: string | null;
    ongoing: boolean | null;
  }>;
};

@Injectable()
export class TaskHorizonCoreService {
  async reconcilePlanLocked(
    tx: Tx,
    input: {
      student: {
        id: string;
        timezone: string;
        stageCode: string;
        schoolSystemCode: string;
        gradeCode: string;
        gradeLabel: string;
        termCode: string;
        gradeConfigId: string;
        gradeConfigVersionId: string;
      };
      plan: {
        id: string;
        status: string;
        series: HorizonSeries[];
      };
      now: Date;
    },
  ): Promise<HorizonCoreResult> {
    const today = localDateInTimeZone(input.now, input.student.timezone);
    const window = horizonWindow(today, null);
    const skipped: HorizonCoreSkip[] = [];
    if (!planAllowsOccurrenceGeneration(input.plan.status)) {
      return {
        from: window.from,
        to: window.to,
        insertedCount: 0,
        restoredCount: 0,
        alreadyPresentCount: 0,
        protectedCount: 0,
        skipped: [
          {
            reason: input.plan.status === 'PAUSED' ? 'PLAN_PAUSED' : 'PLAN_ARCHIVED',
            planId: input.plan.id,
          },
        ],
      };
    }

    const rootSeries = input.plan.series.filter((series) => !isSplitChildSeries(series.occurrences));
    if (rootSeries.length > HORIZON_MAX_ROOT_SERIES) {
      return emptyFailed(window, 'SCOPE_LIMIT');
    }

    const gradeVersion = await tx.gradeConfigVersion.findUnique({
      where: { id: input.student.gradeConfigVersionId },
    });
    const snapshotBase = {
      timezone: input.student.timezone,
      gradeConfigId: input.student.gradeConfigId,
      gradeConfigVersionId: input.student.gradeConfigVersionId,
      stageCode: input.student.stageCode,
      schoolSystemCode: input.student.schoolSystemCode,
      gradeCode: input.student.gradeCode,
      gradeLabel: input.student.gradeLabel,
      termCode: input.student.termCode,
      catalogEntryKey: gradeVersion?.catalogEntryKey ?? '',
    };

    let insertedCount = 0;
    let restoredCount = 0;
    let alreadyPresentCount = 0;
    let protectedCount = 0;
    const lockRowIds = new Set<string>();
    const planned: Array<{
      series: HorizonSeries;
      revisions: SeriesRevisionRecord[];
      restorable: HorizonSeries['occurrences'];
      missing: string[];
    }> = [];

    for (const series of input.plan.series) {
      if (isSplitChildSeries(series.occurrences)) {
        skipped.push({ reason: 'SPLIT_CHILD', planId: input.plan.id, seriesId: series.id });
        continue;
      }
      const revisions = (series.revisions ?? []).map((item) => asRevision(item));
      const wanted = revisions.length
        ? datesToMaterializeFromRevisions(input.plan.status, revisions, today)
        : datesToMaterializeForPlan(input.plan.status, ruleFromSeries(series), today);
      if (wanted.length === 0) {
        const rule = ruleFromSeries(series);
        skipped.push({
          reason: rule.endLocalDate != null && rule.endLocalDate < today ? 'SERIES_ENDED' : 'NO_DATES_IN_WINDOW',
          planId: input.plan.id,
          seriesId: series.id,
        });
        continue;
      }
      const existingByKey = new Map(series.occurrences.map((row) => [row.occurrenceKey, row]));
      const occupyingByDate = new Map(series.occurrences.map((row) => [row.scheduledLocalDate, row]));
      for (const row of series.occurrences) {
        if (wanted.includes(row.occurrenceKey) || wanted.includes(row.scheduledLocalDate)) {
          lockRowIds.add(row.id);
        }
      }
      if (lockRowIds.size + rootSeries.length > HORIZON_MAX_LOCK_ROWS) {
        return emptyFailed(window, 'SCOPE_LIMIT');
      }
      const classified = classifyHorizonDateOccupation({
        wantedKeys: wanted,
        existingByKey,
        occupyingByDate,
      });
      if (classified.occupied.length > 0) {
        return {
          from: window.from,
          to: window.to,
          insertedCount: 0,
          restoredCount: 0,
          alreadyPresentCount: 0,
          protectedCount: 0,
          skipped,
          blocked: { reason: 'DATE_OCCUPIED' },
        };
      }
      const restorable = wanted
        .map((day) => existingByKey.get(day))
        .filter((row): row is NonNullable<typeof row> => !!row && canRestoreHorizonOccurrence(row));
      const protectedRows = wanted
        .map((day) => existingByKey.get(day))
        .filter(
          (row): row is NonNullable<typeof row> =>
            !!row && row.status === 'CANCELLED' && !canRestoreHorizonOccurrence(row),
        );
      protectedCount += protectedRows.length;
      const present = wanted.filter((day) => existingByKey.has(day) && !restorable.some((row) => row.occurrenceKey === day));
      alreadyPresentCount += present.length;
      if (classified.missing.length === 0 && restorable.length === 0) {
        skipped.push({ reason: 'ALREADY_EXISTS', planId: input.plan.id, seriesId: series.id });
        continue;
      }
      planned.push({ series, revisions, restorable, missing: classified.missing });
    }

    for (const item of planned) {
      const { series, revisions, restorable } = item;
      for (const existing of restorable) {
        const contentRev = revisions.length
          ? selectEffectiveRevision(revisions, ['BASELINE', 'CONTENT'], existing.occurrenceKey)
          : null;
        const scheduleRev = revisions.length
          ? selectEffectiveRevision(revisions, ['BASELINE', 'SCHEDULE'], existing.occurrenceKey)
          : null;
        const content = contentRev
          ? contentFromRevision(contentRev)
          : {
              name: existing.nameSnapshot,
              subject: existing.subjectSnapshot,
              completionStandard: existing.completionStandardSnapshot,
              durationMinutes: existing.durationMinutesSnapshot,
              steps: JSON.parse(existing.stepsSnapshotJson) as string[],
            };
        await tx.taskOccurrence.update({
          where: { id: existing.id, version: existing.version },
          data: {
            status: 'PLANNED',
            cancelReason: null,
            scheduleRevisionNo: scheduleRev?.revisionNo ?? existing.scheduleRevisionNo,
            version: existing.version + 1,
            ...(existing.contentExceptionAdjustmentId
              ? {}
              : {
                  nameSnapshot: content.name,
                  subjectSnapshot: content.subject,
                  completionStandardSnapshot: content.completionStandard,
                  durationMinutesSnapshot: content.durationMinutes,
                  stepsSnapshotJson: JSON.stringify(content.steps),
                  contentRevisionNo: contentRev?.revisionNo ?? existing.contentRevisionNo,
                }),
          },
        });
        restoredCount += 1;
      }
      for (const localDate of item.missing) {
        const contentRev = revisions.length
          ? selectEffectiveRevision(revisions, ['BASELINE', 'CONTENT'], localDate)
          : null;
        const scheduleRev = revisions.length
          ? selectEffectiveRevision(revisions, ['BASELINE', 'SCHEDULE'], localDate)
          : null;
        const content = contentRev
          ? contentFromRevision(contentRev)
          : {
              name: series.name,
              subject: series.subject,
              completionStandard: series.completionStandard,
              durationMinutes: series.durationMinutes,
              steps: JSON.parse(series.stepsJson) as string[],
            };
        await this.insertOccurrence(tx, series.id, localDate, {
          ...snapshotBase,
          name: content.name,
          subject: content.subject,
          completionStandard: content.completionStandard,
          durationMinutes: content.durationMinutes,
          stepsJson: JSON.stringify(content.steps),
          contentRevisionNo: contentRev?.revisionNo ?? 1,
          scheduleRevisionNo: scheduleRev?.revisionNo ?? 1,
        });
        insertedCount += 1;
      }
    }

    return {
      from: window.from,
      to: window.to,
      insertedCount,
      restoredCount,
      alreadyPresentCount,
      protectedCount,
      skipped,
    };
  }

  private async insertOccurrence(tx: Tx, seriesId: string, localDate: string, snapshot: OccurrenceSnapshot) {
    await tx.taskOccurrence.create({
      data: {
        seriesId,
        occurrenceKey: localDate,
        originalLocalDate: localDate,
        scheduledLocalDate: localDate,
        timezoneSnapshot: snapshot.timezone,
        status: 'PLANNED',
        nameSnapshot: snapshot.name,
        subjectSnapshot: snapshot.subject,
        completionStandardSnapshot: snapshot.completionStandard,
        durationMinutesSnapshot: snapshot.durationMinutes,
        stepsSnapshotJson: snapshot.stepsJson,
        gradeConfigId: snapshot.gradeConfigId,
        gradeConfigVersionId: snapshot.gradeConfigVersionId,
        stageCodeSnapshot: snapshot.stageCode,
        schoolSystemCodeSnapshot: snapshot.schoolSystemCode,
        gradeCodeSnapshot: snapshot.gradeCode,
        gradeLabelSnapshot: snapshot.gradeLabel,
        termCodeSnapshot: snapshot.termCode,
        catalogEntryKeySnapshot: snapshot.catalogEntryKey,
        contentRevisionNo: snapshot.contentRevisionNo ?? 1,
        scheduleRevisionNo: snapshot.scheduleRevisionNo ?? 1,
      },
    });
  }
}

function emptyFailed(window: { from: string; to: string }, reason: HorizonFailedReason): HorizonCoreResult {
  return {
    from: window.from,
    to: window.to,
    insertedCount: 0,
    restoredCount: 0,
    alreadyPresentCount: 0,
    protectedCount: 0,
    skipped: [],
    failed: { reason },
  };
}

function ruleFromSeries(series: HorizonSeries): SeriesRule {
  return {
    name: series.name,
    subject: series.subject,
    completionStandard: series.completionStandard,
    durationMinutes: series.durationMinutes,
    steps: JSON.parse(series.stepsJson) as string[],
    repeatKind: series.repeatKind as SeriesRule['repeatKind'],
    weekdays: series.weekdaysJson ? (JSON.parse(series.weekdaysJson) as SeriesRule['weekdays']) : null,
    startLocalDate: series.startLocalDate,
    endLocalDate: series.endLocalDate,
    ongoing: series.ongoing,
  };
}

function asRevision(row: NonNullable<HorizonSeries['revisions']>[number]): SeriesRevisionRecord {
  return {
    revisionNo: row.revisionNo,
    changeKind: row.changeKind as SeriesRevisionRecord['changeKind'],
    effectiveFromOccurrenceKey: row.effectiveFromOccurrenceKey,
    name: row.name,
    subject: row.subject,
    completionStandard: row.completionStandard,
    durationMinutes: row.durationMinutes,
    stepsJson: row.stepsJson,
    repeatKind: row.repeatKind,
    weekdaysJson: row.weekdaysJson,
    endLocalDate: row.endLocalDate,
    ongoing: row.ongoing,
  };
}
