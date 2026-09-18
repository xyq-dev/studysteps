export const REPEAT_KINDS = ['ONCE', 'DAILY', 'WEEKLY_DAYS'] as const;
export type RepeatKind = (typeof REPEAT_KINDS)[number];

export const PLAN_ORIGINS = ['STUDENT', 'GUARDIAN_ASSISTED', 'MANUAL'] as const;
export type PlanOrigin = (typeof PLAN_ORIGINS)[number];

export const PLAN_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_STATUS_ACTIONS = ['PAUSE', 'RESUME', 'ARCHIVE'] as const;
export type PlanStatusAction = (typeof PLAN_STATUS_ACTIONS)[number];

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type SeriesRule = {
  name: string;
  subject: string;
  completionStandard: string;
  durationMinutes: number | null;
  steps: string[];
  repeatKind: RepeatKind;
  weekdays: IsoWeekday[] | null;
  startLocalDate: string;
  endLocalDate: string | null;
  ongoing: boolean;
};

export type HorizonBounds = {
  from: string;
  to: string;
};

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value: string): boolean {
  return LOCAL_DATE.test(value);
}

export function addLocalDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map((part) => Number(part));
  const utc = new Date(Date.UTC(year as number, (month as number) - 1, (day as number) + days));
  return utc.toISOString().slice(0, 10);
}

export function compareLocalDate(left: string, right: string): number {
  return left.localeCompare(right);
}

export function maxLocalDate(left: string, right: string): string {
  return compareLocalDate(left, right) >= 0 ? left : right;
}

export function minLocalDate(left: string, right: string): string {
  return compareLocalDate(left, right) <= 0 ? left : right;
}

export function isoWeekdayFromLocalDate(localDate: string): IsoWeekday {
  const [year, month, day] = localDate.split('-').map((part) => Number(part));
  const utcDay = new Date(Date.UTC(year as number, (month as number) - 1, day as number)).getUTCDay();
  return (utcDay === 0 ? 7 : utcDay) as IsoWeekday;
}

export function localDateInTimeZone(utc: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(utc);
}

export function horizonWindow(
  todayLocalDate: string,
  endLocalDate: string | null,
): HorizonBounds {
  const rawTo = addLocalDays(todayLocalDate, 13);
  const to = endLocalDate && compareLocalDate(endLocalDate, rawTo) < 0 ? endLocalDate : rawTo;
  return { from: todayLocalDate, to };
}

export function clipHorizonToSeries(window: HorizonBounds, rule: SeriesRule): HorizonBounds | null {
  const from = maxLocalDate(window.from, rule.startLocalDate);
  const seriesEnd = rule.ongoing ? window.to : (rule.endLocalDate ?? window.to);
  const to = minLocalDate(window.to, seriesEnd);
  if (compareLocalDate(from, to) > 0) {
    return null;
  }
  return { from, to };
}

function eachLocalDate(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = from;
  while (compareLocalDate(cursor, to) <= 0) {
    dates.push(cursor);
    cursor = addLocalDays(cursor, 1);
  }
  return dates;
}

export function occurrenceKeyForOriginalDate(originalLocalDate: string): string {
  return originalLocalDate;
}

export function expandSeriesOccurrences(rule: SeriesRule, window: HorizonBounds): string[] {
  const clipped = clipHorizonToSeries(window, rule);
  if (!clipped) {
    return [];
  }
  if (rule.repeatKind === 'ONCE') {
    return compareLocalDate(rule.startLocalDate, clipped.from) >= 0 &&
      compareLocalDate(rule.startLocalDate, clipped.to) <= 0
      ? [rule.startLocalDate]
      : [];
  }
  const days = eachLocalDate(clipped.from, clipped.to);
  if (rule.repeatKind === 'DAILY') {
    return days;
  }
  const weekdays = new Set(rule.weekdays ?? []);
  return days.filter((day) => weekdays.has(isoWeekdayFromLocalDate(day)));
}

