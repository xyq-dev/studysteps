import { Module } from '@nestjs/common';
import { AppConfigModule } from '../common/config.module';
import { PolicyPublishService } from './policy-publish.service';
import { PolicySeedService } from './policy.seed';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { CatalogController } from '../catalog/catalog.controller';
import { CatalogService } from '../catalog/catalog.service';

@Module({
  imports: [AppConfigModule],
  controllers: [StudentsController, CatalogController],
  providers: [StudentsService, PolicySeedService, PolicyPublishService, CatalogService],
  exports: [StudentsService, PolicyPublishService, CatalogService],
})
export class StudentsModule {}
