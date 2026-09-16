import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../common/app-error';
import { RuntimeConfig } from '../common/runtime-config';
import { TestAuthDelivery } from './test-delivery.adapter';

@Controller('__local')
export class LocalInboxController {
  constructor(
    private readonly runtime: RuntimeConfig,
    private readonly delivery: TestAuthDelivery,
  ) {}

  @Get('test-inbox')
  read(@Query('destination') destination: string, @Query('key') key: string, @Req() request: Request) {
    const ip = request.socket.remoteAddress ?? '';
    if (!this.runtime.value.authTestMode || (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1')) {
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
    }
    const code = this.delivery.read(destination, key);
    return { destination, code };
  }
}
