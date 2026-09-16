import { Module } from '@nestjs/common';
import { AppConfigModule } from './common/config.module';
import { AuthCoreModule } from './auth/auth-core.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { StudentsModule } from './students/students.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AuthCoreModule,
    HealthModule,
    StudentsModule,
    AuthModule,
  ],
})
export class AppModule {}