export function defaultRepeatForTemplateKind(kind: string): Pick<SeriesRule, 'repeatKind' | 'weekdays'> {
  if (kind === 'WEEKLY') {
    return { repeatKind: 'WEEKLY_DAYS', weekdays: [1, 2, 3, 4, 5] };
  }
  return { repeatKind: 'DAILY', weekdays: null };
}

export type PreviewTaskInput = {
  name: string;
  subject: string;
  standard: string;
  durationMinutes?: number | null;
  steps?: string[];
  repeatKind?: RepeatKind;
  weekdays?: IsoWeekday[] | null;
  startLocalDate?: string;
  endLocalDate?: string | null;
  ongoing?: boolean;
};

export function normalizePreviewTasks(
  tasks: PreviewTaskInput[],
  templateKind: string,
  todayLocalDate: string,
): SeriesRule[] {
  if (tasks.length < 1) {
    throw new Error('PREVIEW_EMPTY');
  }
  const defaults = defaultRepeatForTemplateKind(templateKind);
  return tasks.map((task) => {
    const ongoing = task.ongoing ?? task.endLocalDate == null;
    const repeatKind = task.repeatKind ?? defaults.repeatKind;
    const weekdays = repeatKind === 'WEEKLY_DAYS' ? (task.weekdays ?? defaults.weekdays ?? [1, 2, 3, 4, 5]) : null;
    return {
      name: task.name.trim(),
      subject: task.subject.trim() || '自定义',
      completionStandard: task.standard.trim(),
      durationMinutes: task.durationMinutes ?? null,
      steps: (task.steps ?? []).map((step) => step.trim()).filter(Boolean),
      repeatKind,
      weekdays,
      startLocalDate: task.startLocalDate ?? todayLocalDate,
      endLocalDate: ongoing ? null : (task.endLocalDate ?? addLocalDays(todayLocalDate, 13)),
      ongoing,
    };
  });
}

export function estimateNextLocalDates(rule: SeriesRule, todayLocalDate: string, days = 7): string[] {
  const window = { from: todayLocalDate, to: addLocalDays(todayLocalDate, days - 1) };
  return expandSeriesOccurrences(rule, window);
}

export function planAllowsOccurrenceGeneration(status: string): boolean {
  return status === 'ACTIVE';
}

export function datesToMaterializeForPlan(
  status: string,
  rule: SeriesRule,
  todayLocalDate: string,
): string[] {
  if (!planAllowsOccurrenceGeneration(status)) {
    return [];
  }
  return expandSeriesOccurrences(rule, horizonWindow(todayLocalDate, rule.endLocalDate));
}

export function missingOccurrenceDates(
  status: string,
  rule: SeriesRule,
  todayLocalDate: string,
  existingKeys: Iterable<string>,
): string[] {
  const have = new Set(existingKeys);
  return datesToMaterializeForPlan(status, rule, todayLocalDate).filter((day) => !have.has(day));
}

export function resolvePlanStatusTransition(
  current: string,
  action: string,
):
  | { ok: true; next: PlanStatus; reasonCode: 'PLAN_PAUSED' | 'PLAN_RESUMED' | 'PLAN_ARCHIVED' }
  | { ok: false; code: 'PLAN_STATUS_INVALID' } {
  if (action === 'PAUSE' && current === 'ACTIVE') {
    return { ok: true, next: 'PAUSED', reasonCode: 'PLAN_PAUSED' };
  }
  if (action === 'RESUME' && current === 'PAUSED') {
    return { ok: true, next: 'ACTIVE', reasonCode: 'PLAN_RESUMED' };
  }
  if (action === 'ARCHIVE' && (current === 'ACTIVE' || current === 'PAUSED')) {
    return { ok: true, next: 'ARCHIVED', reasonCode: 'PLAN_ARCHIVED' };
  }
  return { ok: false, code: 'PLAN_STATUS_INVALID' };
}

export function cancelReasonForPlanAction(action: string): 'PLAN_PAUSED' | 'PLAN_ARCHIVED' | null {
  if (action === 'PAUSE') {
    return 'PLAN_PAUSED';
  }
  if (action === 'ARCHIVE') {
    return 'PLAN_ARCHIVED';
  }
  return null;
}

