import { Module } from '@nestjs/common';
import { AppConfigModule } from '../common/config.module';
import { PolicyPublishService } from './policy-publish.service';
import { PolicySeedService } from './policy.seed';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { CatalogController } from '../catalog/catalog.controller';
import { CatalogService } from '../catalog/catalog.service';
import { PlanningController } from '../planning/planning.controller';
import { PlanningService } from '../planning/planning.service';

@Module({
  imports: [AppConfigModule],
  controllers: [StudentsController, CatalogController, PlanningController],
  providers: [StudentsService, PolicySeedService, PolicyPublishService, CatalogService, PlanningService],
  exports: [StudentsService, PolicyPublishService, CatalogService, PlanningService],
})
export class StudentsModule {}
