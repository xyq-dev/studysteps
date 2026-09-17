export const REPEAT_KINDS = ['ONCE', 'DAILY', 'WEEKLY_DAYS'] as const;
export type RepeatKind = (typeof REPEAT_KINDS)[number];

export const PLAN_ORIGINS = ['STUDENT', 'GUARDIAN_ASSISTED', 'MANUAL'] as const;
export type PlanOrigin = (typeof PLAN_ORIGINS)[number];

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
