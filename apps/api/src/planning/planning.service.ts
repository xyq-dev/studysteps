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
  missingOccurrenceDates,
  occurrenceCancellableOnPlanHalt,
  occurrenceRestorableOnResume,
  planAllowsOccurrenceGeneration,
  resolvePlanStatusTransition,
  cancelReasonForPlanAction,
  canAdjustOccurrence,
  canRescheduleOccurrence,
  occurrenceContentDiff,
  occurrenceContentEquals,
  occurrenceContentFromSnapshots,
  rescheduleTargetAllowed,
  scheduledDateConflicts,
  type SeriesRule,
} from '@studysteps/domain';
import type {
  CreateManualPlanInput,
  ImportTemplateConfirmInput,
  PatchPlanInput,
  PreviewManualPlanInput,
  PreviewTemplateInput,
  EditOccurrenceInput,
  RescheduleTaskInput,
  TaskHorizonInput,
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

type HorizonSkip = {
  reason: 'NO_PLAN' | 'PLAN_PAUSED' | 'PLAN_ARCHIVED' | 'ALREADY_EXISTS' | 'SERIES_ENDED' | 'NO_DATES_IN_WINDOW';
  planId?: string;
  seriesId?: string;
};

type HorizonResult = {
  from: string;
  to: string;
  insertedCount: number;
  skipped: HorizonSkip[];
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
};

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
          for (const row of series.occurrences) {
            if (
              occurrenceRestorableOnResume({
                status: row.status,
                cancelReason: row.cancelReason,
                scheduledLocalDate: row.scheduledLocalDate,
                todayLocalDate: today,
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

  async rescheduleTask(
    session: DeviceSession,
    studentId: string,
    occurrenceId: string,
    input: RescheduleTaskInput,
    idempotencyKey: string,
  ) {
    if (session.scope === 'GUARDIAN') {
      this.identity.requireStepUp(session);
    }
    await this.students.authorize(session, studentId, 'TASK_ADJUST');
    const actor =
      session.scope === 'GUARDIAN'
        ? { actorScope: 'GUARDIAN' as const, actorId: session.accountId! }
        : { actorScope: 'STUDENT' as const, actorId: session.id };
    const requestDigest = this.idempotency.requestDigest({
      operation: 'tasks.reschedule',
      studentId,
      occurrenceId,
      input,
    });
    const existingIdem = await this.idempotency.peekId(this.prisma, actor, 'tasks.reschedule', idempotencyKey);
    const target = await this.prisma.taskOccurrence.findFirst({
      where: { id: occurrenceId, series: { plan: { studentProfileId: studentId } } },
      include: { series: { include: { plan: true, occurrences: { select: { id: true } } } } },
    });
    if (!target) {
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
    }
    const siblingIds = target.series.occurrences.map((row) => row.id);
    const graph = await this.students.collectStudentGraph(studentId, {
      accountIds: [...(session.accountId ? [session.accountId] : []), ...(session.issuedByAccountId ? [session.issuedByAccountId] : [])],
      sessionIds: [session.id],
      planIds: [target.series.planId],
      taskSeriesIds: [target.seriesId],
      taskOccurrenceIds: siblingIds,
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
        'TASK_ADJUST',
        session.scope === 'GUARDIAN',
        now,
      );
      const begun = await this.idempotency.begin(tx, actor, 'tasks.reschedule', idempotencyKey, requestDigest, now);
      if (begun.kind === 'REPLAY' && begun.resourceId) {
        await this.identity.touchLastSeenLocked(tx, currentSession, now);
        return this.getTaskInTx(tx, studentId, begun.resourceId);
      }
      await this.assertPlanWritePrereqs(tx, current);
      const row = await tx.taskOccurrence.findFirst({
        where: { id: occurrenceId, series: { plan: { studentProfileId: studentId } } },
        include: { series: { include: { plan: true, occurrences: true } } },
      });
      if (!row) {
        throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
      }
      if (
        !lockIdsContain(locked, {
          planIds: [row.series.planId],
          taskSeriesIds: [row.seriesId],
          taskOccurrenceIds: row.series.occurrences.map((item) => item.id),
        })
      ) {
        throw new IncompleteLockSetError({
          planIds: [row.series.planId],
          taskSeriesIds: [row.seriesId],
          taskOccurrenceIds: row.series.occurrences.map((item) => item.id),
        });
      }
      if (row.version !== input.expectedVersion) {
        throw new AppError('VERSION_CONFLICT', '任务版本已变化', 409);
      }
      if (row.series.plan.status !== 'ACTIVE') {
        throw new AppError('PLAN_STATUS_INVALID', '当前计划状态不允许改期', 409);
      }
      if (!canRescheduleOccurrence(row.series.plan.status, row.status)) {
        throw new AppError('TASK_NOT_ADJUSTABLE', '当前任务不能改期', 409);
      }
      const today = localDateInTimeZone(now, current.timezone);
      if (!rescheduleTargetAllowed(today, input.scheduledLocalDate)) {
        throw new AppError('VALIDATION_ERROR', '不能改到过去的日期', 400, {
          scheduledLocalDate: 'past',
        });
      }
      if (
        scheduledDateConflicts(
          input.scheduledLocalDate,
          row.id,
          row.series.occurrences.map((item) => ({
            id: item.id,
            scheduledLocalDate: item.scheduledLocalDate,
          })),
        )
      ) {
        throw new AppError('TASK_DATE_CONFLICT', '该日已有同一规则的任务，不能覆盖', 409, {
          scheduledLocalDate: 'conflict',
        });
      }
      if (row.scheduledLocalDate !== input.scheduledLocalDate) {
        await tx.taskOccurrence.update({
          where: { id: row.id, version: row.version },
          data: {
            scheduledLocalDate: input.scheduledLocalDate,
            version: row.version + 1,
          },
        });
        await tx.planAdjustment.create({
          data: {
            planId: row.series.planId,
            seriesId: row.seriesId,
            occurrenceId: row.id,
            reasonCode: 'TASK_RESCHEDULED',
            payloadJson: JSON.stringify({
              fromScheduledLocalDate: row.scheduledLocalDate,
              toScheduledLocalDate: input.scheduledLocalDate,
              occurrenceKey: row.occurrenceKey,
              originalLocalDate: row.originalLocalDate,
              reason: input.reason,
              actorScope: session.scope,
              actorAccountId: session.accountId ?? null,
              actorSessionId: session.id,
            }),
          },
        });
      }
      await this.idempotency.complete(tx, begun.recordId, 'TaskOccurrence', row.id, 200, now);
      await this.identity.touchLastSeenLocked(tx, currentSession, now);
      return this.getTaskInTx(tx, studentId, row.id);
    }, graph);
  }

  async editOccurrence(
    session: DeviceSession,
    studentId: string,
    occurrenceId: string,
    input: EditOccurrenceInput,
    idempotencyKey: string,
  ) {
    if (session.scope === 'GUARDIAN') {
      this.identity.requireStepUp(session);
    }
    await this.students.authorize(session, studentId, 'TASK_ADJUST');
    const actor =
      session.scope === 'GUARDIAN'
        ? { actorScope: 'GUARDIAN' as const, actorId: session.accountId! }
        : { actorScope: 'STUDENT' as const, actorId: session.id };
    const requestDigest = this.idempotency.requestDigest({
      operation: 'tasks.edit',
      studentId,
      occurrenceId,
      input,
    });
    const existingIdem = await this.idempotency.peekId(this.prisma, actor, 'tasks.edit', idempotencyKey);
    const target = await this.prisma.taskOccurrence.findFirst({
      where: { id: occurrenceId, series: { plan: { studentProfileId: studentId } } },
      include: { series: { include: { plan: true, occurrences: { select: { id: true } } } } },
    });
    if (!target) {
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
    }
    const siblingIds = target.series.occurrences.map((row) => row.id);
    const graph = await this.students.collectStudentGraph(studentId, {
      accountIds: [...(session.accountId ? [session.accountId] : []), ...(session.issuedByAccountId ? [session.issuedByAccountId] : [])],
      sessionIds: [session.id],
      planIds: [target.series.planId],
      taskSeriesIds: [target.seriesId],
      taskOccurrenceIds: siblingIds,
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
        'TASK_ADJUST',
        session.scope === 'GUARDIAN',
        now,
      );
      const begun = await this.idempotency.begin(tx, actor, 'tasks.edit', idempotencyKey, requestDigest, now);
      if (begun.kind === 'REPLAY' && begun.resourceId) {
        await this.identity.touchLastSeenLocked(tx, currentSession, now);
        return this.getTaskInTx(tx, studentId, begun.resourceId);
      }
      await this.assertPlanWritePrereqs(tx, current);
      const row = await tx.taskOccurrence.findFirst({
        where: { id: occurrenceId, series: { plan: { studentProfileId: studentId } } },
        include: { series: { include: { plan: true, occurrences: true } } },
      });
      if (!row) {
        throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
      }
      if (
        !lockIdsContain(locked, {
          planIds: [row.series.planId],
          taskSeriesIds: [row.seriesId],
          taskOccurrenceIds: row.series.occurrences.map((item) => item.id),
        })
      ) {
        throw new IncompleteLockSetError({
          planIds: [row.series.planId],
          taskSeriesIds: [row.seriesId],
          taskOccurrenceIds: row.series.occurrences.map((item) => item.id),
        });
      }
      if (row.version !== input.expectedVersion) {
        throw new AppError('VERSION_CONFLICT', '任务版本已变化', 409);
      }
      if (row.series.plan.status !== 'ACTIVE') {
        throw new AppError('PLAN_STATUS_INVALID', '当前计划状态不允许编辑', 409);
      }
      if (!canAdjustOccurrence(row.series.plan.status, row.status)) {
        throw new AppError('TASK_NOT_ADJUSTABLE', '当前任务不能编辑', 409);
      }
      const nextContent = {
        name: input.name,
        subject: input.subject,
        completionStandard: input.standard,
        durationMinutes: input.durationMinutes,
        steps: input.steps,
      };
      const currentContent = occurrenceContentFromSnapshots(row);
      if (!occurrenceContentEquals(currentContent, nextContent)) {
        await tx.taskOccurrence.update({
          where: { id: row.id, version: row.version },
          data: {
            nameSnapshot: nextContent.name,
            subjectSnapshot: nextContent.subject,
            completionStandardSnapshot: nextContent.completionStandard,
            durationMinutesSnapshot: nextContent.durationMinutes,
            stepsSnapshotJson: JSON.stringify(nextContent.steps),
            version: row.version + 1,
          },
        });
        await tx.planAdjustment.create({
          data: {
            planId: row.series.planId,
            seriesId: row.seriesId,
            occurrenceId: row.id,
            reasonCode: 'TASK_CONTENT_EDITED',
            payloadJson: JSON.stringify({
              fields: occurrenceContentDiff(currentContent, nextContent),
              actorScope: session.scope,
              actorAccountId: session.accountId ?? null,
              actorSessionId: session.id,
            }),
          },
        });
      }
      await this.idempotency.complete(tx, begun.recordId, 'TaskOccurrence', row.id, 200, now);
      await this.identity.touchLastSeenLocked(tx, currentSession, now);
      return this.getTaskInTx(tx, studentId, row.id);
    }, graph);
  }

  private async getTaskInTx(tx: Tx, studentId: string, occurrenceId: string) {
    const row = await tx.taskOccurrence.findFirst({
      where: { id: occurrenceId, series: { plan: { studentProfileId: studentId } } },
      include: { series: { include: { plan: true } } },
    });
    if (!row) {
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
    }
    return this.occurrenceView(row);
  }

  async taskHorizon(session: DeviceSession, studentId: string, input: TaskHorizonInput, idempotencyKey: string) {
    if (session.scope === 'GUARDIAN') {
      this.identity.requireStepUp(session);
    }
    await this.students.authorize(session, studentId, 'TASK_ADJUST');
    const actor =
      session.scope === 'GUARDIAN'
        ? { actorScope: 'GUARDIAN' as const, actorId: session.accountId! }
        : { actorScope: 'STUDENT' as const, actorId: session.id };
    const requestDigest = this.idempotency.requestDigest({
      operation: 'tasks.horizon',
      studentId,
      input,
    });
    const existingIdem = await this.idempotency.peekId(this.prisma, actor, 'tasks.horizon', idempotencyKey);
    const existingRows = await this.prisma.taskOccurrence.findMany({
      where: { series: { plan: { studentProfileId: studentId } } },
      select: { id: true, seriesId: true, series: { select: { planId: true } } },
    });
    const graph = await this.students.collectStudentGraph(studentId, {
      accountIds: [...(session.accountId ? [session.accountId] : []), ...(session.issuedByAccountId ? [session.issuedByAccountId] : [])],
      sessionIds: [session.id],
      planIds: [...new Set(existingRows.map((row) => row.series.planId))],
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
        'TASK_ADJUST',
        session.scope === 'GUARDIAN',
        now,
      );
      const begun = await this.idempotency.begin(tx, actor, 'tasks.horizon', idempotencyKey, requestDigest, now);
      if (begun.kind === 'REPLAY' && begun.resourceId) {
        await this.identity.touchLastSeenLocked(tx, currentSession, now);
        return this.parseHorizonReplay(begun.resourceId);
      }
      if (input.expectedStudentVersion != null && current.version !== input.expectedStudentVersion) {
        throw new AppError('VERSION_CONFLICT', '档案版本已变化', 409);
      }
      await this.assertPlanWritePrereqs(tx, current);
      const plans = await tx.studyPlan.findMany({
        where: { studentProfileId: studentId },
        include: { series: { include: { occurrences: true } } },
      });
      const seriesIds = plans.flatMap((plan) => plan.series.map((item) => item.id));
      const occurrenceIds = plans.flatMap((plan) => plan.series.flatMap((item) => item.occurrences.map((row) => row.id)));
      if (
        !lockIdsContain(locked, {
          planIds: plans.map((plan) => plan.id),
          taskSeriesIds: seriesIds,
          taskOccurrenceIds: occurrenceIds,
        })
      ) {
        throw new IncompleteLockSetError({
          planIds: plans.map((plan) => plan.id),
          taskSeriesIds: seriesIds,
          taskOccurrenceIds: occurrenceIds,
        });
      }
      const result = await this.fillMissingOccurrences(tx, current, plans, now);
      await this.idempotency.complete(tx, begun.recordId, 'TaskHorizon', JSON.stringify(result), 200, now);
      await this.identity.touchLastSeenLocked(tx, currentSession, now);
      return result;
    }, graph);
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
      await this.insertOccurrenceDates(tx, series.id, dates, {
        timezone: current.timezone,
        gradeConfigId: preview.education.gradeConfigId,
        gradeConfigVersionId: preview.education.gradeConfigVersionId,
        stageCode: stageCodeSnapshot,
        schoolSystemCode: schoolSystemCodeSnapshot,
        gradeCode: gradeCodeSnapshot,
        gradeLabel: gradeLabelSnapshot,
        termCode: termCodeSnapshot,
        catalogEntryKey: preview.education.catalogEntryKey,
        name: rule.name,
        subject: rule.subject,
        completionStandard: rule.completionStandard,
        durationMinutes: rule.durationMinutes,
        stepsJson: JSON.stringify(rule.steps),
      });
    }
    return plan;
  }

  private parseHorizonReplay(resourceId: string): HorizonResult {
    try {
      const parsed = JSON.parse(resourceId) as HorizonResult;
      if (!parsed || typeof parsed.from !== 'string' || typeof parsed.insertedCount !== 'number') {
        throw new Error('invalid');
      }
      return parsed;
    } catch {
      throw new AppError('VALIDATION_ERROR', '幂等重放结果不可用', 409);
    }
  }

  private ruleFromSeries(series: {
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
  }): SeriesRule {
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

  private async insertOccurrenceDates(tx: Tx, seriesId: string, dates: string[], snapshot: OccurrenceSnapshot) {
    if (dates.length === 0) {
      return 0;
    }
    const created = await tx.taskOccurrence.createMany({
      data: dates.map((localDate) => ({
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
      })),
      skipDuplicates: true,
    });
    return created.count;
  }

  private async fillMissingOccurrences(
    tx: Tx,
    student: {
      id: string;
      timezone: string;
      stageCode: string | null;
      schoolSystemCode: string | null;
      gradeCode: string | null;
      gradeLabel: string | null;
      termCode: string | null;
      gradeConfigId: string | null;
      gradeConfigVersionId: string | null;
    },
    plans: Array<{
      id: string;
      status: string;
      series: Array<{
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
        occurrences: Array<{ occurrenceKey: string }>;
      }>;
    }>,
    now: Date,
  ): Promise<HorizonResult> {
    const today = localDateInTimeZone(now, student.timezone);
    const window = horizonWindow(today, null);
    const skipped: HorizonSkip[] = [];
    let insertedCount = 0;
    if (plans.length === 0) {
      return { from: window.from, to: window.to, insertedCount: 0, skipped: [{ reason: 'NO_PLAN' }] };
    }
    if (
      !student.stageCode ||
      !student.schoolSystemCode ||
      !student.gradeCode ||
      !student.gradeLabel ||
      !student.termCode ||
      !student.gradeConfigId ||
      !student.gradeConfigVersionId
    ) {
      throw new AppError('LEARNING_ACCESS_BLOCKED', '尚未配置教育资料，不能生成任务', 403);
    }
    const gradeVersion = await tx.gradeConfigVersion.findUnique({
      where: { id: student.gradeConfigVersionId },
    });
    const snapshotBase = {
      timezone: student.timezone,
      gradeConfigId: student.gradeConfigId,
      gradeConfigVersionId: student.gradeConfigVersionId,
      stageCode: student.stageCode,
      schoolSystemCode: student.schoolSystemCode,
      gradeCode: student.gradeCode,
      gradeLabel: student.gradeLabel,
      termCode: student.termCode,
      catalogEntryKey: gradeVersion?.catalogEntryKey ?? '',
    };
    for (const plan of plans) {
      if (!planAllowsOccurrenceGeneration(plan.status)) {
        skipped.push({
          reason: plan.status === 'PAUSED' ? 'PLAN_PAUSED' : 'PLAN_ARCHIVED',
          planId: plan.id,
        });
        continue;
      }
      for (const series of plan.series) {
        const rule = this.ruleFromSeries(series);
        const wanted = datesToMaterializeForPlan(plan.status, rule, today);
        if (wanted.length === 0) {
          const ended = rule.endLocalDate != null && rule.endLocalDate < today;
          skipped.push({
            reason: ended ? 'SERIES_ENDED' : 'NO_DATES_IN_WINDOW',
            planId: plan.id,
            seriesId: series.id,
          });
          continue;
        }
        const missing = missingOccurrenceDates(
          plan.status,
          rule,
          today,
          series.occurrences.map((row) => row.occurrenceKey),
        );
        if (missing.length === 0) {
          skipped.push({ reason: 'ALREADY_EXISTS', planId: plan.id, seriesId: series.id });
          continue;
        }
        insertedCount += await this.insertOccurrenceDates(tx, series.id, missing, {
          ...snapshotBase,
          name: series.name,
          subject: series.subject,
          completionStandard: series.completionStandard,
          durationMinutes: series.durationMinutes,
          stepsJson: series.stepsJson,
        });
      }
    }
    return { from: window.from, to: window.to, insertedCount, skipped };
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
    version: number;
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
      version: row.version,
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
