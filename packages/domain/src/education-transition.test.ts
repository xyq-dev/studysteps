import { describe, expect, it } from 'vitest';
import {
  applyConsentProbeFailure,
  consentCurrentFromVerifiedProbe,
  evaluateActivation,
  evaluateEducationChange,
  isEducationSnapshotMatchingVersion,
  type GradeCatalogRow,
} from './index.js';
import { TERM_CODES, type EducationSnapshot } from './grade.js';

const g1: GradeCatalogRow = {
  id: 'g1',
  schoolSystemCode: 'SIX_THREE',
  stageCode: 'PRIMARY',
  gradeCode: 'G1',
  gradeLabel: '一年级',
  nextGradeConfigId: 'g2',
  allowedTermCodes: TERM_CODES,
  versionId: 'v1',
};
const g2: GradeCatalogRow = {
  ...g1,
  id: 'g2',
  gradeCode: 'G2',
  gradeLabel: '二年级',
  nextGradeConfigId: 'g3',
  versionId: 'v2',
};
const g3: GradeCatalogRow = {
  ...g1,
  id: 'g3',
  gradeCode: 'G3',
  gradeLabel: '三年级',
  nextGradeConfigId: 'g4',
  versionId: 'v3',
};
const g4: GradeCatalogRow = {
  ...g1,
  id: 'g4',
  gradeCode: 'G4',
  gradeLabel: '四年级',
  nextGradeConfigId: null,
  versionId: 'v4',
};
const fiveFourG3: GradeCatalogRow = {
  ...g3,
  id: 'ff-g3',
  schoolSystemCode: 'FIVE_FOUR',
  nextGradeConfigId: 'ff-g4',
  versionId: 'ff-v3',
};
const catalog = [g1, g2, g3, g4, fiveFourG3];

const empty: EducationSnapshot = {
  gradeConfigId: null,
  stageCode: null,
  schoolSystemCode: null,
  gradeCode: null,
  gradeLabel: null,
  termCode: null,
};
const leftover: EducationSnapshot = {
  gradeConfigId: null,
  stageCode: 'primary',
  schoolSystemCode: 'liusan',
  gradeCode: 'g3',
  gradeLabel: '三年级',
  termCode: '2026-1',
};
const assignedG3: EducationSnapshot = {
  gradeConfigId: 'g3',
  gradeConfigVersionId: 'v3',
  stageCode: 'PRIMARY',
  schoolSystemCode: 'SIX_THREE',
  gradeCode: 'G3',
  gradeLabel: '三年级',
  termCode: 'FULL_YEAR',
};

describe('education transition table counterexamples', () => {
  it('rejects empty-archive RESUME and LEAVE', () => {
    expect(evaluateEducationChange({ from: empty, kind: 'LEAVE', target: null, term: null, catalog }).ok).toBe(
      false,
    );
    expect(
      evaluateEducationChange({ from: empty, kind: 'RESUME', target: g1, term: 'FULL_YEAR', catalog }).ok,
    ).toBe(false);
    expect(
      evaluateEducationChange({
        from: empty,
        kind: 'RESUME',
        target: g1,
        term: 'FULL_YEAR',
        catalog,
        lastChangeKind: 'LEAVE',
      }).ok,
    ).toBe(true);
  });

  it('rejects leftover rewrite, LEAVE, RESUME and only allows SET', () => {
    expect(evaluateEducationChange({ from: leftover, kind: 'LEAVE', target: null, term: null, catalog }).ok).toBe(
      false,
    );
    expect(
      evaluateEducationChange({ from: leftover, kind: 'RESUME', target: g3, term: 'FULL_YEAR', catalog }).ok,
    ).toBe(false);
    const set = evaluateEducationChange({ from: leftover, kind: 'SET', target: g3, term: 'FULL_YEAR', catalog });
    expect(set.ok).toBe(true);
  });

  it('rejects SKIP across school systems or backward along next', () => {
    const assignedG1 = { ...assignedG3, gradeConfigId: 'g1', gradeConfigVersionId: 'v1', gradeCode: 'G1', gradeLabel: '一年级' };
    expect(
      evaluateEducationChange({
        from: assignedG3,
        kind: 'SKIP',
        target: fiveFourG3,
        term: 'FULL_YEAR',
        catalog,
      }).ok,
    ).toBe(false);
    expect(
      evaluateEducationChange({ from: assignedG3, kind: 'SKIP', target: g1, term: 'FULL_YEAR', catalog }).ok,
    ).toBe(false);
    expect(
      evaluateEducationChange({ from: assignedG3, kind: 'SKIP', target: g2, term: 'FULL_YEAR', catalog }).ok,
    ).toBe(false);
    expect(
      evaluateEducationChange({ from: assignedG3, kind: 'SKIP', target: g4, term: 'FULL_YEAR', catalog }).ok,
    ).toBe(false);
    expect(
      evaluateEducationChange({ from: assignedG1, kind: 'SKIP', target: g3, term: 'FULL_YEAR', catalog }).ok,
    ).toBe(true);
  });

  it('rejects REPEAT that changes term', () => {
    expect(
      evaluateEducationChange({
        from: assignedG3,
        kind: 'REPEAT',
        target: g3,
        term: 'SECOND_TERM',
        catalog,
      }).ok,
    ).toBe(false);
    expect(
      evaluateEducationChange({
        from: assignedG3,
        kind: 'REPEAT',
        target: g3,
        term: 'FULL_YEAR',
        catalog,
      }).ok,
    ).toBe(true);
  });
});