export function occurrenceCancellableOnPlanHalt(
  status: string,
  scheduledLocalDate: string,
  effectiveLocalDate: string,
): boolean {
  return status === 'PLANNED' && compareLocalDate(scheduledLocalDate, effectiveLocalDate) >= 0;
}

export function occurrenceRestorableOnResume(input: {
  status: string;
  cancelReason: string | null;
  scheduledLocalDate: string;
  todayLocalDate: string;
}): boolean {
  return (
    input.status === 'CANCELLED' &&
    input.cancelReason === 'PLAN_PAUSED' &&
    compareLocalDate(input.scheduledLocalDate, input.todayLocalDate) >= 0
  );
}

export function canAdjustOccurrence(planStatus: string, occurrenceStatus: string): boolean {
  return planStatus === 'ACTIVE' && occurrenceStatus === 'PLANNED';
}

export function canRescheduleOccurrence(planStatus: string, occurrenceStatus: string): boolean {
  return canAdjustOccurrence(planStatus, occurrenceStatus);
}

export type OccurrenceContent = {
  name: string;
  subject: string;
  completionStandard: string;
  durationMinutes: number | null;
  steps: string[];
};

export function occurrenceContentFromSnapshots(row: {
  nameSnapshot: string;
  subjectSnapshot: string;
  completionStandardSnapshot: string;
  durationMinutesSnapshot: number | null;
  stepsSnapshotJson: string;
}): OccurrenceContent {
  return {
    name: row.nameSnapshot,
    subject: row.subjectSnapshot,
    completionStandard: row.completionStandardSnapshot,
    durationMinutes: row.durationMinutesSnapshot,
    steps: JSON.parse(row.stepsSnapshotJson) as string[],
  };
}

export function occurrenceContentEquals(left: OccurrenceContent, right: OccurrenceContent): boolean {
  return (
    left.name === right.name &&
    left.subject === right.subject &&
    left.completionStandard === right.completionStandard &&
    left.durationMinutes === right.durationMinutes &&
    JSON.stringify(left.steps) === JSON.stringify(right.steps)
  );
}

export function occurrenceContentDiff(from: OccurrenceContent, to: OccurrenceContent) {
  const fields: Array<{ field: string; from: unknown; to: unknown }> = [];
  if (from.name !== to.name) {
    fields.push({ field: 'name', from: from.name, to: to.name });
  }
  if (from.subject !== to.subject) {
    fields.push({ field: 'subject', from: from.subject, to: to.subject });
  }
  if (from.completionStandard !== to.completionStandard) {
    fields.push({ field: 'completionStandard', from: from.completionStandard, to: to.completionStandard });
  }
  if (from.durationMinutes !== to.durationMinutes) {
    fields.push({ field: 'durationMinutes', from: from.durationMinutes, to: to.durationMinutes });
  }
  if (JSON.stringify(from.steps) !== JSON.stringify(to.steps)) {
    fields.push({ field: 'steps', from: from.steps, to: to.steps });
  }
  return fields;
}

export function rescheduleTargetAllowed(todayLocalDate: string, targetLocalDate: string): boolean {
  return isLocalDate(targetLocalDate) && compareLocalDate(targetLocalDate, todayLocalDate) >= 0;
}

export function scheduledDateConflicts(
  targetLocalDate: string,
  selfId: string,
  siblings: Iterable<{ id: string; scheduledLocalDate: string }>,
): boolean {
  for (const row of siblings) {
    if (row.id !== selfId && row.scheduledLocalDate === targetLocalDate) {
      return true;
    }
  }
  return false;
}

export const REVISION_CHANGE_KINDS = ['BASELINE', 'CONTENT', 'SCHEDULE'] as const;
export type RevisionChangeKind = (typeof REVISION_CHANGE_KINDS)[number];

export type SeriesRevisionRecord = {
  revisionNo: number;
  changeKind: RevisionChangeKind;
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
};

