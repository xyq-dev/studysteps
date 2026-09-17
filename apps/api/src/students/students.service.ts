import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  asProfileStatus,
  decideAgeBand,
  encodeCrockford,
  applyConsentProbeFailure,
  consentCurrentFromVerifiedProbe,
  evaluateActivation,
  evaluateEducationChange,
  formatPairingCode,
  guardianListIncludes,
  guardianMay,
  isDeletionStatus,
  isEducationSnapshotMatchingVersion,
  isExpired,
  nextAttemptState,
  normalizePairingCode,
  replayWithdrawEffect,
  studentMay,
  studentMayReadSelf,
  type EducationChangeKind,
  type EducationSnapshot,
  type GuardianAction,
} from '@studysteps/domain';
import {
  TEST_POLICY_KEYS,
  type CreateStudentInput,
  type GrantConsentInput,
  type PatchStudentInput,
  type WithdrawConsentInput,
} from '@studysteps/contracts';
import type { DeviceSession, Prisma } from '@prisma/client';
import { AppError } from '../common/app-error';
import { RuntimeConfig } from '../common/runtime-config';
import { hmacHex, randomToken, sha256Hex } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityService } from '../auth/identity.service';
import { RateLimitService } from '../auth/rate-limit.service';
import { IdempotencyService } from '../common/idempotency.service';
import {
  acquireLocks,
  assertLockSetComplete,
  IncompleteLockSetError,
  mergeLockIds,
  readLockedNow,
  runWriteTx,
  type LockIds,
} from '../common/lock-order';
import {
  collectLinkedStudentsGraph,
  collectStudentAuthorizationGraph,
  discoverStudentAuthorizationGraph,
} from './student-authorization';
import { collectForwardLineageIds, issueReplacementSession, revokeActiveLineage } from '../auth/session-lineage';
import { CatalogService } from '../catalog/catalog.service';

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: RuntimeConfig,
    private readonly identity: IdentityService,
    private readonly idempotency: IdempotencyService,
    private readonly rateLimit: RateLimitService,
    private readonly catalog: CatalogService,
  ) {}

  private get config() {
    return this.runtime.value;
  }

  async list(session: DeviceSession) {
    const accountId = session.accountId ?? session.issuedByAccountId;
    const graph = await collectLinkedStudentsGraph(
      this.prisma,
      accountId ?? '00000000-0000-0000-0000-000000000000',
      {
        sessionIds: [session.id],
        accountIds: accountId ? [accountId] : [],
      },
      { includePairings: false, session },
    );
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, {
        accountIds: accountId ? [accountId] : [],
        sessionIds: [session.id],
      });
      const now = await readLockedNow(tx);
      const current = await this.identity.assertSessionCurrent(tx, session, { now });
      this.assertGuardian(current);
      const links = await tx.guardianLink.findMany({
        where: { accountId: current.accountId!, status: 'ACTIVE' },
        include: { student: true },
      });
      const items = [];
      for (const link of links) {
        if (!guardianListIncludes(link.student.status)) {
          continue;
        }
        const activation = await this.activationFor(tx, link.student);
        items.push(this.summary({ ...link.student, status: activation.status }));
      }
      await this.identity.touchLastSeenLocked(tx, current, now);
      return items;
    }, graph);
  }

  async create(session: DeviceSession, input: CreateStudentInput, idempotencyKey: string) {
    this.assertGuardian(session);
    this.identity.requireStepUp(session);
    const age = decideAgeBand(input.ageConfirmation.band);
    if (!age.ok) {
      throw new AppError(age.code, '当前年龄段不能建档', 422);
    }
    const policy = await this.requirePublishedPolicy(age.policyKey);
    const accepted = input.consentAcceptances.find(
      (item) => item.policyKey === age.policyKey && item.version === policy.document.version,
    );
    if (!accepted) {
      throw new AppError('CONSENT_REQUIRED', '需要接受当前测试政策', 422);
    }
    const actor = this.actor(session);
    const requestDigest = this.idempotency.requestDigest({ operation: 'students.create', input });
    const existingIdem = await this.idempotency.peekId(this.prisma, actor, 'students.create', idempotencyKey);
    const planned: LockIds = {
      accountIds: [session.accountId!],
      policies: [{ id: policy.id, policyKey: policy.policyKey, locale: policy.locale }],
      sessionIds: [session.id],
      idempotencyIds: existingIdem ? [existingIdem] : [],
    };
    const created = await runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(planned, extra);
      await acquireLocks(tx, locked);
      const account = await tx.account.findUniqueOrThrow({ where: { id: session.accountId! } });
      const lockedPolicy = await tx.consentPolicy.findUniqueOrThrow({ where: { id: policy.id } });
      assertLockSetComplete(locked, {
        accountIds: [account.id],
        policies: [{ id: lockedPolicy.id, policyKey: lockedPolicy.policyKey, locale: lockedPolicy.locale }],
        sessionIds: [session.id],
      });
      const now = await readLockedNow(tx);
      await this.assertWritableSession(tx, session, true, now);
      const begun = await this.idempotency.begin(tx, actor, 'students.create', idempotencyKey, requestDigest, now);
      if (begun.kind === 'REPLAY' && begun.resourceId) {
        const discovered = await this.discoverStudentGraph(tx, begun.resourceId, session);
        if (!(locked.studentIds ?? []).includes(begun.resourceId)) {
          throw new IncompleteLockSetError(discovered);
        }
        assertLockSetComplete(locked, discovered);
        await this.reauthorize(tx, session, begun.resourceId, 'PROFILE_READ', true, now);
        const replayed = await tx.studentProfile.findUniqueOrThrow({ where: { id: begun.resourceId } });
        await this.identity.touchLastSeenLocked(tx, session, now);
        return { student: replayed, now };
      }
      if (lockedPolicy.currentDocumentVersionId !== policy.currentDocumentVersionId) {
        throw new AppError('CONSENT_VERSION_CHANGED', '政策版本已变化', 409);
      }
      const lockedDocument = await tx.consentDocumentVersion.findUniqueOrThrow({
        where: { id: lockedPolicy.currentDocumentVersionId! },
      });
      if (lockedDocument.version !== accepted.version) {
        throw new AppError('CONSENT_VERSION_CHANGED', '政策版本已变化', 409);
      }
      const student = await tx.studentProfile.create({
        data: {
          nickname: input.profile.nickname,
          avatarPresetId: input.profile.avatarPresetId,
          timezone: input.profile.timezone,
          ageBand: age.band,
          ageConfirmationSource: 'GUARDIAN_DECLARATION',
          ageConfirmedAt: now,
          ageConfirmedByAccountId: session.accountId!,
          createdByAccountId: session.accountId!,
          stageCode: null,
          schoolSystemCode: null,
          gradeCode: null,
          gradeLabel: null,
          termCode: null,
          gradeConfigId: null,
        },
      });
      const link = await tx.guardianLink.create({
        data: {
          accountId: session.accountId!,
          studentProfileId: student.id,
        },
      });
      await tx.consentRecord.create({
        data: {
          studentProfileId: student.id,
          guardianLinkId: link.id,
          consentPolicyId: policy.id,
          documentVersionId: lockedDocument.id,
          scopeSnapshot: lockedDocument.scopeCanonicalJson,
          scopeDigest: lockedDocument.scopeDigest,
          scopeSchemaVersion: '1',
          digestAlgorithmVersion: 'sha256-v1',
          ageBandSnapshot: age.band,
          grantedByAccountId: session.accountId!,
          grantedAt: now,
        },
      });
      await this.idempotency.complete(tx, begun.recordId, 'StudentProfile', student.id, 201, now);
      await this.identity.touchLastSeenLocked(tx, session, now);
      return { student, now };
    }, planned);
    return this.createdPayload(created.student, created.now);
  }

  async get(session: DeviceSession, studentId: string) {
    const graph = await this.collectStudentGraph(studentId, {
      accountIds: [...(session.accountId ? [session.accountId] : []), ...(session.issuedByAccountId ? [session.issuedByAccountId] : [])],
      sessionIds: [session.id],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      const discovered = await this.discoverStudentGraph(tx, studentId, session);
      assertLockSetComplete(locked, discovered);
      const now = await readLockedNow(tx);
      const current = await this.identity.assertSessionCurrent(tx, session, { now });
      const student = await this.authorizeLocked(tx, current, studentId, 'PROFILE_READ');
      const presented = await this.present(student, tx);
      await this.identity.touchLastSeenLocked(tx, current, now);
      return presented;
    }, graph);
  }

  async patch(session: DeviceSession, studentId: string, input: PatchStudentInput, idempotencyKey: string) {
    this.assertGuardian(session);
    if (input.kind === 'AGE' || input.kind === 'EDUCATION') {
      this.identity.requireStepUp(session);
    }
    const action: GuardianAction =
      input.kind === 'AGE'
        ? 'PROFILE_UPDATE_AGE'
        : input.kind === 'BASIC'
          ? 'PROFILE_UPDATE_BASIC'
          : 'PROFILE_UPDATE_EDUCATION_SNAPSHOT';
    await this.authorize(session, studentId, action);
    const actor = this.actor(session);
    const requestDigest = this.idempotency.requestDigest({ operation: 'students.patch', studentId, input });
    const existingIdem = await this.idempotency.peekId(this.prisma, actor, 'students.patch', idempotencyKey);
    const preview = await this.prisma.studentProfile.findUnique({ where: { id: studentId } });
    const gradeConfigIds = [
      ...(input.kind === 'EDUCATION' && input.gradeConfigId ? [input.gradeConfigId] : []),
      ...(preview?.gradeConfigId ? [preview.gradeConfigId] : []),
    ];
    const graph = await this.collectStudentGraph(studentId, {
      accountIds: [session.accountId!],
      sessionIds: [session.id],
      idempotencyIds: existingIdem ? [existingIdem] : [],
      gradeConfigIds,
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId, session));
      const now = await readLockedNow(tx);
      const student = await this.reauthorize(
        tx,
        session,
        studentId,
        action,
        input.kind === 'AGE' || input.kind === 'EDUCATION',
        now,
      );
      const begun = await this.idempotency.begin(tx, actor, 'students.patch', idempotencyKey, requestDigest, now);
      if (begun.kind === 'REPLAY' && begun.resourceId) {
        const presented = await this.present(await tx.studentProfile.findUniqueOrThrow({ where: { id: begun.resourceId } }), tx);
        await this.identity.touchLastSeenLocked(tx, session, now);
        return presented;
      }
      if (student.version !== input.expectedVersion) {
        throw new AppError('VERSION_CONFLICT', '档案版本已变化', 409, { version: String(student.version) });
      }
      if (input.kind === 'AGE') {
        const age = decideAgeBand(input.band);
        if (!age.ok) {
          throw new AppError(age.code, '当前年龄段不能使用', 422);
        }
        const policy = await tx.consentPolicy.findUnique({
          where: { policyKey_locale: { policyKey: age.policyKey, locale: 'zh-CN' } },
        });
        if (!policy?.currentDocumentVersionId) {
          throw new AppError('CONSENT_REQUIRED', '测试政策尚未发布', 422);
        }
        const current = await tx.consentRecord.findFirst({
          where: {
            studentProfileId: studentId,
            consentPolicyId: policy.id,
            withdrawnAt: null,
            supersededAt: null,
            documentVersionId: policy.currentDocumentVersionId,
          },
        });
        const updated = await tx.studentProfile.updateMany({
          where: { id: student.id, version: student.version },
          data: {
            ageBand: input.band,
            ageConfirmationSource: 'GUARDIAN_DECLARATION',
            ageConfirmedAt: now,
            ageConfirmedByAccountId: session.accountId!,
            version: { increment: 1 },
            ...(current
              ? {}
              : { status: 'RESTRICTED', restrictedAt: now }),
          },
        });
        if (updated.count === 0) {
          throw new AppError('VERSION_CONFLICT', '档案版本已变化', 409);
        }
        if (!current) {
          await this.revokeStudentAccess(tx, studentId, now, 'AGE_POLICY_MISSING');
        }
      } else if (input.kind === 'BASIC') {
        const updated = await tx.studentProfile.updateMany({
          where: { id: student.id, version: student.version },
          data: {
            nickname: input.nickname ?? student.nickname,
            avatarPresetId: input.avatarPresetId ?? student.avatarPresetId,
            timezone: input.timezone ?? student.timezone,
            version: { increment: 1 },
          },
        });
        if (updated.count === 0) {
          throw new AppError('VERSION_CONFLICT', '档案版本已变化', 409);
        }
      } else {
        await this.applyEducation(tx, session, student, input, now);
      }
      const latest = await tx.studentProfile.findUniqueOrThrow({ where: { id: studentId } });
      await this.idempotency.complete(tx, begun.recordId, 'StudentProfile', latest.id, 200, now);
      const presented = await this.present(latest, tx);
      await this.identity.touchLastSeenLocked(tx, session, now);
      return presented;
    }, graph);
  }

  async listEducationChanges(session: DeviceSession, studentId: string) {
    const graph = await this.collectStudentGraph(studentId, {
      accountIds: [...(session.accountId ? [session.accountId] : []), ...(session.issuedByAccountId ? [session.issuedByAccountId] : [])],
      sessionIds: [session.id],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId, session));
      const now = await readLockedNow(tx);
      const current = await this.identity.assertSessionCurrent(tx, session, { now });
      await this.authorizeLocked(tx, current, studentId, 'PROFILE_READ');
      const items = await tx.studentEducationHistory.findMany({
        where: { studentProfileId: studentId },
        orderBy: { createdAt: 'desc' },
      });
      await this.identity.touchLastSeenLocked(tx, current, now);
      return {
        items: items.map((item) => ({
          id: item.id,
          changeKind: item.changeKind,
          from: {
            gradeConfigId: item.fromGradeConfigId,
            stageCode: item.fromStageCode,
            schoolSystemCode: item.fromSchoolSystemCode,
            gradeCode: item.fromGradeCode,
            gradeLabel: item.fromGradeLabel,
            termCode: item.fromTermCode,
          },
          to: {
            gradeConfigId: item.toGradeConfigId,
            stageCode: item.toStageCode,
            schoolSystemCode: item.toSchoolSystemCode,
            gradeCode: item.toGradeCode,
            gradeLabel: item.toGradeLabel,
            termCode: item.toTermCode,
          },
          effectiveLocalDate: item.effectiveLocalDate,
          timezoneSnapshot: item.timezoneSnapshot,
          createdAt: item.createdAt.toISOString(),
        })),
      };
    }, graph);
  }

  async withdraw(
    session: DeviceSession,
    studentId: string,
    consentId: string,
    input: WithdrawConsentInput,
    idempotencyKey: string,
  ) {
    this.assertGuardian(session);
    this.identity.requireStepUp(session);
    await this.authorize(session, studentId, 'CONSENT_WITHDRAW');
    const actor = this.actor(session);
    const requestDigest = this.idempotency.requestDigest({
      operation: 'consents.withdraw',
      studentId,
      consentId,
      input,
    });
    const existingIdem = await this.idempotency.peekId(this.prisma, actor, 'consents.withdraw', idempotencyKey);
    const graph = await this.collectStudentGraph(studentId, {
      accountIds: [session.accountId!],
      consentIds: [consentId],
      sessionIds: [session.id],
      idempotencyIds: existingIdem ? [existingIdem] : [],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId, session, [consentId]));
      const now = await readLockedNow(tx);
      await this.reauthorize(tx, session, studentId, 'CONSENT_WITHDRAW', true, now);
      const begun = await this.idempotency.begin(tx, actor, 'consents.withdraw', idempotencyKey, requestDigest, now);
      if (begun.kind === 'REPLAY' && begun.resourceId) {
        const student = await tx.studentProfile.findUniqueOrThrow({ where: { id: studentId } });
        await this.identity.touchLastSeenLocked(tx, session, now);
        return { consentId: begun.resourceId, status: student.status };
      }
      const target = await tx.consentRecord.findFirst({
        where: { id: consentId, studentProfileId: studentId },
      });
      if (!target) {
        throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
      }
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId, session, [target.id]));
        if (replayWithdrawEffect(target) === 'WITHDRAW') {
        await tx.consentRecord.update({
          where: { id: target.id },
          data: {
            withdrawnAt: now,
            withdrawnByAccountId: session.accountId!,
            withdrawalReasonCode: input.reasonCode,
          },
        });
        const student = await tx.studentProfile.findUniqueOrThrow({ where: { id: studentId } });
        if (await this.missingRequiredConsent(tx, studentId, student.ageBand)) {
          await tx.studentProfile.update({
            where: { id: studentId },
            data: { status: 'RESTRICTED', restrictedAt: now },
          });
          await this.revokeStudentAccess(tx, studentId, now, 'CONSENT_WITHDRAWN');
        }
      }
      const student = await tx.studentProfile.findUniqueOrThrow({ where: { id: studentId } });
      await this.idempotency.complete(tx, begun.recordId, 'ConsentRecord', consentId, 200, now);
      await this.identity.touchLastSeenLocked(tx, session, now);
      return { consentId, status: student.status };
    }, graph);
  }

  async grant(session: DeviceSession, studentId: string, input: GrantConsentInput, idempotencyKey: string) {
    this.assertGuardian(session);
    this.identity.requireStepUp(session);
    const student = await this.authorize(session, studentId, 'CONSENT_GRANT');
    if (student.version !== input.expectedStudentVersion) {
      throw new AppError('VERSION_CONFLICT', '档案版本已变化', 409);
    }
    const age = decideAgeBand(student.ageBand);
    if (!age.ok) {
      throw new AppError(age.code, '当前年龄段不能授权', 422);
    }
    const policy = await this.requirePublishedPolicy(age.policyKey);
    const accepted = input.acceptances.find(
      (item) => item.policyKey === age.policyKey && item.version === policy.document.version,
    );
    if (!accepted) {
      throw new AppError('CONSENT_VERSION_CHANGED', '政策版本已变化', 409);
    }
    const actor = this.actor(session);
    const requestDigest = this.idempotency.requestDigest({ operation: 'consents.grant', studentId, input });
    const existingIdem = await this.idempotency.peekId(this.prisma, actor, 'consents.grant', idempotencyKey);
    const graph = await this.collectStudentGraph(studentId, {
      accountIds: [session.accountId!],
      policies: [{ id: policy.id, policyKey: policy.policyKey, locale: policy.locale }],
      sessionIds: [session.id],
      idempotencyIds: existingIdem ? [existingIdem] : [],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId, session));
      const now = await readLockedNow(tx);
      const current = await this.reauthorize(tx, session, studentId, 'CONSENT_GRANT', true, now);
      if (current.version !== input.expectedStudentVersion) {
        throw new AppError('VERSION_CONFLICT', '档案版本已变化', 409);
      }
      const begun = await this.idempotency.begin(tx, actor, 'consents.grant', idempotencyKey, requestDigest, now);
      if (begun.kind === 'REPLAY') {
        const presented = await this.present(await tx.studentProfile.findUniqueOrThrow({ where: { id: studentId } }), tx);
        await this.identity.touchLastSeenLocked(tx, session, now);
        return presented;
      }
      const link = await tx.guardianLink.findFirstOrThrow({
        where: { accountId: session.accountId!, studentProfileId: studentId, status: 'ACTIVE' },
      });
      const lockedPolicy = await tx.consentPolicy.findUniqueOrThrow({ where: { id: policy.id } });
      const lockedDocument = await tx.consentDocumentVersion.findUniqueOrThrow({
        where: { id: lockedPolicy.currentDocumentVersionId! },
      });
      if (lockedDocument.version !== accepted.version) {
        throw new AppError('CONSENT_VERSION_CHANGED', '政策版本已变化', 409);
      }
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId, session));
      await tx.consentRecord.updateMany({
        where: { studentProfileId: studentId, consentPolicyId: policy.id, withdrawnAt: null, supersededAt: null },
        data: { supersededAt: now },
      });
      const created = await tx.consentRecord.create({
        data: {
          studentProfileId: studentId,
          guardianLinkId: link.id,
          consentPolicyId: policy.id,
          documentVersionId: lockedDocument.id,
          scopeSnapshot: lockedDocument.scopeCanonicalJson,
          scopeDigest: lockedDocument.scopeDigest,
          scopeSchemaVersion: '1',
          digestAlgorithmVersion: 'sha256-v1',
          ageBandSnapshot: current.ageBand,
          grantedByAccountId: session.accountId!,
          grantedAt: now,
        },
      });
      await tx.studentProfile.update({
        where: { id: studentId },
        data: { status: 'ONBOARDING', restrictedAt: null, version: { increment: 1 } },
      });
      const latest = await tx.studentProfile.findUniqueOrThrow({ where: { id: studentId } });
      const activation = await this.activationFor(tx, latest);
      if (activation.status !== latest.status) {
        await tx.studentProfile.update({
          where: { id: studentId },
          data: { status: activation.status },
        });
      }
      await this.idempotency.complete(tx, begun.recordId, 'ConsentRecord', created.id, 200, now);
      const presented = await this.present(
        await tx.studentProfile.findUniqueOrThrow({ where: { id: studentId } }),
        tx,
      );
      await this.identity.touchLastSeenLocked(tx, session, now);
      return presented;
    }, graph);
  }

  async listConsents(session: DeviceSession, studentId: string) {
    const graph = await this.collectStudentGraph(studentId, {
      accountIds: [...(session.accountId ? [session.accountId] : []), ...(session.issuedByAccountId ? [session.issuedByAccountId] : [])],
      sessionIds: [session.id],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId, session));
      const now = await readLockedNow(tx);
      const current = await this.identity.assertSessionCurrent(tx, session, { now });
      await this.authorizeLocked(tx, current, studentId, 'CONSENT_READ');
      const items = await tx.consentRecord.findMany({
        where: { studentProfileId: studentId },
        orderBy: { grantedAt: 'desc' },
        include: { policy: true, document: true },
      });
      await this.identity.touchLastSeenLocked(tx, current, now);
      return {
        items: items.map((item) => ({
          id: item.id,
          policyKey: item.policy.policyKey,
          version: item.document.version,
          grantedAt: item.grantedAt.toISOString(),
          withdrawnAt: item.withdrawnAt?.toISOString() ?? null,
          current: item.withdrawnAt === null && item.supersededAt === null,
        })),
      };
    }, graph);
  }

  async createPairing(session: DeviceSession, studentId: string, idempotencyKey: string) {
    this.assertGuardian(session);
    this.identity.requireStepUp(session);
    await this.authorize(session, studentId, 'PAIRING_CREATE');
    const actor = this.actor(session);
    const requestDigest = this.idempotency.requestDigest({ operation: 'pairings.create', studentId });
    const prior = await this.prisma.idempotencyRecord.findUnique({
      where: {
        actorScope_actorId_operation_keyDigest: {
          actorScope: actor.actorScope,
          actorId: actor.actorId,
          operation: 'pairings.create',
          keyDigest: this.idempotency.digestKey(actor, 'pairings.create', idempotencyKey),
        },
      },
    });
    if (!prior?.completedAt) {
      await this.rateLimit.consume(`pairing:student:${studentId}`, 60 * 60 * 1000, 5, new Date());
      const last = await this.prisma.devicePairing.findFirst({
        where: { studentProfileId: studentId },
        orderBy: { createdAt: 'desc' },
      });
      if (last && Date.now() - last.createdAt.getTime() < 30_000) {
        throw new AppError('RATE_LIMITED', '请稍后再试', 429);
      }
    }
    const raw = encodeCrockford(randomBytes(5)).slice(0, 8);
    const existingIdem = await this.idempotency.peekId(this.prisma, actor, 'pairings.create', idempotencyKey);
    const graph = await this.collectStudentGraph(studentId, {
      accountIds: [session.accountId!],
      sessionIds: [session.id],
      idempotencyIds: existingIdem ? [existingIdem] : [],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId, session));
      const now = await readLockedNow(tx);
      const current = await this.reauthorize(tx, session, studentId, 'PAIRING_CREATE', true, now);
      await this.assertFreshRequiredConsent(tx, current.id, current.ageBand);
      const begun = await this.idempotency.begin(tx, actor, 'pairings.create', idempotencyKey, requestDigest, now);
      if (begun.kind === 'REPLAY') {
        await this.identity.touchLastSeenLocked(tx, session, now);
        return {
          secretState: 'NOT_REPLAYABLE' as const,
          pairingId: begun.resourceId,
          expiresAt: null,
        };
      }
      const link = await tx.guardianLink.findFirstOrThrow({
        where: { accountId: session.accountId!, studentProfileId: studentId, status: 'ACTIVE' },
      });
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId, session));
      await tx.devicePairing.updateMany({
        where: { studentProfileId: studentId, consumedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      const pairing = await tx.devicePairing.create({
        data: {
          studentProfileId: studentId,
          issuedByGuardianLinkId: link.id,
          createdByAccountId: session.accountId!,
          createdBySessionId: session.id,
          codeDigest: hmacHex(this.config.keys.pairing, raw),
          digestKeyVersion: 'v1',
          maxAttempts: this.config.timing.pairingMaxAttempts,
          expiresAt: new Date(now.getTime() + this.config.timing.pairingTtlMs),
        },
      });
      await this.idempotency.complete(tx, begun.recordId, 'DevicePairing', pairing.id, 201, now);
      await this.identity.touchLastSeenLocked(tx, session, now);
      return {
        secretState: 'ISSUED' as const,
        pairingId: pairing.id,
        code: formatPairingCode(raw),
        expiresAt: pairing.expiresAt.toISOString(),
      };
    }, graph);
  }

  async revokePairing(session: DeviceSession, studentId: string, pairingId: string, idempotencyKey: string) {
    this.assertGuardian(session);
    this.identity.requireStepUp(session);
    await this.authorize(session, studentId, 'PAIRING_REVOKE');
    const actor = this.actor(session);
    const requestDigest = this.idempotency.requestDigest({ operation: 'pairings.revoke', studentId, pairingId });
    const existingIdem = await this.idempotency.peekId(this.prisma, actor, 'pairings.revoke', idempotencyKey);
    const graph = await this.collectStudentGraph(studentId, {
      accountIds: [session.accountId!],
      pairingIds: [pairingId],
      sessionIds: [session.id],
      idempotencyIds: existingIdem ? [existingIdem] : [],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId, session, [], [], pairingId));
      const now = await readLockedNow(tx);
      await this.reauthorize(tx, session, studentId, 'PAIRING_REVOKE', true, now);
      const begun = await this.idempotency.begin(tx, actor, 'pairings.revoke', idempotencyKey, requestDigest, now);
      if (begun.kind === 'REPLAY') {
        await this.identity.touchLastSeenLocked(tx, session, now);
        return { pairingId, revoked: true };
      }
      const pairing = await tx.devicePairing.findFirst({
        where: { id: pairingId, studentProfileId: studentId },
      });
      if (!pairing) {
        throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
      }
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId, session));
      if (!pairing.revokedAt && !pairing.consumedAt) {
        await tx.devicePairing.update({
          where: { id: pairing.id },
          data: { revokedAt: now },
        });
      }
      await this.idempotency.complete(tx, begun.recordId, 'DevicePairing', pairing.id, 200, now);
      await this.identity.touchLastSeenLocked(tx, session, now);
      return { pairingId, revoked: true };
    }, graph);
  }

  async listDeviceSessions(session: DeviceSession, studentId: string) {
    const graph = await this.collectStudentGraph(studentId, {
      accountIds: [...(session.accountId ? [session.accountId] : []), ...(session.issuedByAccountId ? [session.issuedByAccountId] : [])],
      sessionIds: [session.id],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId, session));
      const now = await readLockedNow(tx);
      const current = await this.identity.assertSessionCurrent(tx, session, { now });
      await this.authorizeLocked(tx, current, studentId, 'DEVICE_SESSION_READ');
      const items = await tx.deviceSession.findMany({
        where: { studentProfileId: studentId },
        orderBy: { createdAt: 'desc' },
      });
      await this.identity.touchLastSeenLocked(tx, current, now);
      return {
        items: items.map((item) => ({
          id: item.id,
          scope: item.scope,
          deviceLabel: item.deviceLabel,
          createdAt: item.createdAt.toISOString(),
          lastSeenAt: item.lastSeenAt?.toISOString() ?? null,
          expiresAt: item.expiresAt.toISOString(),
          revokedAt: item.revokedAt?.toISOString() ?? null,
        })),
      };
    }, graph);
  }

  async revokeDeviceSession(
    session: DeviceSession,
    studentId: string,
    sessionId: string,
    reasonCode: string,
    idempotencyKey: string,
  ) {
    this.assertGuardian(session);
    this.identity.requireStepUp(session);
    await this.authorize(session, studentId, 'DEVICE_SESSION_REVOKE');
    const actor = this.actor(session);
    const requestDigest = this.idempotency.requestDigest({
      operation: 'device-sessions.revoke',
      studentId,
      sessionId,
      reasonCode,
    });
    const existingIdem = await this.idempotency.peekId(this.prisma, actor, 'device-sessions.revoke', idempotencyKey);
    const graph = await this.collectStudentGraph(studentId, {
      accountIds: [session.accountId!],
      sessionIds: [session.id, sessionId],
      idempotencyIds: existingIdem ? [existingIdem] : [],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      const lineage = await collectForwardLineageIds(tx, [sessionId]);
      assertLockSetComplete(
        locked,
        await this.discoverStudentGraph(tx, studentId, session, [], lineage),
      );
      const now = await readLockedNow(tx);
      await this.reauthorize(tx, session, studentId, 'DEVICE_SESSION_REVOKE', true, now);
      const begun = await this.idempotency.begin(
        tx,
        actor,
        'device-sessions.revoke',
        idempotencyKey,
        requestDigest,
        now,
      );
      const target = await tx.deviceSession.findFirst({
        where: { id: sessionId, studentProfileId: studentId, scope: 'STUDENT' },
      });
      if (!target) {
        throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
      }
      if (begun.kind === 'REPLAY') {
        await revokeActiveLineage(tx, target.id, now, reasonCode);
        await this.identity.touchLastSeenLocked(tx, session, now);
        return { sessionId, revoked: true };
      }
      await revokeActiveLineage(tx, target.id, now, reasonCode);
      await this.idempotency.complete(tx, begun.recordId, 'DeviceSession', target.id, 200, now);
      await this.identity.touchLastSeenLocked(tx, session, now);
      return { sessionId, revoked: true };
    }, graph);
  }

  async consumePairing(pairingId: string, code: string, installationId: string, origin: string) {
    const rateNow = new Date();
    const normalized = normalizePairingCode(code);
    const preview = await this.prisma.devicePairing.findUnique({ where: { id: pairingId } });
    if (!preview || !normalized) {
      throw new AppError('PAIRING_INVALID', '配对无效', 401);
    }
    const accepted =
      hmacHex(this.config.keys.pairing, normalized) === preview.codeDigest &&
      !preview.consumedAt &&
      !preview.revokedAt &&
      !preview.lockedAt &&
      !isExpired(rateNow, preview.expiresAt);
    if (!accepted) {
      await this.recordPairingFailure(preview.id);
      throw new AppError('PAIRING_INVALID', '配对无效', 401);
    }

    const graph = await this.collectStudentGraph(preview.studentProfileId, {
      accountIds: [preview.createdByAccountId],
      pairingIds: [preview.id],
    });
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const created = await runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      const pairing = await tx.devicePairing.findUnique({ where: { id: preview.id } });
      const student = await tx.studentProfile.findUnique({ where: { id: preview.studentProfileId } });
      const link = await tx.guardianLink.findUnique({ where: { id: preview.issuedByGuardianLinkId } });
      if (!pairing || !student || !link) {
        throw new AppError('PAIRING_INVALID', '配对无效', 401);
      }
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, student.id, null, [], [], pairing.id));
      const now = await readLockedNow(tx);
      if (
        link.status !== 'ACTIVE' ||
        !guardianMay(asProfileStatus(student.status), 'PAIRING_CREATE') ||
        pairing.consumedAt ||
        pairing.revokedAt ||
        pairing.lockedAt ||
        isExpired(now, pairing.expiresAt)
      ) {
        throw new AppError('PAIRING_INVALID', '配对无效', 401);
      }
      const currentConsent = await tx.consentRecord.findFirst({
        where: { studentProfileId: student.id, withdrawnAt: null, supersededAt: null },
      });
      if (!currentConsent) {
        throw new AppError('PAIRING_INVALID', '配对无效', 401);
      }
      try {
        await this.assertFreshRequiredConsent(tx, student.id, student.ageBand);
      } catch {
        throw new AppError('PAIRING_INVALID', '配对无效', 401);
      }
      const issuer = await tx.account.findUniqueOrThrow({ where: { id: pairing.createdByAccountId } });
      if (issuer.status !== 'ACTIVE') {
        throw new AppError('PAIRING_INVALID', '配对无效', 401);
      }
      const session = await tx.deviceSession.create({
        data: {
          scope: 'STUDENT',
          studentProfileId: pairing.studentProfileId,
          issuedByGuardianLinkId: pairing.issuedByGuardianLinkId,
          issuedByAccountId: pairing.createdByAccountId,
          origin,
          credentialDigest: sha256Hex(sessionToken),
          csrfDigest: sha256Hex(csrfToken),
          issuerAuthVersionAtIssue: issuer.authVersion,
          deviceInstallationDigest: sha256Hex(installationId),
          authenticatedAt: now,
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + this.config.timing.studentAbsoluteMs),
        },
      });
      const consumed = await tx.devicePairing.updateMany({
        where: { id: pairing.id, consumedAt: null, revokedAt: null, lockedAt: null },
        data: { consumedAt: now, consumedBySessionId: session.id },
      });
      if (consumed.count !== 1) {
        throw new AppError('PAIRING_INVALID', '配对无效', 401);
      }
      return { session, studentId: pairing.studentProfileId, now };
    }, graph);
    return {
      body: {
        session: {
          scope: 'STUDENT' as const,
          studentId: created.studentId,
          expiresAt: created.session.expiresAt.toISOString(),
          stepUpValidUntil: null,
        },
        serverTime: created.now.toISOString(),
      },
      sessionToken,
      csrfToken,
    };
  }

  async enterStudentMode(session: DeviceSession, studentId: string, origin: string) {
    this.assertGuardian(session);
    this.identity.requireStepUp(session);
    await this.authorize(session, studentId, 'STUDENT_MODE_CREATE');
    const graph = await this.collectStudentGraph(studentId, {
      accountIds: [session.accountId!],
      sessionIds: [session.id],
    });
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const successorId = randomUUID();
    const created = await runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId, session));
      const now = await readLockedNow(tx);
      const current = await this.reauthorize(tx, session, studentId, 'STUDENT_MODE_CREATE', true, now);
      await this.assertFreshRequiredConsent(tx, current.id, current.ageBand);
      const link = await tx.guardianLink.findFirstOrThrow({
        where: { accountId: session.accountId!, studentProfileId: studentId, status: 'ACTIVE' },
      });
      const issuer = await tx.account.findUniqueOrThrow({ where: { id: session.accountId! } });
      const studentSession = await issueReplacementSession(tx, {
        predecessorId: session.id,
        reason: 'REPLACED_BY_STUDENT_MODE',
        lockedNow: now,
        successor: {
          id: successorId,
          scope: 'STUDENT',
          studentProfileId: studentId,
          issuedByGuardianLinkId: link.id,
          issuedByAccountId: session.accountId!,
          origin,
          credentialDigest: sha256Hex(sessionToken),
          csrfDigest: sha256Hex(csrfToken),
          issuerAuthVersionAtIssue: issuer.authVersion,
          deviceInstallationDigest: session.deviceInstallationDigest,
          authenticatedAt: now,
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + this.config.timing.studentAbsoluteMs),
        },
      });
      return { session: studentSession, now };
    }, graph);
    return {
      body: {
        session: {
          scope: 'STUDENT' as const,
          studentId,
          expiresAt: created.session.expiresAt.toISOString(),
          stepUpValidUntil: null,
        },
        serverTime: created.now.toISOString(),
      },
      sessionToken,
      csrfToken,
    };
  }

  async revokeGuardianLink(accountId: string, studentId: string, reasonCode: string) {
    const graph = await this.collectStudentGraph(studentId, { accountIds: [accountId] });
    await runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.discoverStudentGraph(tx, studentId));
      const now = await readLockedNow(tx);
      const link = await tx.guardianLink.findFirst({
        where: { accountId, studentProfileId: studentId, status: 'ACTIVE' },
      });
      if (!link) {
        return;
      }
      await tx.guardianLink.update({
        where: { id: link.id },
        data: {
          status: 'REVOKED',
          revokedAt: now,
          revokedByAccountId: accountId,
          revocationReasonCode: reasonCode,
        },
      });
      await this.revokeStudentAccess(tx, studentId, now, 'GUARDIAN_LINK_REVOKED');
      const remainingPrimary = await tx.guardianLink.count({
        where: { studentProfileId: studentId, status: 'ACTIVE', role: 'PRIMARY_GUARDIAN' },
      });
      if (remainingPrimary === 0) {
        await tx.studentProfile.update({
          where: { id: studentId },
          data: { status: 'RESTRICTED', restrictedAt: now },
        });
      }
    }, graph);
  }

  async documents(session: DeviceSession, ageBand: 'UNDER_14' | 'AGE_14_TO_17' | 'AGE_18_PLUS') {
    const planned: LockIds = {
      sessionIds: [session.id],
      accountIds: session.accountId ? [session.accountId] : [],
    };
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(planned, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, {
        sessionIds: [session.id],
        accountIds: session.accountId ? [session.accountId] : [],
      });
      const now = await readLockedNow(tx);
      const current = await this.identity.assertSessionCurrent(tx, session, { now });
      this.assertGuardian(current);
      const age = decideAgeBand(ageBand);
      if (!age.ok) {
        throw new AppError(age.code, '当前年龄段没有可接受政策', 422);
      }
      const policy = await this.requirePublishedPolicy(age.policyKey);
      await this.identity.touchLastSeenLocked(tx, current, now);
      return {
        policyKey: policy.policyKey,
        version: policy.document.version,
        contentBody: policy.document.contentBody,
        testDocument: true,
      };
    }, planned);
  }

  private async recordPairingFailure(id: string): Promise<void> {
    const planned: LockIds = { pairingIds: [id] };
    await runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(planned, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, { pairingIds: [id] });
      const now = await readLockedNow(tx);
      const row = await tx.devicePairing.findUnique({ where: { id } });
      if (!row || row.consumedAt || row.revokedAt) {
        return;
      }
      const next = nextAttemptState(row.attemptCount, row.maxAttempts, false);
      await tx.devicePairing.update({
        where: { id },
        data: { attemptCount: next.attemptCount, lockedAt: next.locked ? now : row.lockedAt },
      });
    }, planned);
  }

  private async revokeStudentAccess(
    tx: Prisma.TransactionClient,
    studentId: string,
    now: Date,
    reason: string,
  ): Promise<void> {
    await tx.deviceSession.updateMany({
      where: { studentProfileId: studentId, revokedAt: null, scope: 'STUDENT' },
      data: { revokedAt: now, revocationReasonCode: reason },
    });
    await tx.devicePairing.updateMany({
      where: { studentProfileId: studentId, consumedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private async requirePublishedPolicy(policyKey: string) {
    const policy = await this.prisma.consentPolicy.findUnique({
      where: { policyKey_locale: { policyKey, locale: 'zh-CN' } },
    });
    if (!policy?.currentDocumentVersionId) {
      throw new AppError('CONSENT_REQUIRED', '测试政策尚未发布', 422);
    }
    const document = await this.prisma.consentDocumentVersion.findUnique({
      where: { id: policy.currentDocumentVersionId },
    });
    if (!document?.publishedAt) {
      throw new AppError('CONSENT_REQUIRED', '测试政策尚未发布', 422);
    }
    return { ...policy, document };
  }

  async assertFreshRequiredConsent(
    db: Prisma.TransactionClient | PrismaService,
    studentId: string,
    ageBand: string,
  ): Promise<void> {
    const age = decideAgeBand(ageBand as 'UNDER_14' | 'AGE_14_TO_17' | 'AGE_18_PLUS');
    if (!age.ok) {
      throw new AppError(age.code, '当前年龄段不能使用', 422);
    }
    const policy = await db.consentPolicy.findUnique({
      where: { policyKey_locale: { policyKey: age.policyKey, locale: 'zh-CN' } },
    });
    const consent = await db.consentRecord.findFirst({
      where: {
        studentProfileId: studentId,
        consentPolicyId: policy?.id,
        withdrawnAt: null,
        supersededAt: null,
      },
    });
    if (!policy?.currentDocumentVersionId || !consent || consent.documentVersionId !== policy.currentDocumentVersionId) {
      throw new AppError('CONSENT_REQUIRED', '需要接受当前测试政策', 422);
    }
  }

  private async missingRequiredConsent(
    db: Prisma.TransactionClient | PrismaService,
    studentId: string,
    ageBand: string,
  ): Promise<boolean> {
    return !(await this.consentIsCurrent(db, studentId, ageBand));
  }

  private async consentIsCurrent(
    db: Prisma.TransactionClient | PrismaService,
    studentId: string,
    ageBand: string,
  ): Promise<boolean> {
    try {
      await this.assertFreshRequiredConsent(db, studentId, ageBand);
      return consentCurrentFromVerifiedProbe();
    } catch (error) {
      return applyConsentProbeFailure(error);
    }
  }

  private localDate(now: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }

  private async applyEducation(
    tx: Prisma.TransactionClient,
    session: DeviceSession,
    student: {
      id: string;
      version: number;
      status: string;
      timezone: string;
      gradeConfigId: string | null;
      gradeConfigVersionId: string | null;
      stageCode: string | null;
      schoolSystemCode: string | null;
      gradeCode: string | null;
      gradeLabel: string | null;
      termCode: string | null;
      ageBand: string;
    },
    input: Extract<PatchStudentInput, { kind: 'EDUCATION' }>,
    now: Date,
  ) {
    const from = {
      gradeConfigId: student.gradeConfigId,
      gradeConfigVersionId: student.gradeConfigVersionId,
      stageCode: student.stageCode,
      schoolSystemCode: student.schoolSystemCode,
      gradeCode: student.gradeCode,
      gradeLabel: student.gradeLabel,
      termCode: student.termCode,
    };
    const catalog = await this.catalog.loadPublishedGrades(tx);
    const lastHistory = await tx.studentEducationHistory.findFirst({
      where: { studentProfileId: student.id },
      orderBy: { createdAt: 'desc' },
    });
    const target = input.gradeConfigId
      ? catalog.find((item) => item.id === input.gradeConfigId) ?? null
      : null;
    const transition = evaluateEducationChange({
      from,
      kind: input.changeKind,
      target,
      term: input.termCode ?? null,
      catalog,
      lastChangeKind: (lastHistory?.changeKind as EducationChangeKind | undefined) ?? null,
    });
    if (!transition.ok) {
      throw new AppError(transition.code, transition.message, 400);
    }
    const to = transition.to;
    const nextActivation = await this.activationFor(tx, {
      ...student,
      ...to,
      status: student.status === 'RESTRICTED' ? 'RESTRICTED' : 'ONBOARDING',
    });
    const nextStatus = student.status === 'RESTRICTED' ? 'RESTRICTED' : nextActivation.status;
    const updated = await tx.studentProfile.updateMany({
      where: { id: student.id, version: student.version },
      data: {
        gradeConfigId: to.gradeConfigId,
        gradeConfigVersionId: to.gradeConfigVersionId,
        stageCode: to.stageCode,
        schoolSystemCode: to.schoolSystemCode,
        gradeCode: to.gradeCode,
        gradeLabel: to.gradeLabel,
        termCode: to.termCode,
        status: nextStatus,
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      throw new AppError('VERSION_CONFLICT', '档案版本已变化', 409);
    }
    await tx.studentEducationHistory.create({
      data: {
        studentProfileId: student.id,
        changeKind: input.changeKind,
        fromGradeConfigId: from.gradeConfigId,
        toGradeConfigId: to.gradeConfigId,
        fromStageCode: from.stageCode,
        fromSchoolSystemCode: from.schoolSystemCode,
        fromGradeCode: from.gradeCode,
        fromGradeLabel: from.gradeLabel,
        fromTermCode: from.termCode,
        toStageCode: to.stageCode,
        toSchoolSystemCode: to.schoolSystemCode,
        toGradeCode: to.gradeCode,
        toGradeLabel: to.gradeLabel,
        toTermCode: to.termCode,
        actorAccountId: session.accountId!,
        effectiveLocalDate: input.effectiveLocalDate ?? this.localDate(now, student.timezone),
        timezoneSnapshot: student.timezone,
        createdAt: now,
      },
    });
  }

  private async present(
    student: {
      id: string;
      nickname: string;
      avatarPresetId: string;
      status: string;
      ageBand: string;
      version: number;
      stageCode?: string | null;
      schoolSystemCode?: string | null;
      gradeCode?: string | null;
      gradeLabel?: string | null;
      termCode?: string | null;
      gradeConfigId?: string | null;
      gradeConfigVersionId?: string | null;
    },
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return this.detail(student, db);
  }

  async collectStudentGraph(studentId: string, extra: LockIds = {}): Promise<LockIds> {
    return collectStudentAuthorizationGraph(this.prisma, studentId, extra);
  }

  async discoverStudentGraph(
    tx: Prisma.TransactionClient,
    studentId: string,
    session?: DeviceSession | null,
    extraConsents: string[] = [],
    extraSessions: string[] = [],
    extraPairing?: string,
  ): Promise<LockIds> {
    return discoverStudentAuthorizationGraph(tx, studentId, {
      session,
      extraConsents,
      extraSessions,
      extraPairing,
    });
  }

  async authorize(session: DeviceSession, studentId: string, action: GuardianAction) {
    return this.authorizeLocked(this.prisma, session, studentId, action);
  }

  private async authorizeLocked(
    db: Prisma.TransactionClient | PrismaService,
    session: DeviceSession,
    studentId: string,
    action: GuardianAction,
  ) {
    const student = await db.studentProfile.findUnique({ where: { id: studentId } });
    if (!student || isDeletionStatus(student.status)) {
      if (session.scope === 'STUDENT' && session.studentProfileId === studentId) {
        throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
      }
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
    }
    if (session.scope === 'STUDENT') {
      if (session.studentProfileId !== studentId) {
        throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
      }
      if (!studentMay(asProfileStatus(student.status), action)) {
        throw new AppError('SESSION_SCOPE_FORBIDDEN', '学生会话不能执行该操作', 403);
      }
      if (action === 'PROFILE_READ' && !studentMayReadSelf(asProfileStatus(student.status))) {
        throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
      }
      return student;
    }
    const link = await db.guardianLink.findFirst({
      where: { accountId: session.accountId!, studentProfileId: studentId, status: 'ACTIVE' },
    });
    if (!link) {
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
    }
    if (!guardianMay(asProfileStatus(student.status), action)) {
      throw new AppError('SESSION_SCOPE_FORBIDDEN', '当前档案状态不允许该操作', 403);
    }
    return student;
  }

  async reauthorize(
    tx: Prisma.TransactionClient,
    session: DeviceSession,
    studentId: string,
    action: GuardianAction,
    requireStepUp = false,
    now?: Date,
  ) {
    await this.assertWritableSession(tx, session, requireStepUp, now);
    return this.authorizeLocked(tx, session, studentId, action);
  }

  private async assertWritableSession(
    tx: Prisma.TransactionClient,
    session: DeviceSession,
    requireStepUp = false,
    now?: Date,
  ): Promise<void> {
    await this.identity.assertSessionCurrent(tx, session, { now: now ?? new Date(), requireStepUp });
  }

  private actor(session: DeviceSession) {
    this.assertGuardian(session);
    return { actorScope: 'GUARDIAN' as const, actorId: session.accountId! };
  }

  private assertGuardian(session: DeviceSession): void {
    if (session.scope !== 'GUARDIAN' || !session.accountId) {
      throw new AppError('SESSION_SCOPE_FORBIDDEN', '需要家长会话', 403);
    }
  }

  private createdPayload(created: { id: string; nickname: string; avatarPresetId: string; status: string; ageBand: string; version: number }, now: Date) {
    return {
      profile: this.summary(created),
      learningAccess: {
        allowed: false as const,
        reason: 'ACADEMIC_CONFIGURATION_PENDING' as const,
      },
      serverTime: now.toISOString(),
    };
  }

  private snapshotOf(student: {
    gradeConfigId?: string | null;
    gradeConfigVersionId?: string | null;
    stageCode?: string | null;
    schoolSystemCode?: string | null;
    gradeCode?: string | null;
    gradeLabel?: string | null;
    termCode?: string | null;
  }): EducationSnapshot {
    return {
      gradeConfigId: student.gradeConfigId ?? null,
      gradeConfigVersionId: student.gradeConfigVersionId ?? null,
      stageCode: student.stageCode ?? null,
      schoolSystemCode: student.schoolSystemCode ?? null,
      gradeCode: student.gradeCode ?? null,
      gradeLabel: student.gradeLabel ?? null,
      termCode: student.termCode ?? null,
    };
  }

  async activationFor(
    db: Prisma.TransactionClient | PrismaService,
    student: {
      id: string;
      status: string;
      ageBand: string;
      gradeConfigId?: string | null;
      gradeConfigVersionId?: string | null;
      stageCode?: string | null;
      schoolSystemCode?: string | null;
      gradeCode?: string | null;
      gradeLabel?: string | null;
      termCode?: string | null;
    },
  ) {
    const snapshot = this.snapshotOf(student);
    let matchesPublishedVersion = false;
    if (snapshot.gradeConfigId && snapshot.gradeConfigVersionId) {
      const config = await db.gradeConfig.findUnique({ where: { id: snapshot.gradeConfigId } });
      const version = await db.gradeConfigVersion.findUnique({ where: { id: snapshot.gradeConfigVersionId } });
      if (config && version) {
        matchesPublishedVersion = isEducationSnapshotMatchingVersion(
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
        );
      }
    }
    const consentCurrent = await this.consentIsCurrent(db, student.id, student.ageBand);
    return evaluateActivation({
      storedStatus: student.status,
      snapshot,
      matchesPublishedVersion,
      consentCurrent,
    });
  }

  private async detail(
    student: {
      id: string;
      nickname: string;
      avatarPresetId: string;
      status: string;
      ageBand: string;
      version: number;
      stageCode?: string | null;
      schoolSystemCode?: string | null;
      gradeCode?: string | null;
      gradeLabel?: string | null;
      termCode?: string | null;
      gradeConfigId?: string | null;
      gradeConfigVersionId?: string | null;
    },
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const snapshot = this.snapshotOf(student);
    const activation = await this.activationFor(db, student);
    let catalogEntryKey: string | null = null;
    if (snapshot.gradeConfigId) {
      const config = await db.gradeConfig.findUnique({ where: { id: snapshot.gradeConfigId } });
      if (config?.currentVersionId) {
        const version = await db.gradeConfigVersion.findUnique({ where: { id: config.currentVersionId } });
        catalogEntryKey = version?.catalogEntryKey ?? null;
      }
    }
    return {
      ...this.summary({ ...student, status: activation.status }),
      education: {
        gradeConfigId: snapshot.gradeConfigId,
        stageCode: snapshot.stageCode,
        schoolSystemCode: snapshot.schoolSystemCode,
        gradeCode: snapshot.gradeCode,
        gradeLabel: snapshot.gradeLabel,
        termCode: snapshot.termCode,
        catalogEntryKey,
      },
      learningAccess: activation.learningAccess,
    };
  }

  private summary(student: {
    id: string;
    nickname: string;
    avatarPresetId: string;
    status: string;
    ageBand: string;
    version: number;
  }) {
    return {
      id: student.id,
      nickname: student.nickname,
      avatarPresetId: student.avatarPresetId,
      status:
        student.status === 'RESTRICTED'
          ? ('RESTRICTED' as const)
          : student.status === 'ACTIVE'
            ? ('ACTIVE' as const)
            : ('ONBOARDING' as const),
      ageBand: student.ageBand as 'UNDER_14' | 'AGE_14_TO_17',
      version: student.version,
    };
  }
}

export const LOCAL_TEST_POLICIES = TEST_POLICY_KEYS;