describe('activation predicate counterexamples', () => {
  it('fail-closes leftover, mismatched snapshot and stale consent', () => {
    expect(
      evaluateActivation({
        storedStatus: 'ACTIVE',
        snapshot: leftover,
        matchesPublishedVersion: false,
        consentCurrent: true,
      }).learningAccess,
    ).toEqual({ allowed: false, reason: 'ACADEMIC_CONFIGURATION_PENDING' });
    expect(
      evaluateActivation({
        storedStatus: 'ACTIVE',
        snapshot: assignedG3,
        matchesPublishedVersion: false,
        consentCurrent: true,
      }).status,
    ).toBe('ONBOARDING');
    expect(
      evaluateActivation({
        storedStatus: 'ACTIVE',
        snapshot: assignedG3,
        matchesPublishedVersion: true,
        consentCurrent: false,
      }),
    ).toEqual({
      status: 'ONBOARDING',
      learningAccess: { allowed: false, reason: 'CONSENT_REQUIRED' },
    });
  });

  it('only treats an explicit successful probe as consentCurrent', () => {
    expect(consentCurrentFromVerifiedProbe()).toBe(true);
    expect(applyConsentProbeFailure({ code: 'CONSENT_REQUIRED' })).toBe(false);
    expect(() => applyConsentProbeFailure({ code: 'AGE_BAND_NOT_SUPPORTED' })).toThrow();
    expect(() => applyConsentProbeFailure(new Error('policy lookup failed'))).toThrow(
      /policy lookup failed/,
    );
    expect(
      evaluateActivation({
        storedStatus: 'ACTIVE',
        snapshot: assignedG3,
        matchesPublishedVersion: true,
        consentCurrent: false,
      }).learningAccess.allowed,
    ).toBe(false);
  });

  it('keeps RESTRICTED even when education is complete', () => {
    expect(
      evaluateActivation({
        storedStatus: 'RESTRICTED',
        snapshot: assignedG3,
        matchesPublishedVersion: true,
        consentCurrent: true,
      }).status,
    ).toBe('RESTRICTED');
  });

  it('requires snapshot fields to match the published version exactly', () => {
    const config = {
      id: 'g3',
      schoolSystemCode: 'SIX_THREE',
      stageCode: 'PRIMARY',
      gradeCode: 'G3',
      currentVersionId: 'v3',
    };
    const version = {
      id: 'v3',
      gradeConfigId: 'g3',
      gradeLabel: '三年级',
      allowedTermCodes: TERM_CODES,
      publishedAt: '2026-09-16',
    };
    expect(isEducationSnapshotMatchingVersion(assignedG3, config, version)).toBe(true);
    expect(
      isEducationSnapshotMatchingVersion({ ...assignedG3, gradeLabel: '三年级（旧）' }, config, version),
    ).toBe(false);
    expect(
      isEducationSnapshotMatchingVersion({ ...assignedG3, gradeConfigVersionId: null }, config, version),
    ).toBe(false);
    expect(
      isEducationSnapshotMatchingVersion(assignedG3, { ...config, currentVersionId: 'other' }, version),
    ).toBe(false);
  });
});
