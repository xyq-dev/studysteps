import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  applyConsentProbeFailure,
  consentCoversPlanWrites,
  consentCurrentFromVerifiedProbe,
  decideAgeBand,
  evaluateActivation,
  isDeletionStatus,
  isEducationSnapshotMatchingVersion,
  type HorizonBlockedReason,
  type HorizonRetiredReason,
} from '@studysteps/domain';
import { AppError } from '../common/app-error';

type Tx = Prisma.TransactionClient | PrismaService;

export type EligibilityStudent = {
  id: string;
  status: string;
  ageBand: string;
  gradeConfigId: string | null;
  gradeConfigVersionId: string | null;
  stageCode: string | null;
  schoolSystemCode: string | null;
  gradeCode: string | null;
  gradeLabel: string | null;
  termCode: string | null;
};

export type ConsentAuthorization =
  | { ok: true }
  | { ok: false; reason: HorizonBlockedReason };

export type GenerationEligibility =
  | { ok: true }
  | { ok: false; kind: 'BLOCKED'; reason: HorizonBlockedReason }
  | { ok: false; kind: 'RETIRED'; reason: HorizonRetiredReason };

@Injectable()
export class PlanningEligibilityService {
  async evaluateConsentAuthorization(tx: Tx, studentId: string, ageBand: string): Promise<ConsentAuthorization> {
    const age = decideAgeBand(ageBand as 'UNDER_14' | 'AGE_14_TO_17' | 'AGE_18_PLUS');
    if (!age.ok) {
      throw new AppError(age.code, '当前年龄段不能使用', 422);
    }
    const policy = await tx.consentPolicy.findUnique({
      where: { policyKey_locale: { policyKey: age.policyKey, locale: 'zh-CN' } },
    });
    const consent = await tx.consentRecord.findFirst({
      where: {
        studentProfileId: studentId,
        consentPolicyId: policy?.id,
        withdrawnAt: null,
        supersededAt: null,
      },
    });
    if (!policy?.currentDocumentVersionId || !consent || consent.documentVersionId !== policy.currentDocumentVersionId) {
      return { ok: false, reason: 'CONSENT_REQUIRED' };
    }
    const document = await tx.consentDocumentVersion.findUnique({
      where: { id: policy.currentDocumentVersionId },
    });
    if (!document?.publishedAt) {
      return { ok: false, reason: 'CONSENT_REQUIRED' };
    }
    if (!consentCoversPlanWrites(document.scopeCanonicalJson)) {
      return { ok: false, reason: 'CONSENT_SCOPE_MISSING' };
    }
    const link = await tx.guardianLink.findUnique({ where: { id: consent.guardianLinkId } });
    if (!link || link.id !== consent.guardianLinkId || link.studentProfileId !== studentId) {
      return { ok: false, reason: 'GUARDIAN_LINK_NOT_ACTIVE' };
    }
    if (link.status !== 'ACTIVE') {
      return { ok: false, reason: 'GUARDIAN_LINK_NOT_ACTIVE' };
    }
    const grantor = await tx.account.findUnique({ where: { id: consent.grantedByAccountId } });
    if (!grantor || grantor.status !== 'ACTIVE') {
      return { ok: false, reason: 'ACCOUNT_NOT_ACTIVE' };
    }
    return { ok: true };
  }

  async assertFreshRequiredConsent(tx: Tx, studentId: string, ageBand: string): Promise<void> {
    const result = await this.evaluateConsentAuthorization(tx, studentId, ageBand);
    if (!result.ok) {
      if (result.reason === 'CONSENT_SCOPE_MISSING') {
        throw new AppError('LEARNING_ACCESS_BLOCKED', '当前同意未覆盖计划与任务', 403);
      }
      throw new AppError('CONSENT_REQUIRED', '需要接受当前测试政策', 422);
    }
  }

