import { Module } from '@nestjs/common';
import { AppConfigModule } from '../common/config.module';
import { PlanningCoreModule } from '../planning/planning-core.module';
import { PrismaModule } from '../prisma/prisma.module';
import { HorizonWorkerService } from './service';

@Module({
  imports: [AppConfigModule, PrismaModule, PlanningCoreModule],
  providers: [HorizonWorkerService],
})
export class HorizonWorkerModule {}