export function selectEffectiveRevision(
  revisions: Iterable<SeriesRevisionRecord>,
  kinds: readonly RevisionChangeKind[],
  occurrenceKey: string,
): SeriesRevisionRecord | null {
  let best: SeriesRevisionRecord | null = null;
  for (const row of revisions) {
    if (!kinds.includes(row.changeKind)) {
      continue;
    }
    if (compareLocalDate(row.effectiveFromOccurrenceKey, occurrenceKey) > 0) {
      continue;
    }
    if (!best || row.revisionNo > best.revisionNo) {
      best = row;
    }
  }
  return best;
}

export function contentFromRevision(revision: SeriesRevisionRecord): OccurrenceContent {
  return {
    name: revision.name ?? '',
    subject: revision.subject ?? '',
    completionStandard: revision.completionStandard ?? '',
    durationMinutes: revision.durationMinutes,
    steps: revision.stepsJson ? (JSON.parse(revision.stepsJson) as string[]) : [],
  };
}

export function keyHitsEffectiveSchedule(
  revisions: Iterable<SeriesRevisionRecord>,
  occurrenceKey: string,
): boolean {
  const schedule = selectEffectiveRevision(revisions, ['BASELINE', 'SCHEDULE'], occurrenceKey);
  if (!schedule || !schedule.repeatKind) {
    return false;
  }
  if (schedule.ongoing === false && schedule.endLocalDate && compareLocalDate(occurrenceKey, schedule.endLocalDate) > 0) {
    return false;
  }
  if (schedule.repeatKind === 'ONCE') {
    return occurrenceKey === schedule.effectiveFromOccurrenceKey;
  }
  if (schedule.repeatKind === 'DAILY') {
    return true;
  }
  const weekdays = new Set((schedule.weekdaysJson ? (JSON.parse(schedule.weekdaysJson) as IsoWeekday[]) : []) ?? []);
  return weekdays.has(isoWeekdayFromLocalDate(occurrenceKey));
}

export function datesToMaterializeFromRevisions(
  planStatus: string,
  revisions: Iterable<SeriesRevisionRecord>,
  todayLocalDate: string,
): string[] {
  if (!planAllowsOccurrenceGeneration(planStatus)) {
    return [];
  }
  const window = horizonWindow(todayLocalDate, null);
  const dates: string[] = [];
  let cursor = window.from;
  while (compareLocalDate(cursor, window.to) <= 0) {
    if (keyHitsEffectiveSchedule(revisions, cursor)) {
      dates.push(cursor);
    }
    cursor = addLocalDays(cursor, 1);
  }
  return dates;
}

export function canAnchorFutureChange(input: {
  planStatus: string;
  occurrenceStatus: string;
  occurrenceKey: string;
  scheduledLocalDate: string;
  todayLocalDate: string;
  sourceOccurrenceId?: string | null;
}): boolean {
  return (
    input.planStatus === 'ACTIVE' &&
    input.occurrenceStatus === 'PLANNED' &&
    input.sourceOccurrenceId == null &&
    compareLocalDate(input.occurrenceKey, input.todayLocalDate) >= 0 &&
    compareLocalDate(input.scheduledLocalDate, input.todayLocalDate) >= 0
  );
}

export const OCCURRENCE_CANCEL_REASONS = [
  'PLAN_PAUSED',
  'PLAN_ARCHIVED',
  'SERIES_RULE_REMOVED',
  'USER_CANCELLED',
  'SPLIT',
] as const;
export type OccurrenceCancelReason = (typeof OCCURRENCE_CANCEL_REASONS)[number];

export type SplitChildDraft = {
  name: string;
  subject: string;
  standard: string;
  durationMinutes: number | null;
  steps: string[];
  scheduledLocalDate: string;
};

export function canSplitOccurrence(input: {
  planStatus: string;
  occurrenceStatus: string;
  scheduledLocalDate: string;
  todayLocalDate: string;
  sourceOccurrenceId: string | null;
}): boolean {
  return (
    input.planStatus === 'ACTIVE' &&
    input.occurrenceStatus === 'PLANNED' &&
    input.sourceOccurrenceId == null &&
    compareLocalDate(input.scheduledLocalDate, input.todayLocalDate) >= 0
  );
}

