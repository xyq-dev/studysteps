import { Module } from '@nestjs/common';
import { AppConfigModule } from '../common/config.module';
import { PolicyPublishService } from './policy-publish.service';
import { PolicySeedService } from './policy.seed';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

@Module({
  imports: [AppConfigModule],
  controllers: [StudentsController],
  providers: [StudentsService, PolicySeedService, PolicyPublishService],
  exports: [StudentsService, PolicyPublishService],
})
export class StudentsModule {}
