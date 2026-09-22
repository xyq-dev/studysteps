import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { HorizonBlockedReason, HorizonRetiredReason } from '@studysteps/domain';
import { TaskHorizonJobRepository } from './task-horizon-job.repository';

type Tx = Prisma.TransactionClient;

@Injectable()
export class HorizonSignalService {
  constructor(private readonly jobs: TaskHorizonJobRepository) {}

  planIdsForStudent(db: Parameters<TaskHorizonJobRepository['planIdsForStudent']>[0], studentId: string) {
    return this.jobs.planIdsForStudent(db, studentId);
  }

  signalPlans(tx: Tx, planIds: string[]) {
    return this.jobs.signal(tx, planIds);
  }

  blockPlans(tx: Tx, planIds: string[], reason: HorizonBlockedReason, timezone: string, now: Date) {
    return this.jobs.block(tx, planIds, reason, timezone, now);
  }

  retirePlans(tx: Tx, planIds: string[], reason: HorizonRetiredReason) {
    return this.jobs.retire(tx, planIds, reason);
  }
}
