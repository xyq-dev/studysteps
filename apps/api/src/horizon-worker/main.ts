import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { HORIZON_REQUEUE_REASON } from '@studysteps/domain';
import { loadAppConfig } from '../common/config';
import { HorizonWorkerModule } from './module';
import { HorizonWorkerService } from './service';

type Mode =
  | { kind: 'continuous' }
  | { kind: 'once'; maxJobs: number; maxMs: number }
  | { kind: 'status' }
  | { kind: 'requeue'; planId: string; reason: string };

type ExitHint = { exitCode?: number };

function parseArgs(argv: string[]): Mode {
  const args = argv.slice(2);
  const has = (flag: string) => args.includes(flag);
  const value = (prefix: string) => {
    const hit = args.find((item) => item.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
  };
  if (has('--continuous')) {
    return { kind: 'continuous' };
  }
  if (has('--status')) {
    return { kind: 'status' };
  }
  if (has('--once')) {
    const maxJobs = Number(value('--max-jobs=') ?? '20');
    const maxMs = Number(value('--max-ms=') ?? '60000');
    if (!Number.isFinite(maxJobs) || maxJobs <= 0 || !Number.isFinite(maxMs) || maxMs <= 0) {
      throw Object.assign(new Error('invalid --once bounds'), { exitCode: 2 });
    }
    return { kind: 'once', maxJobs, maxMs };
  }
  const requeue = value('--requeue-failed=');
  if (requeue) {
    if (!/^[0-9a-fA-F-]{36}$/.test(requeue)) {
      throw Object.assign(new Error('invalid plan id'), { exitCode: 2 });
    }
    const reason = value('--reason=') ?? '';
    if (reason !== HORIZON_REQUEUE_REASON) {
      throw Object.assign(new Error('invalid requeue reason'), { exitCode: 2 });
    }
    return { kind: 'requeue', planId: requeue, reason };
  }
  throw Object.assign(new Error('missing worker mode'), { exitCode: 2 });
}

function publicErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'worker failed';
  return raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[redacted]')
    .replace(/(DATABASE_URL|DIRECT_URL|STP004_[A-Z0-9_]*URL)\s*=\s*\S+/gi, '$1=[redacted]');
}

function hintedExitCode(error: unknown): number {
  if (typeof error === 'object' && error && 'exitCode' in error) {
    const code = Number((error as ExitHint).exitCode);
    if (Number.isFinite(code) && code > 0) {
      return code;
    }
  }
  return 2;
}

async function main() {
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  let worker: HorizonWorkerService | undefined;
  try {
    const mode = parseArgs(process.argv);
    if (process.env.HORIZON_WORKER_ENABLED !== 'true') {
      process.stderr.write('HORIZON_WORKER_ENABLED must be true\n');
      process.exitCode = 2;
      return;
    }
    loadAppConfig();
    app = await NestFactory.createApplicationContext(HorizonWorkerModule, {
      logger: ['error', 'warn', 'log'],
    });
    const running = app.get(HorizonWorkerService);
    worker = running;
    const stop = () => running.requestStop();
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    if (!running.config.enabled) {
      process.stderr.write('horizon worker config disabled after enable flag\n');
      process.exitCode = 2;
      return;
    }
    if (mode.kind === 'status') {
      process.stdout.write(`${JSON.stringify(await running.statusSnapshot())}\n`);
      process.exitCode = 0;
      return;
    }
    if (mode.kind === 'requeue') {
      const result = await running.requeueFailed(mode.planId, mode.reason);
      if (result === 'OK') {
        process.exitCode = 0;
        return;
      }
      process.exitCode = result === 'MISSING' ? 3 : 4;
      return;
    }
    if (mode.kind === 'once') {
      await running.runOnce(mode.maxJobs, mode.maxMs);
      process.exitCode = 0;
      return;
    }
    await running.runContinuous();
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${publicErrorMessage(error)}\n`);
    process.exitCode = hintedExitCode(error);
  } finally {
    if (worker) {
      try {
        await worker.disconnect();
      } catch {
        // already closed
      }
    }
    if (app) {
      await app.close();
    }
  }
}

void main();
