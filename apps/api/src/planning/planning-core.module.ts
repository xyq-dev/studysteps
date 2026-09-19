import { Module } from '@nestjs/common';
import { HorizonSignalService } from './horizon-signal.service';
import { PlanningEligibilityService } from './planning-eligibility.service';
import { TaskHorizonCoreService } from './task-horizon-core.service';
import { TaskHorizonJobRepository } from './task-horizon-job.repository';

@Module({
  providers: [
    PlanningEligibilityService,
    TaskHorizonCoreService,
    TaskHorizonJobRepository,
    HorizonSignalService,
  ],
  exports: [
    PlanningEligibilityService,
    TaskHorizonCoreService,
    TaskHorizonJobRepository,
    HorizonSignalService,
  ],
})
export class PlanningCoreModule {}
