import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED_KEYS = [
  'AUTH_TEST_INBOX_KEY',
  'IDENTITY_LOOKUP_KEY_V1',
  'IDENTITY_ADVISORY_KEY_V1',
  'OTP_DIGEST_KEY_V1',
  'PAIRING_DIGEST_KEY_V1',
  'IDENTIFIER_ENCRYPT_KEY_V1',
] as const;

function runtimeCandidates(): string[] {
  return [
    join(process.cwd(), '.local', 'stp004-pg', 'runtime.env'),
    join(process.cwd(), '..', '..', '.local', 'stp004-pg', 'runtime.env'),
    join(process.cwd(), '..', '.local', 'stp004-pg', 'runtime.env'),
  ];
}

export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === 'true' || env.CI === '1';
}

function hasDatabaseUrl(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.STP004_TEST_DATABASE_URL || env.DATABASE_URL);
}

export function loadStp004Env(env: NodeJS.ProcessEnv = process.env): boolean {
  const runtime = runtimeCandidates().find((path) => existsSync(path));
  if (runtime) {
    for (const line of readFileSync(runtime, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) {
        continue;
      }
      const index = line.indexOf('=');
      const key = line.slice(0, index);
      const value = line.slice(index + 1);
      if (!env[key]) {
        env[key] = value;
      }
    }
  }
  return hasStp004TestConfig(env);
}

export function missingStp004Isolation(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (env.NODE_ENV === 'production') {
    missing.push('NODE_ENV must not be production');
  }
  if (env.APP_ENV !== 'local' && env.APP_ENV !== 'test') {
    missing.push('APP_ENV');
  }
  if (env.AUTH_TEST_MODE !== '1') {
    missing.push('AUTH_TEST_MODE');
  }
  for (const key of REQUIRED_KEYS) {
    if (!env[key]) {
      missing.push(key);
    }
  }
  if (!hasDatabaseUrl(env)) {
    missing.push('DATABASE_URL');
  }
  if (isCi(env) && !env.STP004_ADMIN_DATABASE_URL) {
    missing.push('STP004_ADMIN_DATABASE_URL');
  }
  return missing;
}

export function hasStp004TestConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return missingStp004Isolation(env).length === 0;
}

export function shouldSkipStp004Isolation(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isCi(env)) {
    return false;
  }
  return !hasStp004TestConfig(env);
}

export const FORBIDDEN_ISOLATION_DATABASES = [
  'stp004_identity',
  'stp004_identity_fresh',
  'stp005_four_to_six',
  'stp005_unknown_leftover',
] as const;

export function databaseNameFromUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, '').split('?')[0] ?? '';
}

export function assertDisposableIsolationTarget(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = databaseNameFromUrl(url);
  if ((FORBIDDEN_ISOLATION_DATABASES as readonly string[]).includes(name)) {
    throw new Error(`refusing existing database ${name}; use exclusive stp006_* / stp005_rev_* or CI studysteps`);
  }
  if (!isCi(env) && name !== 'studysteps' && !name.startsWith('stp005_rev_') && !name.startsWith('stp006_')) {
    throw new Error(`expected exclusive stp005_rev_* / stp006_* test target, got ${name}`);
  }
  return name;
}

export function assertStp004IntegrationReady(env: NodeJS.ProcessEnv = process.env): void {
  const missing = missingStp004Isolation(env);
  if (missing.length > 0) {
    throw new Error(`STP 004 isolation required: ${missing.join(', ')}`);
  }
  const url = env.STP004_TEST_DATABASE_URL ?? env.DATABASE_URL;
  if (url) {
    assertDisposableIsolationTarget(url, env);
  }
}

loadStp004Env();
export const hasIsolatedPostgres = hasStp004TestConfig();
