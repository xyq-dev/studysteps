import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { HORIZON_REQUEUE_REASON } from '@studysteps/domain';
import { HorizonWorkerModule } from './module';
import { HorizonWorkerService } from './service';

type Mode =
  | { kind: 'continuous' }
  | { kind: 'once'; maxJobs: number; maxMs: number }
  | { kind: 'status' }
  | { kind: 'requeue'; planId: string; reason: string };

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

async function main() {
  let mode: Mode;
  try {
    mode = parseArgs(process.argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'invalid arguments'}\n`);
    process.exit(typeof error === 'object' && error && 'exitCode' in error ? Number(error.exitCode) : 2);
  }
  if (process.env.HORIZON_WORKER_ENABLED !== 'true') {
    process.stderr.write('HORIZON_WORKER_ENABLED must be true\n');
    process.exit(2);
  }
  const app = await NestFactory.createApplicationContext(HorizonWorkerModule, { logger: ['error', 'warn', 'log'] });
  const worker = app.get(HorizonWorkerService);
  const stop = () => worker.requestStop();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    if (!worker.config.enabled) {
      process.stderr.write('horizon worker config disabled after enable flag\n');
      process.exitCode = 2;
      return;
    }
    if (mode.kind === 'status') {
      process.stdout.write(`${JSON.stringify(await worker.statusSnapshot())}\n`);
      process.exitCode = 0;
      return;
    }
    if (mode.kind === 'requeue') {
      const result = await worker.requeueFailed(mode.planId, mode.reason);
      if (result === 'OK') {
        process.exitCode = 0;
        return;
      }
      process.exitCode = result === 'MISSING' ? 4 : 4;
      return;
    }
    if (mode.kind === 'once') {
      await worker.runOnce(mode.maxJobs, mode.maxMs);
      process.exitCode = 0;
      return;
    }
    await worker.runContinuous();
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'worker failed'}\n`);
    process.exitCode = 2;
  } finally {
    try {
      await worker.disconnect();
    } catch {
      // already closed
    }
    await app.close();
  }
}

void main();
