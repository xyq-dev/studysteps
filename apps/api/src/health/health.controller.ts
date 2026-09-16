import { Controller, Get } from '@nestjs/common';
import { HEALTH_OK, type HealthResponse } from '@studysteps/contracts';
import { domainBoundary } from '@studysteps/domain';

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    domainBoundary();
    return HEALTH_OK;
  }
}
