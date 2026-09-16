import { Global, Module } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { LocalInboxController } from './local-inbox.controller';
import { RateLimitService } from './rate-limit.service';
import { TestAuthDelivery } from './test-delivery.adapter';
import { IdempotencyService } from '../common/idempotency.service';

@Global()
@Module({
  controllers: [LocalInboxController],
  providers: [IdentityService, RateLimitService, TestAuthDelivery, IdempotencyService],
  exports: [IdentityService, RateLimitService, TestAuthDelivery, IdempotencyService],
})
export class AuthCoreModule {}
