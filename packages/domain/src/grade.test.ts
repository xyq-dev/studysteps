import { describe, expect, it } from 'vitest';
import {
  CATALOG_ENTRY_KEYS,
  CUSTOM_GRADES,
  FIVE_FOUR_GRADES,
  SIX_THREE_GRADES,
  TEMPLATE_KINDS,
  canImportTemplates,
  canRecommendTemplates,
  expectedTemplateCount,
  isCompleteEducationSnapshot,
  isEmptyEducationSnapshot,
  isLeftoverEducationSnapshot,
  templateKeysForCatalog,
} from './grade.js';

describe('grade catalog rules', () => {
  it('keeps 12 six-three entries and independent 五四初四', () => {
    expect(SIX_THREE_GRADES).toHaveLength(12);
    expect(SIX_THREE_GRADES.some((row) => row.gradeLabel === '初四')).toBe(false);
    expect(SIX_THREE_GRADES.some((row) => row.gradeLabel === '六年级')).toBe(true);
    expect(FIVE_FOUR_GRADES.some((row) => row.gradeLabel === '六年级')).toBe(false);
    expect(FIVE_FOUR_GRADES.find((row) => row.gradeLabel === '初四')?.catalogEntryKey).toBe(
      'JUNIOR_G4',
    );
    expect(CUSTOM_GRADES[0]?.catalogEntryKey).toBeNull();
  });

  it('seeds 39 templates as 13 catalog keys times 3 kinds', () => {
    expect(CATALOG_ENTRY_KEYS).toHaveLength(13);
    expect(TEMPLATE_KINDS).toHaveLength(3);
    expect(expectedTemplateCount()).toBe(39);
    expect(templateKeysForCatalog()).toHaveLength(39);
    expect(templateKeysForCatalog().filter((item) => item.catalogEntryKey === 'JUNIOR_G4')).toHaveLength(
      3,
    );
  });

  it('forbids recommend/import without a catalog mapping', () => {
    expect(canRecommendTemplates(null)).toBe(false);
    expect(canImportTemplates(undefined)).toBe(false);
    expect(canImportTemplates('JUNIOR_G4')).toBe(true);
  });

  it('treats leftover snapshots as incomplete rather than empty', () => {
    const leftover = {
      gradeConfigId: null,
      gradeConfigVersionId: null,
      stageCode: 'primary',
      schoolSystemCode: 'liusan',
      gradeCode: 'g3',
      gradeLabel: '三年级',
      termCode: '2026-1',
    };
    expect(isEmptyEducationSnapshot(leftover)).toBe(false);
    expect(isLeftoverEducationSnapshot(leftover)).toBe(true);
    expect(isCompleteEducationSnapshot(leftover)).toBe(false);
    expect(isEmptyEducationSnapshot(undefined)).toBe(true);
    expect(
      isCompleteEducationSnapshot({
        gradeConfigId: 'g3',
        gradeConfigVersionId: null,
        stageCode: 'PRIMARY',
        schoolSystemCode: 'SIX_THREE',
        gradeCode: 'G3',
        gradeLabel: '三年级',
        termCode: 'FULL_YEAR',
      }),
    ).toBe(false);
  });
});
