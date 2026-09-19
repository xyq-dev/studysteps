import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  HORIZON_EXECUTOR_KEY,
  HORIZON_MAX_ATTEMPTS,
  HORIZON_REQUEUE_REASON,
  horizonBackoffMs,
  nextHorizonLocalReviewAt,
  type HorizonBlockedReason,
  type HorizonFailedReason,
  type HorizonOutcome,
  type HorizonRetiredReason,
} from '@studysteps/domain';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

export type ClaimedHorizonJob = {
  planId: string;
  leaseToken: string;
  claimedGeneration: bigint;
  requestedGeneration: bigint;
  processedGeneration: bigint;
  leaseExpiresAt: Date;
};

@Injectable()
export class TaskHorizonJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async planIdsForStudent(db: PrismaService | Tx, studentId: string): Promise<string[]> {
    const plans = await db.studyPlan.findMany({
      where: { studentProfileId: studentId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return plans.map((item) => item.id);
  }

  async claimReady(limit: number, leaseMs: number, owner: string): Promise<ClaimedHorizonJob[]> {
    if (limit <= 0) {
      return [];
    }
    return this.prisma.$transaction(async (tx) => {
      await this.reapExpiredLocked(tx);
      const due = await tx.$queryRaw<Array<{ plan_id: string }>>`
        SELECT plan_id
          FROM task_horizon_jobs
         WHERE state IN ('READY', 'BLOCKED')
           AND available_at IS NOT NULL
           AND available_at <= clock_timestamp()
           AND processed_generation < requested_generation
         ORDER BY available_at, plan_id
         FOR UPDATE SKIP LOCKED
         LIMIT ${limit}
      `;
      const claimed: ClaimedHorizonJob[] = [];
      for (const row of due) {
        const token = randomUUID();
        const updated = await tx.$queryRaw<Array<{
          plan_id: string;
          lease_token: string;
          claimed_generation: bigint;
          requested_generation: bigint;
          processed_generation: bigint;
          lease_expires_at: Date;
        }>>`
          UPDATE task_horizon_jobs
             SET state = 'LEASED',
                 available_at = NULL,
                 state_reason = NULL,
                 claimed_generation = requested_generation,
                 lease_token = ${token}::uuid,
                 lease_owner = ${owner},
                 lease_started_at = clock_timestamp(),
                 lease_expires_at = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
                 last_started_at = clock_timestamp(),
                 last_executor_key = ${HORIZON_EXECUTOR_KEY},
                 updated_at = clock_timestamp()
           WHERE plan_id = ${row.plan_id}::uuid
             AND state IN ('READY', 'BLOCKED')
             AND processed_generation < requested_generation
         RETURNING plan_id, lease_token::text, claimed_generation, requested_generation, processed_generation, lease_expires_at
        `;
        if (updated[0]) {
          claimed.push({
            planId: updated[0].plan_id,
            leaseToken: String(updated[0].lease_token),
            claimedGeneration: BigInt(updated[0].claimed_generation),
            requestedGeneration: BigInt(updated[0].requested_generation),
            processedGeneration: BigInt(updated[0].processed_generation),
            leaseExpiresAt: new Date(updated[0].lease_expires_at),
          });
        }
      }
      return claimed;
    }, { maxWait: 5_000, timeout: 15_000 });
  }

  async renewLease(planId: string, leaseToken: string, leaseMs: number): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE task_horizon_jobs
         SET lease_expires_at = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
             updated_at = clock_timestamp()
       WHERE plan_id = ${planId}::uuid
         AND lease_token = ${leaseToken}::uuid
         AND state = 'LEASED'
    `;
    return updated === 1;
  }

  async reapExpired(): Promise<number> {
    return this.prisma.$transaction(async (tx) => this.reapExpiredLocked(tx), {
      maxWait: 5_000,
      timeout: 15_000,
    });
  }

  private async reapExpiredLocked(tx: Tx): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ plan_id: string }>>`
      SELECT plan_id
        FROM task_horizon_jobs
       WHERE state = 'LEASED'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= clock_timestamp()
       ORDER BY lease_expires_at, plan_id
       FOR UPDATE SKIP LOCKED
    `;
    for (const row of rows) {
      await this.applyTechnicalFailure(tx, row.plan_id, 'LEASE_EXPIRED');
    }
    return rows.length;
  }

  async completeSuccess(
    tx: Tx,
    input: {
      planId: string;
      leaseToken: string;
      claimedGeneration: bigint;
      timezone: string;
      successLocalDate: string;
      insertedCount: number;
      restoredCount: number;
    },
  ): Promise<void> {
    const outcome: HorizonOutcome =
      input.insertedCount > 0 ? 'GENERATED' : input.restoredCount > 0 ? 'RESTORED' : 'NOOP';
    const nextAt = nextHorizonLocalReviewAt(new Date(), input.timezone, input.planId);
    const updated = await tx.$executeRaw`
      UPDATE task_horizon_jobs
         SET processed_generation = claimed_generation,
             attempt_count = 0,
             lease_token = NULL,
             lease_owner = NULL,
             lease_started_at = NULL,
             lease_expires_at = NULL,
             claimed_generation = NULL,
             state = 'READY',
             state_reason = NULL,
             available_at = CASE
               WHEN requested_generation > claimed_generation THEN clock_timestamp()
               ELSE ${nextAt}
             END,
             requested_generation = CASE
               WHEN requested_generation > claimed_generation THEN requested_generation
               ELSE claimed_generation + 1
             END,
             last_outcome = ${outcome},
             last_error_code = NULL,
             last_inserted_count = ${input.insertedCount},
             last_finished_at = clock_timestamp(),
             last_success_at = clock_timestamp(),
             last_success_local_date = ${input.successLocalDate}::date,
             last_executor_key = ${HORIZON_EXECUTOR_KEY},
             updated_at = clock_timestamp()
       WHERE plan_id = ${input.planId}::uuid
         AND lease_token = ${input.leaseToken}::uuid
         AND state = 'LEASED'
         AND claimed_generation = ${input.claimedGeneration}
         AND lease_expires_at > clock_timestamp()
    `;
    if (updated !== 1) {
      throw new Error('horizon job token CAS failed');
    }
  }

  async completeBlocked(
    tx: Tx,
    input: {
      planId: string;
      leaseToken: string;
      claimedGeneration: bigint;
      timezone: string;
      reason: HorizonBlockedReason;
    },
  ): Promise<void> {
    const nextAt = nextHorizonLocalReviewAt(new Date(), input.timezone, input.planId);
    const updated = await tx.$executeRaw`
      UPDATE task_horizon_jobs
         SET processed_generation = claimed_generation,
             attempt_count = 0,
             lease_token = NULL,
             lease_owner = NULL,
             lease_started_at = NULL,
             lease_expires_at = NULL,
             claimed_generation = NULL,
             last_outcome = 'BLOCKED',
             last_error_code = ${input.reason},
             last_inserted_count = 0,
             last_finished_at = clock_timestamp(),
             last_executor_key = ${HORIZON_EXECUTOR_KEY},
             state = CASE
               WHEN requested_generation > claimed_generation THEN 'READY'
               ELSE 'BLOCKED'
             END,
             state_reason = CASE
               WHEN requested_generation > claimed_generation THEN NULL
               ELSE ${input.reason}
             END,
             available_at = CASE
               WHEN requested_generation > claimed_generation THEN clock_timestamp()
               ELSE ${nextAt}
             END,
             requested_generation = CASE
               WHEN requested_generation > claimed_generation THEN requested_generation
               ELSE claimed_generation + 1
             END,
             updated_at = clock_timestamp()
       WHERE plan_id = ${input.planId}::uuid
         AND lease_token = ${input.leaseToken}::uuid
         AND state = 'LEASED'
         AND claimed_generation = ${input.claimedGeneration}
         AND lease_expires_at > clock_timestamp()
    `;
    if (updated !== 1) {
      throw new Error('horizon job token CAS failed');
    }
  }

  async completeRetired(
    tx: Tx,
    input: {
      planId: string;
      leaseToken: string;
      claimedGeneration: bigint;
      reason: HorizonRetiredReason;
    },
  ): Promise<void> {
    const updated = await tx.$executeRaw`
      UPDATE task_horizon_jobs
         SET processed_generation = claimed_generation,
             attempt_count = 0,
             lease_token = NULL,
             lease_owner = NULL,
             lease_started_at = NULL,
             lease_expires_at = NULL,
             claimed_generation = NULL,
             state = 'RETIRED',
             state_reason = ${input.reason},
             available_at = NULL,
             last_outcome = 'RETIRED',
             last_error_code = ${input.reason},
             last_inserted_count = 0,
             last_finished_at = clock_timestamp(),
             last_executor_key = ${HORIZON_EXECUTOR_KEY},
             updated_at = clock_timestamp()
       WHERE plan_id = ${input.planId}::uuid
         AND lease_token = ${input.leaseToken}::uuid
         AND state = 'LEASED'
         AND claimed_generation = ${input.claimedGeneration}
         AND lease_expires_at > clock_timestamp()
    `;
    if (updated !== 1) {
      throw new Error('horizon job token CAS failed');
    }
  }

  async completeFailed(
    tx: Tx,
    input: {
      planId: string;
      leaseToken: string;
      claimedGeneration: bigint;
      reason: HorizonFailedReason;
    },
  ): Promise<void> {
    const updated = await tx.$executeRaw`
      UPDATE task_horizon_jobs
         SET lease_token = NULL,
             lease_owner = NULL,
             lease_started_at = NULL,
             lease_expires_at = NULL,
             claimed_generation = NULL,
             state = 'FAILED',
             state_reason = ${input.reason},
             available_at = NULL,
             last_outcome = 'FAILED',
             last_error_code = ${input.reason},
             last_inserted_count = 0,
             last_finished_at = clock_timestamp(),
             last_executor_key = ${HORIZON_EXECUTOR_KEY},
             updated_at = clock_timestamp()
       WHERE plan_id = ${input.planId}::uuid
         AND lease_token = ${input.leaseToken}::uuid
         AND state = 'LEASED'
         AND claimed_generation = ${input.claimedGeneration}
         AND lease_expires_at > clock_timestamp()
    `;
    if (updated !== 1) {
      throw new Error('horizon job token CAS failed');
    }
  }

  async recordTechnicalFailure(planId: string, errorCode: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT plan_id FROM task_horizon_jobs WHERE plan_id = ${planId}::uuid FOR UPDATE
      `;
      await this.applyTechnicalFailure(tx, planId, errorCode);
    }, { maxWait: 5_000, timeout: 15_000 });
  }

  private async applyTechnicalFailure(tx: Tx, planId: string, errorCode: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{
      requested_generation: bigint;
      claimed_generation: bigint | null;
      attempt_count: number;
    }>>`
      SELECT requested_generation, claimed_generation, attempt_count
        FROM task_horizon_jobs
       WHERE plan_id = ${planId}::uuid AND state = 'LEASED'
    `;
    const row = rows[0];
    if (!row || row.claimed_generation == null) {
      return;
    }
    if (row.requested_generation > row.claimed_generation) {
      await tx.$executeRaw`
        UPDATE task_horizon_jobs
           SET attempt_count = 0,
               lease_token = NULL,
               lease_owner = NULL,
               lease_started_at = NULL,
               lease_expires_at = NULL,
               claimed_generation = NULL,
               state = 'READY',
               state_reason = NULL,
               available_at = clock_timestamp(),
               last_outcome = 'FAILED',
               last_error_code = ${errorCode.slice(0, 64)},
               last_finished_at = clock_timestamp(),
               updated_at = clock_timestamp()
         WHERE plan_id = ${planId}::uuid AND state = 'LEASED'
      `;
      return;
    }
    const nextAttempt = row.attempt_count + 1;
    if (nextAttempt >= HORIZON_MAX_ATTEMPTS) {
      await tx.$executeRaw`
        UPDATE task_horizon_jobs
           SET attempt_count = ${nextAttempt},
               lease_token = NULL,
               lease_owner = NULL,
               lease_started_at = NULL,
               lease_expires_at = NULL,
               claimed_generation = NULL,
               state = 'FAILED',
               state_reason = 'RETRY_EXHAUSTED',
               available_at = NULL,
               last_outcome = 'FAILED',
               last_error_code = ${errorCode.slice(0, 64)},
               last_finished_at = clock_timestamp(),
               updated_at = clock_timestamp()
         WHERE plan_id = ${planId}::uuid AND state = 'LEASED'
      `;
      return;
    }
    const delay = horizonBackoffMs(nextAttempt, planId);
    await tx.$executeRaw`
      UPDATE task_horizon_jobs
         SET attempt_count = ${nextAttempt},
             lease_token = NULL,
             lease_owner = NULL,
             lease_started_at = NULL,
             lease_expires_at = NULL,
             claimed_generation = NULL,
             state = 'READY',
             state_reason = NULL,
             available_at = clock_timestamp() + (${delay} * interval '1 millisecond'),
             last_outcome = 'FAILED',
             last_error_code = ${errorCode.slice(0, 64)},
             last_finished_at = clock_timestamp(),
             updated_at = clock_timestamp()
       WHERE plan_id = ${planId}::uuid AND state = 'LEASED'
    `;
  }

  async signal(tx: Tx, planIds: string[]): Promise<void> {
    if (planIds.length === 0) {
      return;
    }
    const ids = [...new Set(planIds)].sort();
    for (const planId of ids) {
      await tx.$executeRaw`
        UPDATE task_horizon_jobs
           SET requested_generation = requested_generation + 1,
               attempt_count = 0,
               state = CASE WHEN state IN ('READY', 'BLOCKED') THEN 'READY' ELSE state END,
               available_at = CASE
                 WHEN state IN ('READY', 'BLOCKED') THEN clock_timestamp()
                 ELSE available_at
               END,
               state_reason = CASE WHEN state IN ('READY', 'BLOCKED') THEN NULL ELSE state_reason END,
               updated_at = clock_timestamp()
         WHERE plan_id = ${planId}::uuid
           AND state IN ('READY', 'BLOCKED', 'LEASED')
      `;
    }
  }

  async block(tx: Tx, planIds: string[], reason: HorizonBlockedReason, timezone: string): Promise<void> {
    const ids = [...new Set(planIds)].sort();
    for (const planId of ids) {
      const nextAt = nextHorizonLocalReviewAt(new Date(), timezone, planId);
      await tx.$executeRaw`
        UPDATE task_horizon_jobs
           SET requested_generation = CASE
                 WHEN state = 'LEASED' THEN requested_generation
                 WHEN processed_generation < requested_generation THEN requested_generation
                 ELSE requested_generation + 1
               END,
               attempt_count = 0,
               lease_token = NULL,
               lease_owner = NULL,
               lease_started_at = NULL,
               lease_expires_at = NULL,
               claimed_generation = NULL,
               state = 'BLOCKED',
               state_reason = ${reason},
               available_at = ${nextAt},
               last_outcome = 'BLOCKED',
               last_error_code = ${reason},
               updated_at = clock_timestamp()
         WHERE plan_id = ${planId}::uuid
           AND state <> 'RETIRED'
      `;
    }
  }

  async retire(tx: Tx, planIds: string[], reason: HorizonRetiredReason): Promise<void> {
    const ids = [...new Set(planIds)].sort();
    for (const planId of ids) {
      await tx.$executeRaw`
        UPDATE task_horizon_jobs
           SET attempt_count = 0,
               lease_token = NULL,
               lease_owner = NULL,
               lease_started_at = NULL,
               lease_expires_at = NULL,
               claimed_generation = NULL,
               state = 'RETIRED',
               state_reason = ${reason},
               available_at = NULL,
               last_outcome = 'RETIRED',
               last_error_code = ${reason},
               updated_at = clock_timestamp()
         WHERE plan_id = ${planId}::uuid
           AND state <> 'RETIRED'
      `;
    }
  }

  async statusSnapshot(): Promise<{
    due: number;
    leased: number;
    blocked: number;
    failed: number;
    retired: number;
    expiredLeases: number;
    oldestDueAt: string | null;
  }> {
    const [byState, due, expired, oldest] = await Promise.all([
      this.prisma.taskHorizonJob.groupBy({
        by: ['state'],
        _count: { planId: true },
      }),
      this.prisma.taskHorizonJob.count({
        where: {
          state: { in: ['READY', 'BLOCKED'] },
          availableAt: { lte: new Date() },
        },
      }),
      this.prisma.taskHorizonJob.count({
        where: { state: 'LEASED', leaseExpiresAt: { lte: new Date() } },
      }),
      this.prisma.taskHorizonJob.findFirst({
        where: { state: { in: ['READY', 'BLOCKED'] }, availableAt: { not: null } },
        orderBy: { availableAt: 'asc' },
        select: { availableAt: true },
      }),
    ]);
    const count = (state: string) => byState.find((row) => row.state === state)?._count.planId ?? 0;
    return {
      due,
      leased: count('LEASED'),
      blocked: count('BLOCKED'),
      failed: count('FAILED'),
      retired: count('RETIRED'),
      expiredLeases: expired,
      oldestDueAt: oldest?.availableAt?.toISOString() ?? null,
    };
  }

  async requeueFailed(planId: string, reason: string): Promise<'OK' | 'MISSING' | 'CONFLICT'> {
    if (reason !== HORIZON_REQUEUE_REASON) {
      return 'CONFLICT';
    }
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        state: string;
        requested_generation: bigint;
      }>>`
        SELECT state, requested_generation
          FROM task_horizon_jobs
         WHERE plan_id = ${planId}::uuid
         FOR UPDATE
      `;
      const row = rows[0];
      if (!row) {
        return 'MISSING';
      }
      if (row.state !== 'FAILED') {
        return 'CONFLICT';
      }
      const updated = await tx.$executeRaw`
        UPDATE task_horizon_jobs
           SET requested_generation = requested_generation + 1,
               attempt_count = 0,
               state = 'READY',
               state_reason = NULL,
               available_at = clock_timestamp(),
               last_outcome = 'REQUEUED',
               last_error_code = NULL,
               updated_at = clock_timestamp()
         WHERE plan_id = ${planId}::uuid
           AND state = 'FAILED'
           AND requested_generation = ${row.requested_generation}
      `;
      return updated === 1 ? 'OK' : 'CONFLICT';
    }, { maxWait: 5_000, timeout: 15_000 });
  }
}
