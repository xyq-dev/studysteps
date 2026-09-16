import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function runtimeCandidates(): string[] {
  return [
    join(process.cwd(), '.local', 'stp004-pg', 'runtime.env'),
    join(process.cwd(), '..', '..', '.local', 'stp004-pg', 'runtime.env'),
    join(process.cwd(), '..', '.local', 'stp004-pg', 'runtime.env'),
  ];
}

export function loadStp004Env(): boolean {
  const runtime = runtimeCandidates().find((path) => existsSync(path));
  if (!runtime) {
    return false;
  }
  for (const line of readFileSync(runtime, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) {
      continue;
    }
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  return Boolean(process.env.STP004_TEST_DATABASE_URL || process.env.DATABASE_URL);
}

export const hasIsolatedPostgres = loadStp004Env();
