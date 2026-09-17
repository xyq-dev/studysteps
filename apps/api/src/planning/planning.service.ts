import { Injectable } from '@nestjs/common';
import type { DeviceSession, Prisma } from '@prisma/client';
import {
  canImportTemplates,
  consentCoversPlanWrites,
  decideAgeBand,
  expandSeriesOccurrences,
  horizonWindow,
  localDateInTimeZone,
  addLocalDays,
  normalizePreviewTasks,
  previewCanonicalPayload,
  manualPreviewCanonicalPayload,
  datesToMaterializeForPlan,
  occurrenceCancellableOnPlanHalt,
  occurrenceRestorableOnResume,
  planAllowsOccurrenceGeneration,
  resolvePlanStatusTransition,
  cancelReasonForPlanAction,
  type SeriesRule,
} from '@studysteps/domain';
import type {
  CreateManualPlanInput,
  ImportTemplateConfirmInput,
  PatchPlanInput,
  PreviewManualPlanInput,
  PreviewTemplateInput,
} from '@studysteps/contracts';
import { AppError } from '../common/app-error';
import { digestCanonical } from '../common/crypto';
import { IdempotencyService } from '../common/idempotency.service';
import {
  assertLockSetComplete,
  acquireLocks,
  IncompleteLockSetError,
  lockIdsContain,
  mergeLockIds,
  readLockedNow,
  runWriteTx,
} from '../common/lock-order';
import { IdentityService } from '../auth/identity.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService } from '../catalog/catalog.service';
import { StudentsService } from '../students/students.service';

type Tx = Prisma.TransactionClient;