export function normalizeSplitChildren(children: SplitChildDraft[]): SplitChildDraft[] {
  return children.map((child) => ({
    name: child.name.trim(),
    subject: child.subject.trim(),
    standard: child.standard.trim(),
    durationMinutes: child.durationMinutes,
    steps: child.steps.map((step) => step.trim()).filter(Boolean),
    scheduledLocalDate: child.scheduledLocalDate,
  }));
}

export function splitChildDateErrors(children: SplitChildDraft[], todayLocalDate: string): Record<string, string> {
  const fields: Record<string, string> = {};
  children.forEach((child, index) => {
    if (compareLocalDate(child.scheduledLocalDate, todayLocalDate) < 0) {
      fields[`children.${index}.scheduledLocalDate`] = 'past';
    }
  });
  return fields;
}

export function splitPreviewCanonicalPayload(input: {
  studentId: string;
  studentVersion: number;
  planId: string;
  planVersion: number;
  seriesId: string;
  seriesVersion: number;
  occurrenceId: string;
  occurrenceVersion: number;
  occurrenceKey: string;
  scheduledLocalDate: string;
  status: string;
  cancelReason: string | null;
  contentExceptionAdjustmentId: string | null;
  scheduleExceptionAdjustmentId: string | null;
  nameSnapshot: string;
  subjectSnapshot: string;
  completionStandardSnapshot: string;
  durationMinutesSnapshot: number | null;
  stepsSnapshotJson: string;
  timezone: string;
  todayLocalDate: string;
  children: SplitChildDraft[];
  reason: string;
}) {
  return {
    studentId: input.studentId,
    studentVersion: input.studentVersion,
    planId: input.planId,
    planVersion: input.planVersion,
    seriesId: input.seriesId,
    seriesVersion: input.seriesVersion,
    occurrenceId: input.occurrenceId,
    occurrenceVersion: input.occurrenceVersion,
    occurrenceKey: input.occurrenceKey,
    scheduledLocalDate: input.scheduledLocalDate,
    status: input.status,
    cancelReason: input.cancelReason,
    contentExceptionAdjustmentId: input.contentExceptionAdjustmentId,
    scheduleExceptionAdjustmentId: input.scheduleExceptionAdjustmentId,
    nameSnapshot: input.nameSnapshot,
    subjectSnapshot: input.subjectSnapshot,
    completionStandardSnapshot: input.completionStandardSnapshot,
    durationMinutesSnapshot: input.durationMinutesSnapshot,
    stepsSnapshotJson: input.stepsSnapshotJson,
    timezone: input.timezone,
    todayLocalDate: input.todayLocalDate,
    children: input.children,
    reason: input.reason,
  };
}

export type FutureContentEffect =
  | 'modified'
  | 'preserved_exception'
  | 'preserved_history'
  | 'preserved_terminal'
  | 'preserved_cancelled'
  | 'unchanged';

export function classifyFutureContentEffect(input: {
  occurrenceKey: string;
  scheduledLocalDate: string;
  status: string;
  cutoffOccurrenceKey: string;
  todayLocalDate: string;
  hasContentException: boolean;
  currentContent: OccurrenceContent;
  nextContent: OccurrenceContent;
}): FutureContentEffect {
  if (compareLocalDate(input.occurrenceKey, input.cutoffOccurrenceKey) < 0) {
    return 'unchanged';
  }
  if (
    compareLocalDate(input.occurrenceKey, input.todayLocalDate) < 0 ||
    compareLocalDate(input.scheduledLocalDate, input.todayLocalDate) < 0
  ) {
    return 'preserved_history';
  }
  if (input.status === 'IN_PROGRESS' || input.status === 'COMPLETED' || input.status === 'SKIPPED') {
    return 'preserved_terminal';
  }
  if (input.status === 'CANCELLED') {
    return 'preserved_cancelled';
  }
  if (input.status === 'PLANNED' && input.hasContentException) {
    return 'preserved_exception';
  }
  if (input.status === 'PLANNED' && !occurrenceContentEquals(input.currentContent, input.nextContent)) {
    return 'modified';
  }
  return 'unchanged';
}

