import { Module } from '@nestjs/common';
import { StudentsModule } from '../students/students.module';
import { AuthController } from './auth.controller';

@Module({
  imports: [StudentsModule],
  controllers: [AuthController],
})
export class AuthModule {}
