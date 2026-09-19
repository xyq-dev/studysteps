import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  addLocalDays,
  HORIZON_EXECUTOR_KEY,
  localDateInTimeZone,
} from '@studysteps/domain';
import { AppError } from '../common/app-error';
import { RuntimeConfig } from '../common/runtime-config';
import {
  acquireLocks,
  assertLockSetComplete,
  IncompleteLockSetError,
  mergeLockIds,
  readLockedNow,
  runWriteTx,
  type LockIds,
} from '../common/lock-order';
import { PlanningEligibilityService } from '../planning/planning-eligibility.service';
import { TaskHorizonCoreService } from '../planning/task-horizon-core.service';
import {
  TaskHorizonJobRepository,
  type ClaimedHorizonJob,
} from '../planning/task-horizon-job.repository';
import { PrismaService } from '../prisma/prisma.service';

export const HORIZON_WORKER_CAPABILITY = `SYSTEM/${HORIZON_EXECUTOR_KEY}` as const;

@Injectable()
export class HorizonWorkerService {
  private readonly logger = new Logger(HorizonWorkerService.name);
  readonly capability = HORIZON_WORKER_CAPABILITY;
  readonly workerInstanceId = randomUUID();
  private stopping = false;

  constructor(
    private readonly runtime: RuntimeConfig,
    private readonly prisma: PrismaService,
    private readonly jobs: TaskHorizonJobRepository,
    private readonly eligibility: PlanningEligibilityService,
    private readonly core: TaskHorizonCoreService,
  ) {}

  get config() {
    return this.runtime.value.horizon;
  }

  requestStop(): void {
    this.stopping = true;
  }

  async runOnce(maxJobs: number, maxMs: number): Promise<{ processed: number }> {
    const deadline = Date.now() + maxMs;
    let processed = 0;
    while (!this.stopping && processed < maxJobs && Date.now() < deadline) {
      const remaining = Math.min(maxJobs - processed, this.availableClaimSlots(maxJobs - processed));
      if (remaining <= 0) {
        break;
      }
      const claimed = await this.jobs.claimReady(remaining, this.config.leaseMs, this.workerInstanceId);
      if (claimed.length === 0) {
        break;
      }
      await this.processClaimed(claimed);
      processed += claimed.length;
    }
    return { processed };
  }

  async runContinuous(): Promise<void> {
    while (!this.stopping) {
      const slots = this.availableClaimSlots(this.config.maxJobsPerCycle);
      const claimed = slots > 0
        ? await this.jobs.claimReady(slots, this.config.leaseMs, this.workerInstanceId)
        : [];
      if (claimed.length > 0) {
        await this.processClaimed(claimed);
      } else {
        await this.sleep(this.config.pollMs);
      }
    }
  }

  async requeueFailed(planId: string, reason: string): Promise<'OK' | 'MISSING' | 'CONFLICT'> {
    return this.jobs.requeueFailed(planId, reason);
  }