  async consentIsCurrent(tx: Tx, studentId: string, ageBand: string): Promise<boolean> {
    try {
      const result = await this.evaluateConsentAuthorization(tx, studentId, ageBand);
      if (!result.ok) {
        if (result.reason === 'CONSENT_REQUIRED') {
          return applyConsentProbeFailure({ code: 'CONSENT_REQUIRED' });
        }
        if (result.reason === 'CONSENT_SCOPE_MISSING') {
          return consentCurrentFromVerifiedProbe();
        }
        return false;
      }
      return consentCurrentFromVerifiedProbe();
    } catch (error) {
      return applyConsentProbeFailure(error);
    }
  }

  async evaluateGenerationEligibility(
    tx: Tx,
    student: EligibilityStudent,
    plan: { id: string; status: string; studentProfileId: string },
  ): Promise<GenerationEligibility> {
    if (plan.studentProfileId !== student.id) {
      return { ok: false, kind: 'BLOCKED', reason: 'PROFILE_NOT_ACTIVE' };
    }
    if (isDeletionStatus(student.status)) {
      return { ok: false, kind: 'RETIRED', reason: 'PROFILE_DELETION' };
    }
    if (plan.status === 'ARCHIVED') {
      return { ok: false, kind: 'RETIRED', reason: 'PLAN_ARCHIVED' };
    }
    if (plan.status === 'PAUSED') {
      return { ok: false, kind: 'BLOCKED', reason: 'PLAN_PAUSED' };
    }
    if (plan.status !== 'ACTIVE') {
      return { ok: false, kind: 'BLOCKED', reason: 'PLAN_PAUSED' };
    }
    if (student.status !== 'ACTIVE') {
      return { ok: false, kind: 'BLOCKED', reason: 'PROFILE_NOT_ACTIVE' };
    }
    const age = decideAgeBand(student.ageBand as 'UNDER_14' | 'AGE_14_TO_17' | 'AGE_18_PLUS');
    if (!age.ok) {
      return { ok: false, kind: 'BLOCKED', reason: 'AGE_NOT_SUPPORTED' };
    }
    const snapshot = {
      gradeConfigId: student.gradeConfigId,
      gradeConfigVersionId: student.gradeConfigVersionId,
      stageCode: student.stageCode,
      schoolSystemCode: student.schoolSystemCode,
      gradeCode: student.gradeCode,
      gradeLabel: student.gradeLabel,
      termCode: student.termCode,
    };
    if (
      !snapshot.gradeConfigId ||
      !snapshot.gradeConfigVersionId ||
      !snapshot.stageCode ||
      !snapshot.schoolSystemCode ||
      !snapshot.gradeCode ||
      !snapshot.gradeLabel ||
      !snapshot.termCode
    ) {
      return { ok: false, kind: 'BLOCKED', reason: 'EDUCATION_INVALID' };
    }
    const config = await tx.gradeConfig.findUnique({ where: { id: snapshot.gradeConfigId } });
    const version = await tx.gradeConfigVersion.findUnique({ where: { id: snapshot.gradeConfigVersionId } });
    const matches = !!(
      config &&
      version &&
      isEducationSnapshotMatchingVersion(
        snapshot,
        {
          id: config.id,
          schoolSystemCode: config.schoolSystemCode,
          stageCode: config.stageCode,
          gradeCode: config.gradeCode,
          currentVersionId: config.currentVersionId,
        },
        {
          id: version.id,
          gradeConfigId: version.gradeConfigId,
          gradeLabel: version.gradeLabel,
          allowedTermCodes: JSON.parse(version.allowedTermCodes) as string[],
          publishedAt: version.publishedAt,
        },
      )
    );
    if (!matches) {
      return { ok: false, kind: 'BLOCKED', reason: 'EDUCATION_INVALID' };
    }
    const consent = await this.evaluateConsentAuthorization(tx, student.id, student.ageBand);
    if (!consent.ok) {
      return { ok: false, kind: 'BLOCKED', reason: consent.reason };
    }
    const activation = evaluateActivation({
      storedStatus: student.status,
      snapshot,
      matchesPublishedVersion: matches,
      consentCurrent: true,
    });
    if (!activation.learningAccess.allowed || activation.status !== 'ACTIVE') {
      return { ok: false, kind: 'BLOCKED', reason: 'PROFILE_NOT_ACTIVE' };
    }
    return { ok: true };
  }
}
