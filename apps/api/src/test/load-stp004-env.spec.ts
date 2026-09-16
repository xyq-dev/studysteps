import { describe, expect, it } from 'vitest';
import {
  assertStp004IntegrationReady,
  hasStp004TestConfig,
  isCi,
  missingStp004Isolation,
  shouldSkipStp004Isolation,
} from './load-stp004-env';

const ready = {
  CI: '',
  NODE_ENV: 'test',
  APP_ENV: 'test',
  AUTH_TEST_MODE: '1',
  AUTH_TEST_INBOX_KEY: 'inbox',
  IDENTITY_LOOKUP_KEY_V1: 'hex:00',
  IDENTITY_ADVISORY_KEY_V1: 'hex:00',
  OTP_DIGEST_KEY_V1: 'hex:00',
  PAIRING_DIGEST_KEY_V1: 'hex:00',
  IDENTIFIER_ENCRYPT_KEY_V1: 'hex:00',
  DATABASE_URL: 'postgresql://stp004_api@127.0.0.1:5432/studysteps',
  STP004_ADMIN_DATABASE_URL: 'postgresql://stp004_admin@127.0.0.1:5432/studysteps',
};

describe('STP 004 isolation loader', () => {
  it('skips only outside CI when isolation is missing', () => {
    expect(shouldSkipStp004Isolation({ CI: '', NODE_ENV: 'test' })).toBe(true);
    expect(hasStp004TestConfig({ CI: '', NODE_ENV: 'test' })).toBe(false);
  });

  it('does not skip in CI even when isolation is missing', () => {
    expect(isCi({ CI: 'true' })).toBe(true);
    expect(shouldSkipStp004Isolation({ CI: 'true' })).toBe(false);
    expect(() => assertStp004IntegrationReady({ CI: 'true', NODE_ENV: 'test' })).toThrow(
      /STP 004 isolation required/,
    );
  });

  it('accepts a complete local or CI test environment', () => {
    expect(missingStp004Isolation(ready)).toEqual([]);
    expect(shouldSkipStp004Isolation(ready)).toBe(false);
    expect(() => assertStp004IntegrationReady(ready)).not.toThrow();
    expect(shouldSkipStp004Isolation({ ...ready, CI: 'true' })).toBe(false);
  });

  it('requires an admin URL in CI', () => {
    expect(
      missingStp004Isolation({ ...ready, CI: 'true', STP004_ADMIN_DATABASE_URL: '' }),
    ).toContain('STP004_ADMIN_DATABASE_URL');
  });
});