export function futureContentProjectionUnchanged(
  revisions: SeriesRevisionRecord[],
  cutoffOccurrenceKey: string,
  proposal: OccurrenceContent,
): boolean {
  const points = new Set<string>([cutoffOccurrenceKey]);
  for (const row of revisions) {
    if (
      (row.changeKind === 'BASELINE' || row.changeKind === 'CONTENT') &&
      compareLocalDate(row.effectiveFromOccurrenceKey, cutoffOccurrenceKey) >= 0
    ) {
      points.add(row.effectiveFromOccurrenceKey);
    }
  }
  for (const key of points) {
    const current = selectEffectiveRevision(revisions, ['BASELINE', 'CONTENT'], key);
    if (!current || !occurrenceContentEquals(contentFromRevision(current), proposal)) {
      return false;
    }
  }
  return true;
}

export type OccurrenceSchedule = {
  repeatKind: RepeatKind;
  weekdays: IsoWeekday[] | null;
  endLocalDate: string | null;
  ongoing: boolean;
};

export function normalizeWeekdays(weekdays: IsoWeekday[] | null): IsoWeekday[] | null {
  if (!weekdays) {
    return null;
  }
  return [...new Set(weekdays)].sort((left, right) => left - right) as IsoWeekday[];
}

export function scheduleFromRevision(revision: SeriesRevisionRecord): OccurrenceSchedule | null {
  if (!revision.repeatKind) {
    return null;
  }
  return {
    repeatKind: revision.repeatKind as RepeatKind,
    weekdays: revision.weekdaysJson ? (JSON.parse(revision.weekdaysJson) as IsoWeekday[]) : null,
    endLocalDate: revision.endLocalDate,
    ongoing: revision.ongoing ?? true,
  };
}

export function occurrenceScheduleEquals(left: OccurrenceSchedule, right: OccurrenceSchedule): boolean {
  return (
    left.repeatKind === right.repeatKind &&
    left.ongoing === right.ongoing &&
    left.endLocalDate === right.endLocalDate &&
    JSON.stringify(normalizeWeekdays(left.weekdays)) === JSON.stringify(normalizeWeekdays(right.weekdays))
  );
}

export function futureScheduleShapeErrors(
  proposal: OccurrenceSchedule,
  cutoffOccurrenceKey: string,
): Record<string, string> {
  const fields: Record<string, string> = {};
  if (proposal.repeatKind === 'WEEKLY_DAYS') {
    const weekdays = normalizeWeekdays(proposal.weekdays);
    if (!weekdays || weekdays.length === 0) {
      fields.weekdays = 'required';
    }
  } else if (proposal.weekdays != null) {
    fields.weekdays = 'forbidden';
  }
  if (proposal.ongoing) {
    if (proposal.endLocalDate != null) {
      fields.endLocalDate = 'forbidden';
    }
  } else if (!proposal.endLocalDate || !isLocalDate(proposal.endLocalDate)) {
    fields.endLocalDate = 'required';
  } else if (compareLocalDate(proposal.endLocalDate, cutoffOccurrenceKey) < 0) {
    fields.endLocalDate = 'beforeCutoff';
  }
  return fields;
}

export function scheduleRevisionFromProposal(
  revisionNo: number,
  cutoffOccurrenceKey: string,
  proposal: OccurrenceSchedule,
): SeriesRevisionRecord {
  const weekdays = proposal.repeatKind === 'WEEKLY_DAYS' ? normalizeWeekdays(proposal.weekdays) : null;
  return {
    revisionNo,
    changeKind: 'SCHEDULE',
    effectiveFromOccurrenceKey: cutoffOccurrenceKey,
    name: null,
    subject: null,
    completionStandard: null,
    durationMinutes: null,
    stepsJson: null,
    repeatKind: proposal.repeatKind,
    weekdaysJson: weekdays ? JSON.stringify(weekdays) : null,
    endLocalDate: proposal.ongoing ? null : proposal.endLocalDate,
    ongoing: proposal.ongoing,
  };
}