  async statusSnapshot() {
    return this.jobs.statusSnapshot();
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  private availableClaimSlots(requested: number): number {
    return Math.min(requested, this.config.concurrency, this.config.maxJobsPerCycle);
  }

  private async processClaimed(claimed: ClaimedHorizonJob[]): Promise<void> {
    const queue = [...claimed];
    const workers = Array.from({ length: Math.min(this.config.concurrency, queue.length) }, async () => {
      while (queue.length > 0 && !this.stopping) {
        const job = queue.shift();
        if (!job) {
          return;
        }
        await this.processOne(job);
      }
    });
    await Promise.all(workers);
  }

  private async processOne(job: ClaimedHorizonJob): Promise<void> {
    const renew = setInterval(() => {
      void this.jobs.renewLease(job.planId, job.leaseToken, this.config.leaseMs).then((ok) => {
        if (!ok) {
          this.logger.warn({ planId: job.planId, result: 'renew_failed' }, 'horizon lease renew failed');
        }
      });
    }, this.config.renewMs);
    try {
      await this.executeClaimed(job);
    } catch (error) {
      this.logger.warn(
        { planId: job.planId, result: 'technical_failure', reason: errorName(error) },
        'horizon job technical failure',
      );
      try {
        await this.jobs.recordTechnicalFailure(job.planId, errorName(error));
      } catch (recordError) {
        this.logger.warn(
          { planId: job.planId, result: 'failure_record_failed', reason: errorName(recordError) },
          'horizon failure record failed',
        );
      }
    } finally {
      clearInterval(renew);
    }
  }

  private async executeClaimed(job: ClaimedHorizonJob): Promise<void> {
    const seed = await this.discoverBusinessLocks(job.planId);
    await runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(seed, extra);
      await acquireLocks(tx, locked);
      const discovered = await this.discoverBusinessLocks(job.planId, tx);
      assertLockSetComplete(locked, discovered);
      const now = await readLockedNow(tx);
      const current = await tx.taskHorizonJob.findUnique({ where: { planId: job.planId } });
      if (
        !current ||
        current.state !== 'LEASED' ||
        current.leaseToken !== job.leaseToken ||
        current.claimedGeneration == null ||
        BigInt(current.claimedGeneration) !== BigInt(job.claimedGeneration) ||
        !current.leaseExpiresAt ||
        current.leaseExpiresAt <= now
      ) {
        throw new Error('horizon lease no longer held');
      }
      const plan = await tx.studyPlan.findUnique({
        where: { id: job.planId },
        include: { series: { include: { occurrences: true, revisions: true } } },
      });
      if (!plan) {
        throw new Error('horizon plan missing');
      }
      const student = await tx.studentProfile.findUniqueOrThrow({ where: { id: plan.studentProfileId } });
      const eligibility = await this.eligibility.evaluateGenerationEligibility(tx, student, plan);
      if (!eligibility.ok && eligibility.kind === 'RETIRED') {
        await this.jobs.completeRetired(tx, {
          planId: job.planId,
          leaseToken: job.leaseToken,
          claimedGeneration: job.claimedGeneration,
          reason: eligibility.reason,
        });
        this.logger.log({ planId: job.planId, result: 'RETIRED', reason: eligibility.reason });
        return;
      }
      if (!eligibility.ok) {
        await this.jobs.completeBlocked(tx, {
          planId: job.planId,
          leaseToken: job.leaseToken,
          claimedGeneration: job.claimedGeneration,
          timezone: student.timezone,
          reason: eligibility.reason,
        });
        this.logger.log({ planId: job.planId, result: 'BLOCKED', reason: eligibility.reason });
        return;
      }
      const result = await this.core.reconcilePlanLocked(tx, {
        student: {
          id: student.id,
          timezone: student.timezone,
          stageCode: student.stageCode!,
          schoolSystemCode: student.schoolSystemCode!,
          gradeCode: student.gradeCode!,
          gradeLabel: student.gradeLabel!,
          termCode: student.termCode!,
          gradeConfigId: student.gradeConfigId!,
          gradeConfigVersionId: student.gradeConfigVersionId!,
        },
        plan,
        now,
      });
      if (result.failed) {
        await this.jobs.completeFailed(tx, {
          planId: job.planId,
          leaseToken: job.leaseToken,
          claimedGeneration: job.claimedGeneration,
          reason: result.failed.reason,
        });
        this.logger.log({ planId: job.planId, result: 'FAILED', reason: result.failed.reason });
        return;
      }
      if (result.blocked) {
        await this.jobs.completeBlocked(tx, {
          planId: job.planId,
          leaseToken: job.leaseToken,
          claimedGeneration: job.claimedGeneration,
          timezone: student.timezone,
          reason: result.blocked.reason,
        });
        this.logger.log({ planId: job.planId, result: 'BLOCKED', reason: result.blocked.reason });
        return;
      }
      await this.jobs.completeSuccess(tx, {
        planId: job.planId,
        leaseToken: job.leaseToken,
        claimedGeneration: job.claimedGeneration,
        timezone: student.timezone,
        successLocalDate: localDateInTimeZone(now, student.timezone),
        insertedCount: result.insertedCount,
        restoredCount: result.restoredCount,
      });
      this.logger.log({
        planId: job.planId,
        result: result.insertedCount > 0 ? 'GENERATED' : result.restoredCount > 0 ? 'RESTORED' : 'NOOP',
        insertedCount: result.insertedCount,
        restoredCount: result.restoredCount,
      });
    }, seed);
  }

  private async discoverBusinessLocks(
    planId: string,
    db: PrismaService | Parameters<TaskHorizonJobRepository['planIdsForStudent']>[0] = this.prisma,
  ): Promise<LockIds> {
    const plan = await db.studyPlan.findUnique({
      where: { id: planId },
      include: {
        series: {
          include: {
            occurrences: { select: { id: true, occurrenceKey: true, scheduledLocalDate: true } },
          },
        },
      },
    });
    if (!plan) {
      return { planIds: [planId], taskHorizonJobPlanIds: [planId] };
    }
    const student = await db.studentProfile.findUnique({ where: { id: plan.studentProfileId } });
    const today = student ? localDateInTimeZone(new Date(), student.timezone) : null;
    const consents = await db.consentRecord.findMany({
      where: { studentProfileId: plan.studentProfileId, withdrawnAt: null, supersededAt: null },
    });
    const links = await db.guardianLink.findMany({
      where: { id: { in: consents.map((item) => item.guardianLinkId) } },
    });
    const policies = await db.consentPolicy.findMany({
      where: { id: { in: consents.map((item) => item.consentPolicyId) } },
    });
    return {
      accountIds: [...links.map((item) => item.accountId), ...consents.map((item) => item.grantedByAccountId)],
      studentIds: student ? [student.id] : [],
      gradeConfigIds: student?.gradeConfigId ? [student.gradeConfigId] : [],
      policies: policies.map((item) => ({ id: item.id, policyKey: item.policyKey, locale: item.locale })),
      linkIds: links.map((item) => item.id),
      consentIds: consents.map((item) => item.id),
      planIds: [plan.id],
      taskSeriesIds: plan.series.map((item) => item.id),
      taskOccurrenceIds: plan.series.flatMap((item) =>
        item.occurrences
          .filter((row) => !today || inHorizonLockWindow(row, today))
          .map((row) => row.id),
      ),
      taskHorizonJobPlanIds: [plan.id],
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

function inHorizonLockWindow(
  row: { occurrenceKey: string; scheduledLocalDate: string },
  today: string,
): boolean {
  const to = addLocalDays(today, 13);
  return (
    (row.occurrenceKey >= today && row.occurrenceKey <= to) ||
    (row.scheduledLocalDate >= today && row.scheduledLocalDate <= to)
  );
}

function errorName(error: unknown): string {
  if (error instanceof IncompleteLockSetError) {
    return 'INCOMPLETE_LOCK_SET';
  }
  if (error instanceof AppError) {
    return error.code.slice(0, 64);
  }
  if (error instanceof Error) {
    return error.name.slice(0, 64) || 'Error';
  }
  return 'UNKNOWN';
}
