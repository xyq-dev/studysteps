import 'reflect-metadata';
import { Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  closeHorizonContext,
  createHorizonContext,
  markTechnicalFailure,
} from './cli-runtime';

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

const mode = process.argv[2] ?? '';
if (mode === '--init-default') {
  void NestFactory.createApplicationContext(HorizonCliInitFailModule, { logger: ['error'] });
} else if (mode === '--init') {
  void runInitThroughCliHandler().catch(markTechnicalFailure);
} else if (mode === '--close') {
  void runCloseThroughCliHandler().catch(markTechnicalFailure);
} else {
  process.stderr.write('missing fixture mode\n');
  process.exitCode = 2;
}
