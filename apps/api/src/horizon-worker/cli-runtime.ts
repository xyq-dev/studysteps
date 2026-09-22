import type { INestApplicationContext, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

export const HORIZON_NEST_CONTEXT_OPTIONS = {
  logger: ['error', 'warn', 'log'] as Array<'error' | 'warn' | 'log'>,
  abortOnError: false as const,
};

export function publicErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'worker failed';
  return raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[redacted]')
    .replace(/(DATABASE_URL|DIRECT_URL|STP004_[A-Z0-9_]*URL)\s*=\s*\S+/gi, '$1=[redacted]');
}

export function markTechnicalFailure(error: unknown): void {
  process.stderr.write(`${publicErrorMessage(error)}\n`);
  process.exitCode = 2;
}

export async function createHorizonContext(
  moduleCls: Type<unknown>,
): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(moduleCls, HORIZON_NEST_CONTEXT_OPTIONS);
}

export async function closeHorizonContext(
  app?: { close(): Promise<unknown> },
  worker?: { disconnect(): Promise<unknown> },
): Promise<void> {
  if (worker) {
    try {
      await worker.disconnect();
    } catch {
      // already closed
    }
  }
  if (!app) {
    return;
  }
  try {
    await app.close();
  } catch (error) {
    markTechnicalFailure(error);
  }
}
