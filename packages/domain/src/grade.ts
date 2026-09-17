export const TERM_CODES = ['FULL_YEAR', 'FIRST_TERM', 'SECOND_TERM'] as const;
export type TermCode = (typeof TERM_CODES)[number];

export const EDUCATION_CHANGE_KINDS = [
  'SET',
  'PROMOTE',
  'REPEAT',
  'SKIP',
  'LEAVE',
  'RESUME',
  'SYSTEM_SWITCH',
  'TERM_SWITCH',
] as const;
export type EducationChangeKind = (typeof EDUCATION_CHANGE_KINDS)[number];

export const SCHOOL_SYSTEM_CODES = ['SIX_THREE', 'FIVE_FOUR', 'CUSTOM'] as const;
export type SchoolSystemCode = (typeof SCHOOL_SYSTEM_CODES)[number];

export const STAGE_CODES = ['PRIMARY', 'JUNIOR', 'SENIOR'] as const;
export type StageCode = (typeof STAGE_CODES)[number];

export const TEMPLATE_KINDS = ['DAILY', 'READING_REVIEW', 'WEEKLY'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const CATALOG_ENTRY_KEYS = [
  'PRIMARY_G1',
  'PRIMARY_G2',
  'PRIMARY_G3',
  'PRIMARY_G4',
  'PRIMARY_G5',
  'PRIMARY_G6',
  'JUNIOR_G1',
  'JUNIOR_G2',
  'JUNIOR_G3',
  'JUNIOR_G4',
  'SENIOR_G1',
  'SENIOR_G2',
  'SENIOR_G3',
] as const;
export type CatalogEntryKey = (typeof CATALOG_ENTRY_KEYS)[number];

export type EducationSnapshot = {
  gradeConfigId?: string | null;
  gradeConfigVersionId?: string | null;
  stageCode: string | null;
  schoolSystemCode: string | null;
  gradeCode: string | null;
  gradeLabel: string | null;
  termCode: string | null;
};

export type PublishedGrade = {
  id?: string;
  schoolSystemCode: SchoolSystemCode;
  stageCode: StageCode;
  gradeCode: string;
  gradeLabel: string;
  catalogEntryKey: CatalogEntryKey | null;
  nextGradeCode: string | null;
  nextStageCode: StageCode | null;
  allowedTermCodes: readonly TermCode[];
};

const TERMS: readonly TermCode[] = TERM_CODES;

function row(
  schoolSystemCode: SchoolSystemCode,
  stageCode: StageCode,
  gradeCode: string,
  gradeLabel: string,
  catalogEntryKey: CatalogEntryKey | null,
  next: { stage: StageCode; code: string } | null,
): PublishedGrade {
  return {
    schoolSystemCode,
    stageCode,
    gradeCode,
    gradeLabel,
    catalogEntryKey,
    nextGradeCode: next?.code ?? null,
    nextStageCode: next?.stage ?? null,
    allowedTermCodes: TERMS,
  };
}

export const SIX_THREE_GRADES: readonly PublishedGrade[] = [
  row('SIX_THREE', 'PRIMARY', 'G1', '一年级', 'PRIMARY_G1', { stage: 'PRIMARY', code: 'G2' }),
  row('SIX_THREE', 'PRIMARY', 'G2', '二年级', 'PRIMARY_G2', { stage: 'PRIMARY', code: 'G3' }),
  row('SIX_THREE', 'PRIMARY', 'G3', '三年级', 'PRIMARY_G3', { stage: 'PRIMARY', code: 'G4' }),
  row('SIX_THREE', 'PRIMARY', 'G4', '四年级', 'PRIMARY_G4', { stage: 'PRIMARY', code: 'G5' }),
  row('SIX_THREE', 'PRIMARY', 'G5', '五年级', 'PRIMARY_G5', { stage: 'PRIMARY', code: 'G6' }),
  row('SIX_THREE', 'PRIMARY', 'G6', '六年级', 'PRIMARY_G6', { stage: 'JUNIOR', code: 'G1' }),
  row('SIX_THREE', 'JUNIOR', 'G1', '初一', 'JUNIOR_G1', { stage: 'JUNIOR', code: 'G2' }),
  row('SIX_THREE', 'JUNIOR', 'G2', '初二', 'JUNIOR_G2', { stage: 'JUNIOR', code: 'G3' }),
  row('SIX_THREE', 'JUNIOR', 'G3', '初三', 'JUNIOR_G3', { stage: 'SENIOR', code: 'G1' }),
  row('SIX_THREE', 'SENIOR', 'G1', '高一', 'SENIOR_G1', { stage: 'SENIOR', code: 'G2' }),
  row('SIX_THREE', 'SENIOR', 'G2', '高二', 'SENIOR_G2', { stage: 'SENIOR', code: 'G3' }),
  row('SIX_THREE', 'SENIOR', 'G3', '高三', 'SENIOR_G3', null),
];

export const FIVE_FOUR_GRADES: readonly PublishedGrade[] = [
  row('FIVE_FOUR', 'PRIMARY', 'G1', '一年级', 'PRIMARY_G1', { stage: 'PRIMARY', code: 'G2' }),
  row('FIVE_FOUR', 'PRIMARY', 'G2', '二年级', 'PRIMARY_G2', { stage: 'PRIMARY', code: 'G3' }),
  row('FIVE_FOUR', 'PRIMARY', 'G3', '三年级', 'PRIMARY_G3', { stage: 'PRIMARY', code: 'G4' }),
  row('FIVE_FOUR', 'PRIMARY', 'G4', '四年级', 'PRIMARY_G4', { stage: 'PRIMARY', code: 'G5' }),
  row('FIVE_FOUR', 'PRIMARY', 'G5', '五年级', 'PRIMARY_G5', { stage: 'JUNIOR', code: 'G1' }),
  row('FIVE_FOUR', 'JUNIOR', 'G1', '初一', 'JUNIOR_G1', { stage: 'JUNIOR', code: 'G2' }),
  row('FIVE_FOUR', 'JUNIOR', 'G2', '初二', 'JUNIOR_G2', { stage: 'JUNIOR', code: 'G3' }),
  row('FIVE_FOUR', 'JUNIOR', 'G3', '初三', 'JUNIOR_G3', { stage: 'JUNIOR', code: 'G4' }),
  row('FIVE_FOUR', 'JUNIOR', 'G4', '初四', 'JUNIOR_G4', { stage: 'SENIOR', code: 'G1' }),
  row('FIVE_FOUR', 'SENIOR', 'G1', '高一', 'SENIOR_G1', { stage: 'SENIOR', code: 'G2' }),
  row('FIVE_FOUR', 'SENIOR', 'G2', '高二', 'SENIOR_G2', { stage: 'SENIOR', code: 'G3' }),
  row('FIVE_FOUR', 'SENIOR', 'G3', '高三', 'SENIOR_G3', null),
];

export const CUSTOM_GRADES: readonly PublishedGrade[] = [
  row('CUSTOM', 'JUNIOR', 'EXPERIMENTAL', '实验班', null, null),
];

export const PUBLISHED_GRADES: readonly PublishedGrade[] = [
  ...SIX_THREE_GRADES,
  ...FIVE_FOUR_GRADES,
  ...CUSTOM_GRADES,
];

export const TEMPLATE_KIND_LABELS: Record<TemplateKind, string> = {
  DAILY: '日常安排',
  READING_REVIEW: '阅读或复习习惯',
  WEEKLY: '周计划',
};

export function isTermCode(value: string | null | undefined): value is TermCode {
  return value != null && (TERM_CODES as readonly string[]).includes(value);
}

export function isEducationChangeKind(
  value: string | null | undefined,
): value is EducationChangeKind {
  return value != null && (EDUCATION_CHANGE_KINDS as readonly string[]).includes(value);
}

export function snapshotFields(snapshot: EducationSnapshot): Array<string | null | undefined> {
  return [
    snapshot.gradeConfigVersionId,
    snapshot.stageCode,
    snapshot.schoolSystemCode,
    snapshot.gradeCode,
    snapshot.gradeLabel,
    snapshot.termCode,
  ];
}

export function isEmptyEducationSnapshot(snapshot: EducationSnapshot | undefined | null): boolean {
  if (!snapshot) {
    return true;
  }
  if (snapshot.gradeConfigId || snapshot.gradeConfigVersionId) {
    return false;
  }
  return snapshotFields(snapshot).every((value) => value == null || value === '');
}

export function isCompleteEducationSnapshot(snapshot: EducationSnapshot): boolean {
  return Boolean(
    snapshot.gradeConfigId &&
      snapshot.gradeConfigVersionId &&
      snapshot.stageCode &&
      snapshot.schoolSystemCode &&
      snapshot.gradeCode &&
      snapshot.gradeLabel &&
      isTermCode(snapshot.termCode),
  );
}

export function isEducationSnapshotMatchingVersion(
  snapshot: EducationSnapshot,
  config: {
    id: string;
    schoolSystemCode: string;
    stageCode: string;
    gradeCode: string;
    currentVersionId?: string | null;
  },
  version: {
    id: string;
    gradeConfigId: string;
    gradeLabel: string;
    allowedTermCodes: readonly string[];
    publishedAt?: Date | string | null;
  },
): boolean {
  if (!snapshot.gradeConfigId || snapshot.gradeConfigId !== config.id) {
    return false;
  }
  if (!snapshot.gradeConfigVersionId || snapshot.gradeConfigVersionId !== version.id) {
    return false;
  }
  if (version.gradeConfigId !== config.id || !version.publishedAt) {
    return false;
  }
  if ('currentVersionId' in config && config.currentVersionId !== version.id) {
    return false;
  }
  return (
    snapshot.schoolSystemCode === config.schoolSystemCode &&
    snapshot.stageCode === config.stageCode &&
    snapshot.gradeCode === config.gradeCode &&
    snapshot.gradeLabel === version.gradeLabel &&
    isTermCode(snapshot.termCode) &&
    version.allowedTermCodes.includes(snapshot.termCode)
  );
}

export function isLeftoverEducationSnapshot(snapshot: EducationSnapshot): boolean {
  return !snapshot.gradeConfigId && !snapshot.gradeConfigVersionId && !isEmptyEducationSnapshot(snapshot);
}

export function canRecommendTemplates(catalogEntryKey: string | null | undefined): boolean {
  return Boolean(catalogEntryKey);
}

export function canImportTemplates(catalogEntryKey: string | null | undefined): boolean {
  return Boolean(catalogEntryKey);
}

export function templateKeysForCatalog(): Array<{
  catalogEntryKey: CatalogEntryKey;
  kind: TemplateKind;
  templateKey: string;
}> {
  const keys: Array<{ catalogEntryKey: CatalogEntryKey; kind: TemplateKind; templateKey: string }> =
    [];
  for (const catalogEntryKey of CATALOG_ENTRY_KEYS) {
    for (const kind of TEMPLATE_KINDS) {
      keys.push({
        catalogEntryKey,
        kind,
        templateKey: `TPL_${catalogEntryKey}_${kind}`,
      });
    }
  }
  return keys;
}

export function expectedTemplateCount(): number {
  return CATALOG_ENTRY_KEYS.length * TEMPLATE_KINDS.length;
}

export function assertGradeComboLegal(input: {
  schoolSystemCode: string;
  stageCode: string;
  gradeCode: string;
}): boolean {
  return PUBLISHED_GRADES.some(
    (row) =>
      row.schoolSystemCode === input.schoolSystemCode &&
      row.stageCode === input.stageCode &&
      row.gradeCode === input.gradeCode,
  );
}