export function futureScheduleProjectionUnchanged(
  revisions: SeriesRevisionRecord[],
  cutoffOccurrenceKey: string,
  proposal: OccurrenceSchedule,
): boolean {
  const points = new Set<string>([cutoffOccurrenceKey]);
  for (const row of revisions) {
    if (
      (row.changeKind === 'BASELINE' || row.changeKind === 'SCHEDULE') &&
      compareLocalDate(row.effectiveFromOccurrenceKey, cutoffOccurrenceKey) >= 0
    ) {
      points.add(row.effectiveFromOccurrenceKey);
    }
  }
  for (const key of points) {
    const current = selectEffectiveRevision(revisions, ['BASELINE', 'SCHEDULE'], key);
    const schedule = current ? scheduleFromRevision(current) : null;
    if (!schedule || !occurrenceScheduleEquals(schedule, proposal)) {
      return false;
    }
  }
  return true;
}

export type FutureScheduleEffect =
  | 'modified'
  | 'preserved_exception'
  | 'preserved_history'
  | 'preserved_terminal'
  | 'preserved_cancelled'
  | 'cancelled'
  | 'restored'
  | 'unchanged';

export function classifyFutureScheduleEffect(input: {
  occurrenceKey: string;
  scheduledLocalDate: string;
  status: string;
  cancelReason: string | null;
  cutoffOccurrenceKey: string;
  todayLocalDate: string;
  hasScheduleException: boolean;
  hitsNextSchedule: boolean;
  scheduleRevisionNo: number;
  nextScheduleRevisionNo: number;
  applyScheduleRevision: boolean;
}): FutureScheduleEffect {
  if (compareLocalDate(input.occurrenceKey, input.cutoffOccurrenceKey) < 0) {
    return 'unchanged';
  }
  if (
    compareLocalDate(input.occurrenceKey, input.todayLocalDate) < 0 ||
    compareLocalDate(input.scheduledLocalDate, input.todayLocalDate) < 0
  ) {
    return 'preserved_history';
  }
  if (input.status === 'IN_PROGRESS' || input.status === 'COMPLETED' || input.status === 'SKIPPED') {
    return 'preserved_terminal';
  }
  if (input.status === 'CANCELLED') {
    if (
      input.applyScheduleRevision &&
      input.cancelReason === 'SERIES_RULE_REMOVED' &&
      input.hitsNextSchedule &&
      !input.hasScheduleException
    ) {
      return 'restored';
    }
    return 'preserved_cancelled';
  }
  if (input.status === 'PLANNED' && input.hasScheduleException) {
    return 'preserved_exception';
  }
  if (input.status === 'PLANNED' && !input.hitsNextSchedule) {
    return input.applyScheduleRevision ? 'cancelled' : 'unchanged';
  }
  if (
    input.status === 'PLANNED' &&
    input.hitsNextSchedule &&
    input.applyScheduleRevision &&
    input.scheduleRevisionNo !== input.nextScheduleRevisionNo
  ) {
    return 'modified';
  }
  return 'unchanged';
}

export type FutureScheduleConflict = {
  scheduledLocalDate: string;
  occupyingId: string;
  occupyingOccurrenceKey: string;
  occupyingStatus: string;
  occupyingCancelReason: string | null;
  reason: 'DATE_OCCUPIED';
};

