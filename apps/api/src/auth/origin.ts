import type { Request } from 'express';
import { AppError } from '../common/app-error';
import type { AppConfig } from '../common/config';

export function assertAllowedOrigin(request: Request, config: AppConfig): string {
  const origin = request.headers.origin;
  if (!origin || !config.allowedOrigins.includes(origin)) {
    throw new AppError('VALIDATION_ERROR', '来源不被允许', 400);
  }
  return origin;
}

export function readClientIp(request: Request): string {
  return request.socket.remoteAddress ?? '0.0.0.0';
}
