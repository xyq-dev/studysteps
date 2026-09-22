import 'reflect-metadata';
import { Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  closeHorizonContext,
  createHorizonContext,
  markTechnicalFailure,
} from './cli-runtime';
import { HorizonWorkerModule } from './module';
import { HorizonWorkerService } from './service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Test-only Nest fixtures for CLI exit mapping. Not a worker command or
 * production fault switch.
 */
@Injectable()
class HorizonCliInitBoom {
  constructor() {
    throw new Error('horizon fixture provider constructor failed');
  }
}

@Module({ providers: [HorizonCliInitBoom] })
class HorizonCliInitFailModule {}

@Injectable()
class HorizonCliCloseBoom implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    throw new Error('horizon fixture close failed');
  }
}

@Module({ providers: [HorizonCliCloseBoom] })
class HorizonCliCloseFailModule {}

async function runInitThroughCliHandler() {
  let app;
  try {
    app = await createHorizonContext(HorizonCliInitFailModule);
  } catch (error) {
    markTechnicalFailure(error);
  } finally {
    await closeHorizonContext(app);
  }
}

async function runCloseThroughCliHandler() {
  let app;
  try {
    app = await createHorizonContext(HorizonCliCloseFailModule);
    process.exitCode = 0;
  } catch (error) {
    markTechnicalFailure(error);
  } finally {
    await closeHorizonContext(app);
  }
}

async function runDisconnectThroughCliHandler() {
  let app;
  let worker: HorizonWorkerService | undefined;
  let disconnectCalls = 0;
  try {
    app = await createHorizonContext(HorizonWorkerModule);
    const running = app.get(HorizonWorkerService);
    worker = running;
    const prisma = app.get(PrismaService);
    const originalDisconnect = prisma.$disconnect.bind(prisma);
    prisma.$disconnect = (async (...args: Parameters<PrismaService['$disconnect']>) => {
      disconnectCalls += 1;
      if (disconnectCalls === 1) {
        throw Object.assign(new Error('horizon fixture first disconnect failed'), { exitCode: 97 });
      }
      return originalDisconnect(...args);
    }) as PrismaService['$disconnect'];
    if (running.constructor.name !== 'HorizonWorkerService') {
      throw new Error(`unexpected provider ${running.constructor.name}`);
    }
    process.exitCode = 0;
  } catch (error) {
    markTechnicalFailure(error);
  } finally {
    await closeHorizonContext(app, worker);
    process.stdout.write(
      `${JSON.stringify({
        provider: worker?.constructor.name ?? 'missing',
        disconnectCalls,
        exitCode: process.exitCode ?? 0,
      })}\n`,
    );
  }
}

const mode = process.argv[2] ?? '';
if (mode === '--init-default') {
  void NestFactory.createApplicationContext(HorizonCliInitFailModule, { logger: ['error'] });
} else if (mode === '--init') {
  void runInitThroughCliHandler().catch(markTechnicalFailure);
} else if (mode === '--close') {
  void runCloseThroughCliHandler().catch(markTechnicalFailure);
} else if (mode === '--disconnect') {
  void runDisconnectThroughCliHandler().catch(markTechnicalFailure);
} else {
  process.stderr.write('missing fixture mode\n');
  process.exitCode = 2;
}