export function futureScheduleAddedDates(input: {
  revisions: Iterable<SeriesRevisionRecord>;
  existingKeys: Iterable<string>;
  cutoffOccurrenceKey: string;
  todayLocalDate: string;
}): string[] {
  const have = new Set(input.existingKeys);
  const window = horizonWindow(input.todayLocalDate, null);
  const from =
    compareLocalDate(input.cutoffOccurrenceKey, window.from) > 0 ? input.cutoffOccurrenceKey : window.from;
  const dates: string[] = [];
  let cursor = from;
  while (compareLocalDate(cursor, window.to) <= 0) {
    if (!have.has(cursor) && keyHitsEffectiveSchedule(input.revisions, cursor)) {
      dates.push(cursor);
    }
    cursor = addLocalDays(cursor, 1);
  }
  return dates;
}

export function futureScheduleInsertConflicts(input: {
  siblings: Array<{
    id: string;
    occurrenceKey: string;
    scheduledLocalDate: string;
    status: string;
    cancelReason: string | null;
  }>;
  insertDates: Iterable<string>;
}): FutureScheduleConflict[] {
  const insert = new Set(input.insertDates);
  const conflicts: FutureScheduleConflict[] = [];
  for (const sibling of input.siblings) {
    if (!insert.has(sibling.scheduledLocalDate)) {
      continue;
    }
    conflicts.push({
      scheduledLocalDate: sibling.scheduledLocalDate,
      occupyingId: sibling.id,
      occupyingOccurrenceKey: sibling.occurrenceKey,
      occupyingStatus: sibling.status,
      occupyingCancelReason: sibling.cancelReason,
      reason: 'DATE_OCCUPIED',
    });
  }
  return conflicts;
}

export function futureScheduleConflictCandidateDates(input: {
  revisions: Iterable<SeriesRevisionRecord>;
  existingKeys: Iterable<string>;
  siblingScheduledDates: Iterable<string>;
  cutoffOccurrenceKey: string;
  todayLocalDate: string;
}): string[] {
  const added = futureScheduleAddedDates(input);
  const have = new Set(input.existingKeys);
  const dates = new Set(added);
  for (const scheduled of input.siblingScheduledDates) {
    if (
      compareLocalDate(scheduled, input.cutoffOccurrenceKey) >= 0 &&
      !have.has(scheduled) &&
      keyHitsEffectiveSchedule(input.revisions, scheduled)
    ) {
      dates.add(scheduled);
    }
  }
  return [...dates].sort();
}

export function futurePreviewCanonicalPayload(input: {
  studentId: string;
  studentVersion: number;
  planId: string;
  planVersion: number;
  seriesId: string;
  seriesVersion: number;
  anchorId: string;
  anchorVersion: number;
  cutoffOccurrenceKey: string;
  timezone: string;
  todayLocalDate: string;
  contentHead: number;
  scheduleHead: number;
  proposal: unknown;
  siblings: Array<{
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
  }>;
}) {
  return {
    studentId: input.studentId,
    studentVersion: input.studentVersion,
    planId: input.planId,
    planVersion: input.planVersion,
    seriesId: input.seriesId,
    seriesVersion: input.seriesVersion,
    anchorId: input.anchorId,
    anchorVersion: input.anchorVersion,
    cutoffOccurrenceKey: input.cutoffOccurrenceKey,
    timezone: input.timezone,
    todayLocalDate: input.todayLocalDate,
    contentHead: input.contentHead,
    scheduleHead: input.scheduleHead,
    proposal: input.proposal,
    siblings: [...input.siblings].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export type EducationFingerprint = {
  gradeConfigId: string;
  gradeConfigVersionId: string;
  catalogEntryKey: string;
  timezone: string;
};

export function previewCanonicalPayload(input: {
  templateId: string;
  templateVersion: string;
  education: EducationFingerprint;
  series: SeriesRule[];
}): {
  templateId: string;
  templateVersion: string;
  education: EducationFingerprint;
  series: SeriesRule[];
} {
  return {
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    education: input.education,
    series: input.series,
  };
}

export function manualPreviewCanonicalPayload(input: {
  education: EducationFingerprint;
  series: SeriesRule[];
}): {
  source: 'MANUAL';
  education: EducationFingerprint;
  series: SeriesRule[];
} {
  return {
    source: 'MANUAL',
    education: input.education,
    series: input.series,
  };
}
