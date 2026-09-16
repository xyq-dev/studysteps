import { Injectable } from '@nestjs/common';
import { utcWindowStart } from '@studysteps/domain';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RateLimitService {
  constructor(private readonly prisma: PrismaService) {}

  async consume(bucketKey: string, windowMs: number, max: number, now: Date): Promise<void> {
    const windowStartedAt = utcWindowStart(now, windowMs);
    const row = await this.prisma.rateLimitBucket.upsert({
      where: {
        bucketKey_windowStartedAt: { bucketKey, windowStartedAt },
      },
      update: { count: { increment: 1 } },
      create: {
        bucketKey,
        windowStartedAt,
        count: 1,
      },
    });
    if (row.count > max) {
      throw new AppError('RATE_LIMITED', '请稍后再试', 429);
    }
  }
}