@Injectable()
export class PlanningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
    private readonly identity: IdentityService,
    private readonly idempotency: IdempotencyService,
    private readonly catalog: CatalogService,
  ) {}

  async preview(session: DeviceSession, studentId: string, templateId: string, input: PreviewTemplateInput) {
    const graph = await this.students.collectStudentGraph(studentId, {
      accountIds: [...(session.accountId ? [session.accountId] : []), ...(session.issuedByAccountId ? [session.issuedByAccountId] : [])],
      sessionIds: [session.id],
      templateVersionIds: [templateId],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.students.discoverStudentGraph(tx, studentId, session));
      const now = await readLockedNow(tx);
      const current = await this.identity.assertSessionCurrent(tx, session, { now });
      const student = await this.students.reauthorize(tx, current, studentId, 'PLAN_READ', false, now);
      const built = await this.buildPreview(tx, student, templateId, input, now);
      await this.identity.touchLastSeenLocked(tx, current, now);
      return built;
    }, graph);
  }

  async importPlan(
    session: DeviceSession,
    studentId: string,
    templateId: string,
    input: ImportTemplateConfirmInput,
    idempotencyKey: string,
  ) {
    if (session.scope === 'GUARDIAN') {
      this.identity.requireStepUp(session);
      if (input.coCreationAttested !== true) {
        throw new AppError('VALIDATION_ERROR', '需要明确记录双方约定', 400, {
          coCreationAttested: 'required',
        });
      }
    } else if (input.coCreationAttested) {
      throw new AppError('VALIDATION_ERROR', '学生确认创建不使用双方约定字段', 400, {
        coCreationAttested: 'forbidden',
      });
    }
    await this.students.authorize(session, studentId, 'PLAN_CREATE');
    const actor =
      session.scope === 'GUARDIAN'
        ? { actorScope: 'GUARDIAN' as const, actorId: session.accountId! }
        : { actorScope: 'STUDENT' as const, actorId: session.id };
    const requestDigest = this.idempotency.requestDigest({
      operation: 'templates.import',
      studentId,
      templateId,
      input,
    });
    const existingIdem = await this.idempotency.peekId(this.prisma, actor, 'templates.import', idempotencyKey);
    const graph = await this.students.collectStudentGraph(studentId, {
      accountIds: [...(session.accountId ? [session.accountId] : []), ...(session.issuedByAccountId ? [session.issuedByAccountId] : [])],
      sessionIds: [session.id],
      templateVersionIds: [templateId],
      idempotencyIds: existingIdem ? [existingIdem] : [],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.students.discoverStudentGraph(tx, studentId, session));
      const now = await readLockedNow(tx);
      const currentSession = await this.identity.assertSessionCurrent(tx, session, {
        now,
        requireStepUp: session.scope === 'GUARDIAN',
      });
      const current = await this.students.reauthorize(
        tx,
        currentSession,
        studentId,
        'PLAN_CREATE',
        session.scope === 'GUARDIAN',
        now,
      );
      const begun = await this.idempotency.begin(tx, actor, 'templates.import', idempotencyKey, requestDigest, now);
      if (begun.kind === 'REPLAY' && begun.resourceId) {
        await this.identity.touchLastSeenLocked(tx, currentSession, now);
        return this.loadPlan(tx, studentId, begun.resourceId);
      }
      if (current.version !== input.expectedStudentVersion) {
        throw new AppError('VERSION_CONFLICT', '档案版本已变化', 409);
      }
      await this.students.assertFreshRequiredConsent(tx, current.id, current.ageBand);
      const activation = await this.students.activationFor(tx, current);
      if (!activation.learningAccess.allowed) {
        throw new AppError('LEARNING_ACCESS_BLOCKED', '当前学习访问未开通', 403);
      }
      const age = decideAgeBand(current.ageBand as 'UNDER_14' | 'AGE_14_TO_17' | 'AGE_18_PLUS');
      if (!age.ok) {
        throw new AppError(age.code, '当前年龄段不能创建计划', 422);
      }
      const policy = await tx.consentPolicy.findUnique({
        where: { policyKey_locale: { policyKey: age.policyKey, locale: 'zh-CN' } },
      });
      const currentDocument = policy?.currentDocumentVersionId
        ? await tx.consentDocumentVersion.findUnique({ where: { id: policy.currentDocumentVersionId } })
        : null;
      if (!currentDocument || !consentCoversPlanWrites(currentDocument.scopeCanonicalJson)) {
        throw new AppError('LEARNING_ACCESS_BLOCKED', '当前同意未覆盖计划与任务', 403);
      }
      const preview = await this.buildPreview(tx, current, templateId, { tasks: input.tasks }, now);
      if (preview.template.version !== input.templateVersion || preview.previewDigest !== input.previewDigest) {
        throw new AppError('PLAN_PREVIEW_STALE', '预览已过期，请重新预览', 409);
      }
      if (!preview.confirmAllowed) {
        throw new AppError(
          preview.blockCode === 'TEMPLATE_IMPORT_NOT_ALLOWED' ? 'TEMPLATE_IMPORT_NOT_ALLOWED' : 'LEARNING_ACCESS_BLOCKED',
          preview.blockReason ?? '不能确认创建计划',
          preview.blockCode === 'TEMPLATE_IMPORT_NOT_ALLOWED' ? 400 : 403,
        );
      }
      const plan = await this.persistConfirmedPlan(tx, currentSession, current, preview, now, templateId);
      await this.idempotency.complete(tx, begun.recordId, 'StudyPlan', plan.id, 201, now);
      await this.identity.touchLastSeenLocked(tx, currentSession, now);
      return this.loadPlan(tx, studentId, plan.id);
    }, graph);
  }

  async previewManual(session: DeviceSession, studentId: string, input: PreviewManualPlanInput) {
    const graph = await this.students.collectStudentGraph(studentId, {
      accountIds: [...(session.accountId ? [session.accountId] : []), ...(session.issuedByAccountId ? [session.issuedByAccountId] : [])],
      sessionIds: [session.id],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.students.discoverStudentGraph(tx, studentId, session));
      const now = await readLockedNow(tx);
      const current = await this.identity.assertSessionCurrent(tx, session, { now });
      const student = await this.students.reauthorize(tx, current, studentId, 'PLAN_READ', false, now);
      const built = await this.buildManualPreview(tx, student, input, now);
      await this.identity.touchLastSeenLocked(tx, current, now);
      return built;
    }, graph);
  }

  async createPlan(
    session: DeviceSession,
    studentId: string,
    input: CreateManualPlanInput,
    idempotencyKey: string,
  ) {
    this.assertCreateAttestation(session, input.coCreationAttested);
    await this.students.authorize(session, studentId, 'PLAN_CREATE');
    const actor =
      session.scope === 'GUARDIAN'
        ? { actorScope: 'GUARDIAN' as const, actorId: session.accountId! }
        : { actorScope: 'STUDENT' as const, actorId: session.id };
    const requestDigest = this.idempotency.requestDigest({
      operation: 'plans.create',
      studentId,
      input,
    });
    const existingIdem = await this.idempotency.peekId(this.prisma, actor, 'plans.create', idempotencyKey);
    const graph = await this.students.collectStudentGraph(studentId, {
      accountIds: [...(session.accountId ? [session.accountId] : []), ...(session.issuedByAccountId ? [session.issuedByAccountId] : [])],
      sessionIds: [session.id],
      idempotencyIds: existingIdem ? [existingIdem] : [],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.students.discoverStudentGraph(tx, studentId, session));
      const now = await readLockedNow(tx);
      const currentSession = await this.identity.assertSessionCurrent(tx, session, {
        now,
        requireStepUp: session.scope === 'GUARDIAN',
      });
      const current = await this.students.reauthorize(
        tx,
        currentSession,
        studentId,
        'PLAN_CREATE',
        session.scope === 'GUARDIAN',
        now,
      );
      const begun = await this.idempotency.begin(tx, actor, 'plans.create', idempotencyKey, requestDigest, now);
      if (begun.kind === 'REPLAY' && begun.resourceId) {
        await this.identity.touchLastSeenLocked(tx, currentSession, now);
        return this.loadPlan(tx, studentId, begun.resourceId);
      }
      if (current.version !== input.expectedStudentVersion) {
        throw new AppError('VERSION_CONFLICT', '档案版本已变化', 409);
      }
      await this.assertPlanWritePrereqs(tx, current);
      const preview = await this.buildManualPreview(tx, current, { tasks: input.tasks }, now);
      if (preview.previewDigest !== input.previewDigest) {
        throw new AppError('PLAN_PREVIEW_STALE', '预览已过期，请重新预览', 409);
      }
      const plan = await this.persistConfirmedPlan(tx, currentSession, current, preview, now, null);
      await this.idempotency.complete(tx, begun.recordId, 'StudyPlan', plan.id, 201, now);
      await this.identity.touchLastSeenLocked(tx, currentSession, now);
      return this.loadPlan(tx, studentId, plan.id);
    }, graph);
  }

  async listPlans(session: DeviceSession, studentId: string) {
    return this.readAuthorized(session, studentId, 'PLAN_READ', async (tx) => {
      const plans = await tx.studyPlan.findMany({
        where: { studentProfileId: studentId },
        orderBy: { createdAt: 'desc' },
        include: { series: true },
      });
      return {
        items: plans.map((plan) => ({
          id: plan.id,
          status: plan.status,
          origin: plan.origin,
          version: plan.version,
          seriesCount: plan.series.length,
          createdAt: plan.createdAt.toISOString(),
        })),
      };
    });
  }

  async getPlan(session: DeviceSession, studentId: string, planId: string) {
    return this.readAuthorized(session, studentId, 'PLAN_READ', async (tx) => {
      return this.loadPlan(tx, studentId, planId);
    });
  }

  async patchPlan(session: DeviceSession, studentId: string, planId: string, input: PatchPlanInput, idempotencyKey: string) {
    if (session.scope === 'GUARDIAN') {
      this.identity.requireStepUp(session);
    }
    await this.students.authorize(session, studentId, 'PLAN_UPDATE');
    const actor =
      session.scope === 'GUARDIAN'
        ? { actorScope: 'GUARDIAN' as const, actorId: session.accountId! }
        : { actorScope: 'STUDENT' as const, actorId: session.id };
    const requestDigest = this.idempotency.requestDigest({
      operation: 'plans.patch',
      studentId,
      planId,
      input,
    });
    const existingIdem = await this.idempotency.peekId(this.prisma, actor, 'plans.patch', idempotencyKey);
    const existingRows = await this.prisma.taskOccurrence.findMany({
      where: { series: { plan: { id: planId, studentProfileId: studentId } } },
      select: { id: true, seriesId: true },
    });
    const graph = await this.students.collectStudentGraph(studentId, {
      accountIds: [...(session.accountId ? [session.accountId] : []), ...(session.issuedByAccountId ? [session.issuedByAccountId] : [])],
      sessionIds: [session.id],
      planIds: [planId],
      taskSeriesIds: [...new Set(existingRows.map((row) => row.seriesId))],
      taskOccurrenceIds: existingRows.map((row) => row.id),
      idempotencyIds: existingIdem ? [existingIdem] : [],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.students.discoverStudentGraph(tx, studentId, session));
      const now = await readLockedNow(tx);
      const currentSession = await this.identity.assertSessionCurrent(tx, session, {
        now,
        requireStepUp: session.scope === 'GUARDIAN',
      });
      const current = await this.students.reauthorize(
        tx,
        currentSession,
        studentId,
        'PLAN_UPDATE',
        session.scope === 'GUARDIAN',
        now,
      );
      const begun = await this.idempotency.begin(tx, actor, 'plans.patch', idempotencyKey, requestDigest, now);
      if (begun.kind === 'REPLAY' && begun.resourceId) {
        await this.identity.touchLastSeenLocked(tx, currentSession, now);
        return this.loadPlan(tx, studentId, begun.resourceId);
      }
      await this.assertPlanWritePrereqs(tx, current);
      const plan = await tx.studyPlan.findFirst({
        where: { id: planId, studentProfileId: studentId },
        include: { series: { include: { occurrences: true } } },
      });
      if (!plan) {
        throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
      }
      const seriesIds = plan.series.map((item) => item.id);
      const occurrenceIds = plan.series.flatMap((item) => item.occurrences.map((row) => row.id));
      if (!lockIdsContain(locked, { planIds: [plan.id], taskSeriesIds: seriesIds, taskOccurrenceIds: occurrenceIds })) {
        throw new IncompleteLockSetError({
          planIds: [plan.id],
          taskSeriesIds: seriesIds,
          taskOccurrenceIds: occurrenceIds,
        });
      }
      if (plan.version !== input.expectedVersion) {
        throw new AppError('VERSION_CONFLICT', '计划版本已变化', 409);
      }
      const transition = resolvePlanStatusTransition(plan.status, input.action);
      if (!transition.ok) {
        throw new AppError('PLAN_STATUS_INVALID', '当前计划状态不允许该操作', 409);
      }
      const today = localDateInTimeZone(now, current.timezone);
      const windowTo = horizonWindow(today, null).to;
      const cancelledOccurrenceIds: string[] = [];
      const restoredOccurrenceIds: string[] = [];
      const haltReason = cancelReasonForPlanAction(input.action);
      if (haltReason) {
        for (const series of plan.series) {
          for (const row of series.occurrences) {
            if (occurrenceCancellableOnPlanHalt(row.status, row.scheduledLocalDate, today)) {
              cancelledOccurrenceIds.push(row.id);
            }
          }
        }
        if (cancelledOccurrenceIds.length > 0) {
          await tx.taskOccurrence.updateMany({
            where: { id: { in: cancelledOccurrenceIds } },
            data: { status: 'CANCELLED', cancelReason: haltReason },
          });
        }
      }
      if (input.action === 'RESUME') {
        for (const series of plan.series) {
          const seriesWindowTo = horizonWindow(today, series.endLocalDate).to;
          for (const row of series.occurrences) {
            if (
              occurrenceRestorableOnResume({
                status: row.status,
                cancelReason: row.cancelReason,
                scheduledLocalDate: row.scheduledLocalDate,
                todayLocalDate: today,
                windowTo: seriesWindowTo,
              })
            ) {
              restoredOccurrenceIds.push(row.id);
            }
          }
        }
        if (restoredOccurrenceIds.length > 0) {
          await tx.taskOccurrence.updateMany({
            where: { id: { in: restoredOccurrenceIds } },
            data: { status: 'PLANNED', cancelReason: null },
          });
        }
      }
      await tx.studyPlan.update({
        where: { id: plan.id },
        data: { status: transition.next, version: plan.version + 1 },
      });
      await tx.planAdjustment.create({
        data: {
          planId: plan.id,
          reasonCode: transition.reasonCode,
          payloadJson: JSON.stringify({
            action: input.action,
            fromStatus: plan.status,
            toStatus: transition.next,
            actorScope: session.scope,
            actorAccountId: session.accountId ?? null,
            actorSessionId: session.id,
            effectiveLocalDate: today,
            cancelledOccurrenceIds,
            restoredOccurrenceIds,
            windowTo,
          }),
        },
      });
      await this.idempotency.complete(tx, begun.recordId, 'StudyPlan', plan.id, 200, now);
      await this.identity.touchLastSeenLocked(tx, currentSession, now);
      return this.loadPlan(tx, studentId, plan.id);
    }, graph);
  }

  async listTasks(session: DeviceSession, studentId: string, query: { date?: string; from?: string; to?: string }) {
    return this.readAuthorized(session, studentId, 'TASK_READ', async (tx, student, now) => {
      const today = localDateInTimeZone(now, student.timezone);
      const from = query.from ?? query.date ?? today;
      const to = query.to ?? query.date ?? today;
      const rows = await tx.taskOccurrence.findMany({
        where: {
          series: { plan: { studentProfileId: studentId } },
          scheduledLocalDate: { gte: from, lte: to },
          status: { not: 'CANCELLED' },
        },
        include: { series: { include: { plan: true } } },
        orderBy: [{ scheduledLocalDate: 'asc' }, { createdAt: 'asc' }],
      });
      return {
        date: query.date ?? today,
        from,
        to,
        items: rows.map((row) => this.occurrenceView(row)),
      };
    });
  }

  async getTask(session: DeviceSession, studentId: string, occurrenceId: string) {
    return this.readAuthorized(session, studentId, 'TASK_READ', async (tx) => {
      const row = await tx.taskOccurrence.findFirst({
        where: { id: occurrenceId, series: { plan: { studentProfileId: studentId } } },
        include: { series: { include: { plan: true } } },
      });
      if (!row) {
        throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
      }
      return this.occurrenceView(row);
    });
  }

  async taskHorizon(): Promise<never> {
    throw new AppError('TASK_HORIZON_NOT_AVAILABLE', '滚动窗口补齐属于后续批次', 409);
  }

  private assertCreateAttestation(session: DeviceSession, coCreationAttested: boolean | undefined) {
    if (session.scope === 'GUARDIAN') {
      this.identity.requireStepUp(session);
      if (coCreationAttested !== true) {
        throw new AppError('VALIDATION_ERROR', '需要明确记录双方约定', 400, {
          coCreationAttested: 'required',
        });
      }
    } else if (coCreationAttested) {
      throw new AppError('VALIDATION_ERROR', '学生确认创建不使用双方约定字段', 400, {
        coCreationAttested: 'forbidden',
      });
    }
  }

  private async assertPlanWritePrereqs(
    tx: Tx,
    current: {
      id: string;
      status: string;
      ageBand: string;
      gradeConfigId: string | null;
      gradeConfigVersionId: string | null;
    },
  ) {
    await this.students.assertFreshRequiredConsent(tx, current.id, current.ageBand);
    const activation = await this.students.activationFor(tx, current);
    if (!activation.learningAccess.allowed) {
      throw new AppError('LEARNING_ACCESS_BLOCKED', '当前学习访问未开通', 403);
    }
    const age = decideAgeBand(current.ageBand as 'UNDER_14' | 'AGE_14_TO_17' | 'AGE_18_PLUS');
    if (!age.ok) {
      throw new AppError(age.code, '当前年龄段不能创建计划', 422);
    }
    const policy = await tx.consentPolicy.findUnique({
      where: { policyKey_locale: { policyKey: age.policyKey, locale: 'zh-CN' } },
    });
    const currentDocument = policy?.currentDocumentVersionId
      ? await tx.consentDocumentVersion.findUnique({ where: { id: policy.currentDocumentVersionId } })
      : null;
    if (!currentDocument || !consentCoversPlanWrites(currentDocument.scopeCanonicalJson)) {
      throw new AppError('LEARNING_ACCESS_BLOCKED', '当前同意未覆盖计划与任务', 403);
    }
    if (!current.gradeConfigId || !current.gradeConfigVersionId) {
      throw new AppError('LEARNING_ACCESS_BLOCKED', '尚未配置教育资料，不能创建计划', 403);
    }
  }

  private async persistConfirmedPlan(
    tx: Tx,
    session: DeviceSession,
    current: {
      id: string;
      timezone: string;
      stageCode: string | null;
      schoolSystemCode: string | null;
      gradeCode: string | null;
      gradeLabel: string | null;
      termCode: string | null;
    },
    preview: {
      confirmAllowed: boolean;
      blockCode?: string;
      blockReason?: string;
      series: SeriesRule[];
      education: { gradeConfigId: string; gradeConfigVersionId: string; catalogEntryKey: string };
    },
    now: Date,
    sourceTemplateVersionId: string | null,
  ) {
    if (!preview.confirmAllowed) {
      throw new AppError(
        preview.blockCode === 'TEMPLATE_IMPORT_NOT_ALLOWED' ? 'TEMPLATE_IMPORT_NOT_ALLOWED' : 'LEARNING_ACCESS_BLOCKED',
        preview.blockReason ?? '不能确认创建计划',
        preview.blockCode === 'TEMPLATE_IMPORT_NOT_ALLOWED' ? 400 : 403,
      );
    }
    if (
      !current.stageCode ||
      !current.schoolSystemCode ||
      !current.gradeCode ||
      !current.gradeLabel ||
      !current.termCode ||
      !preview.education.gradeConfigId ||
      !preview.education.gradeConfigVersionId
    ) {
      throw new AppError('LEARNING_ACCESS_BLOCKED', '尚未配置教育资料，不能创建计划', 403);
    }
    const stageCodeSnapshot = current.stageCode;
    const schoolSystemCodeSnapshot = current.schoolSystemCode;
    const gradeCodeSnapshot = current.gradeCode;
    const gradeLabelSnapshot = current.gradeLabel;
    const termCodeSnapshot = current.termCode;
    const origin = session.scope === 'GUARDIAN' ? 'GUARDIAN_ASSISTED' : 'STUDENT';
    const plan = await tx.studyPlan.create({
      data: {
        studentProfileId: current.id,
        status: 'ACTIVE',
        origin,
        createdByAccountId: session.scope === 'GUARDIAN' ? session.accountId : session.issuedByAccountId,
        createdBySessionId: session.id,
        coCreationAttestedAt: origin === 'GUARDIAN_ASSISTED' ? now : null,
        coCreationAttestedByAccountId: origin === 'GUARDIAN_ASSISTED' ? session.accountId : null,
        studentConfirmedAt: null,
        sourceTemplateVersionId,
        importedContentJson: JSON.stringify(preview.series),
        timezoneSnapshot: current.timezone,
      },
    });
    const today = localDateInTimeZone(now, current.timezone);
    for (const rule of preview.series) {
      const series = await tx.taskSeries.create({
        data: {
          planId: plan.id,
          name: rule.name,
          subject: rule.subject,
          completionStandard: rule.completionStandard,
          durationMinutes: rule.durationMinutes,
          stepsJson: JSON.stringify(rule.steps),
          repeatKind: rule.repeatKind,
          weekdaysJson: rule.weekdays ? JSON.stringify(rule.weekdays) : null,
          startLocalDate: rule.startLocalDate,
          endLocalDate: rule.endLocalDate,
          ongoing: rule.ongoing,
          effectiveFromLocalDate: rule.startLocalDate,
          effectiveToLocalDate: rule.endLocalDate,
        },
      });
      if (!planAllowsOccurrenceGeneration(plan.status)) {
        throw new AppError('PLAN_STATUS_INVALID', '暂停或归档的计划不能生成新实例', 409);
      }
      const dates = datesToMaterializeForPlan(plan.status, rule, today);
      if (dates.length === 0) {
        continue;
      }
      await tx.taskOccurrence.createMany({
        data: dates.map((localDate) => ({
          seriesId: series.id,
          occurrenceKey: localDate,
          originalLocalDate: localDate,
          scheduledLocalDate: localDate,
          timezoneSnapshot: current.timezone,
          status: 'PLANNED',
          nameSnapshot: rule.name,
          subjectSnapshot: rule.subject,
          completionStandardSnapshot: rule.completionStandard,
          durationMinutesSnapshot: rule.durationMinutes,
          stepsSnapshotJson: JSON.stringify(rule.steps),
          gradeConfigId: preview.education.gradeConfigId,
          gradeConfigVersionId: preview.education.gradeConfigVersionId,
          stageCodeSnapshot,
          schoolSystemCodeSnapshot,
          gradeCodeSnapshot,
          gradeLabelSnapshot,
          termCodeSnapshot,
          catalogEntryKeySnapshot: preview.education.catalogEntryKey,
        })),
      });
    }
    return plan;
  }

  private async readAuthorized<T>(
    session: DeviceSession,
    studentId: string,
    action: 'PLAN_READ' | 'TASK_READ',
    work: (tx: Tx, student: Awaited<ReturnType<StudentsService['reauthorize']>>, now: Date) => Promise<T>,
  ): Promise<T> {
    const graph = await this.students.collectStudentGraph(studentId, {
      accountIds: [...(session.accountId ? [session.accountId] : []), ...(session.issuedByAccountId ? [session.issuedByAccountId] : [])],
      sessionIds: [session.id],
    });
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(graph, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, await this.students.discoverStudentGraph(tx, studentId, session));
      const now = await readLockedNow(tx);
      const current = await this.identity.assertSessionCurrent(tx, session, { now });
      const student = await this.students.reauthorize(tx, current, studentId, action, false, now);
      const result = await work(tx, student, now);
      await this.identity.touchLastSeenLocked(tx, current, now);
      return result;
    }, graph);
  }

  private async buildPreview(
    tx: Tx,
    student: {
      id: string;
      status: string;
      ageBand: string;
      timezone: string;
      gradeConfigId: string | null;
      gradeConfigVersionId: string | null;
      stageCode: string | null;
      schoolSystemCode: string | null;
      gradeCode: string | null;
      gradeLabel: string | null;
      termCode: string | null;
    },
    templateId: string,
    input: PreviewTemplateInput,
    now: Date,
  ) {
    const template = await tx.planTemplateVersion.findFirst({
      where: { id: templateId, publishedAt: { not: null } },
    });
    if (!template) {
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
    }
    const activation = await this.students.activationFor(tx, student);
    const catalogEntryKey =
      student.gradeConfigVersionId
        ? (await tx.gradeConfigVersion.findUnique({ where: { id: student.gradeConfigVersionId } }))?.catalogEntryKey ?? null
        : null;
    const importAllowed = canImportTemplates(catalogEntryKey) && catalogEntryKey === template.catalogEntryKey;
    let blockCode: 'TEMPLATE_IMPORT_NOT_ALLOWED' | 'LEARNING_ACCESS_BLOCKED' | undefined;
    let blockReason: string | undefined;
    if (!importAllowed) {
      blockCode = 'TEMPLATE_IMPORT_NOT_ALLOWED';
      blockReason = '当前年级没有合法模板映射，不能导入';
    } else if (!activation.learningAccess.allowed) {
      blockCode = 'LEARNING_ACCESS_BLOCKED';
      blockReason = '当前学习访问未开通';
    }
    const content = JSON.parse(template.contentJson) as { tasks?: Array<{ name: string; subject: string; standard: string; durationMinutes?: number | null }> };
    const seedTasks = input.tasks ?? content.tasks ?? [];
    const today = localDateInTimeZone(now, student.timezone);
    const series = normalizePreviewTasks(seedTasks, template.kind, today);
    const education = {
      gradeConfigId: student.gradeConfigId ?? '',
      gradeConfigVersionId: student.gradeConfigVersionId ?? '',
      catalogEntryKey: catalogEntryKey ?? '',
      timezone: student.timezone,
    };
    const previewDigest = digestCanonical(
      previewCanonicalPayload({
        templateId: template.id,
        templateVersion: template.version,
        education,
        series,
      }),
    );
    return {
      confirmAllowed: !blockCode,
      blockCode,
      blockReason,
      template: {
        id: template.id,
        version: template.version,
        kind: template.kind,
        title: template.title,
        catalogEntryKey: template.catalogEntryKey,
      },
      education,
      series,
      tasks: series.map((rule) => ({
        name: rule.name,
        subject: rule.subject,
        standard: rule.completionStandard,
        durationMinutes: rule.durationMinutes,
        steps: rule.steps,
        repeatKind: rule.repeatKind,
        weekdays: rule.weekdays,
        startLocalDate: rule.startLocalDate,
        endLocalDate: rule.endLocalDate,
        ongoing: rule.ongoing,
      })),
      estimate: series.map((rule) => ({
        name: rule.name,
        dates: expandSeriesOccurrences(rule, { from: today, to: addLocalDays(today, 6) }),
      })),
      previewDigest,
    };
  }

  private async buildManualPreview(
    tx: Tx,
    student: {
      id: string;
      status: string;
      ageBand: string;
      timezone: string;
      gradeConfigId: string | null;
      gradeConfigVersionId: string | null;
      stageCode: string | null;
      schoolSystemCode: string | null;
      gradeCode: string | null;
      gradeLabel: string | null;
      termCode: string | null;
    },
    input: PreviewManualPlanInput,
    now: Date,
  ) {
    const activation = await this.students.activationFor(tx, student);
    const catalogEntryKey =
      student.gradeConfigVersionId
        ? (await tx.gradeConfigVersion.findUnique({ where: { id: student.gradeConfigVersionId } }))?.catalogEntryKey ?? null
        : null;
    let blockCode: 'LEARNING_ACCESS_BLOCKED' | undefined;
    let blockReason: string | undefined;
    if (!student.gradeConfigId || !student.gradeConfigVersionId) {
      blockCode = 'LEARNING_ACCESS_BLOCKED';
      blockReason = '尚未配置教育资料，不能创建计划';
    } else if (!activation.learningAccess.allowed) {
      blockCode = 'LEARNING_ACCESS_BLOCKED';
      blockReason = '当前学习访问未开通';
    }
    const today = localDateInTimeZone(now, student.timezone);
    const series = normalizePreviewTasks(input.tasks, 'DAILY', today);
    const education = {
      gradeConfigId: student.gradeConfigId ?? '',
      gradeConfigVersionId: student.gradeConfigVersionId ?? '',
      catalogEntryKey: catalogEntryKey ?? '',
      timezone: student.timezone,
    };
    const previewDigest = digestCanonical(manualPreviewCanonicalPayload({ education, series }));
    return {
      confirmAllowed: !blockCode,
      blockCode,
      blockReason,
      template: null,
      education,
      series,
      tasks: series.map((rule) => ({
        name: rule.name,
        subject: rule.subject,
        standard: rule.completionStandard,
        durationMinutes: rule.durationMinutes,
        steps: rule.steps,
        repeatKind: rule.repeatKind,
        weekdays: rule.weekdays,
        startLocalDate: rule.startLocalDate,
        endLocalDate: rule.endLocalDate,
        ongoing: rule.ongoing,
      })),
      estimate: series.map((rule) => ({
        name: rule.name,
        dates: expandSeriesOccurrences(rule, { from: today, to: addLocalDays(today, 6) }),
      })),
      previewDigest,
    };
  }

  private async loadPlan(tx: Tx, studentId: string, planId: string) {
    const plan = await tx.studyPlan.findFirst({
      where: { id: planId, studentProfileId: studentId },
      include: {
        series: { include: { occurrences: true } },
        adjustments: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    });
    if (!plan) {
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
    }
    return {
      id: plan.id,
      status: plan.status,
      origin: plan.origin,
      createdByAccountId: plan.createdByAccountId,
      studentConfirmedAt: plan.studentConfirmedAt,
      coCreationAttestedAt: plan.coCreationAttestedAt,
      sourceTemplateVersionId: plan.sourceTemplateVersionId,
      version: plan.version,
      lastAdjustment: plan.adjustments[0]
        ? {
            id: plan.adjustments[0].id,
            reasonCode: plan.adjustments[0].reasonCode,
            createdAt: plan.adjustments[0].createdAt.toISOString(),
            payload: JSON.parse(plan.adjustments[0].payloadJson) as Record<string, unknown>,
          }
        : null,
      series: plan.series.map((item) => ({
        id: item.id,
        name: item.name,
        subject: item.subject,
        completionStandard: item.completionStandard,
        repeatKind: item.repeatKind,
        startLocalDate: item.startLocalDate,
        endLocalDate: item.endLocalDate,
        ongoing: item.ongoing,
        occurrenceCount: item.occurrences.length,
      })),
    };
  }

  private occurrenceView(row: {
    id: string;
    scheduledLocalDate: string;
    originalLocalDate: string;
    occurrenceKey: string;
    status: string;
    nameSnapshot: string;
    subjectSnapshot: string;
    completionStandardSnapshot: string;
    durationMinutesSnapshot: number | null;
    stepsSnapshotJson: string;
    gradeLabelSnapshot: string;
    catalogEntryKeySnapshot: string;
    timezoneSnapshot: string;
    series: { id: string; planId: string; plan: { status: string } };
  }) {
    const planStatus = row.series.plan.status;
    return {
      id: row.id,
      seriesId: row.series.id,
      planId: row.series.planId,
      scheduledLocalDate: row.scheduledLocalDate,
      originalLocalDate: row.originalLocalDate,
      occurrenceKey: row.occurrenceKey,
      status: row.status,
      planStatus,
      executable: planStatus === 'ACTIVE' && row.status === 'PLANNED',
      name: row.nameSnapshot,
      subject: row.subjectSnapshot,
      completionStandard: row.completionStandardSnapshot,
      durationMinutes: row.durationMinutesSnapshot,
      steps: JSON.parse(row.stepsSnapshotJson) as string[],
      gradeLabelSnapshot: row.gradeLabelSnapshot,
      catalogEntryKeySnapshot: row.catalogEntryKeySnapshot,
      timezoneSnapshot: row.timezoneSnapshot,
    };
  }
}
