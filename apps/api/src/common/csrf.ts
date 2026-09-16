import type { Request } from 'express';
import type { AppConfig } from './config';
import { AppError } from './app-error';
import { safeEqual, sha256Hex } from './crypto';

export function assertBoundCsrf(
  request: Request,
  session: { csrfDigest: string },
  config: AppConfig,
): void {
  const header = request.headers['x-csrf-token'];
  const cookie = request.cookies?.[config.cookieNames.csrf];
  if (typeof header !== 'string' || typeof cookie !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'CSRF 校验失败', 400);
  }
  if (!safeEqual(header, cookie) || !safeEqual(sha256Hex(header), session.csrfDigest)) {
    throw new AppError('VALIDATION_ERROR', 'CSRF 校验失败', 400);
  }
}
