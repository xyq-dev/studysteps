import { describe, expect, it } from 'vitest';
import { loadAppConfig } from './config';

describe('runtime config', () => {
  it('rejects test auth in production', () => {
    expect(() =>
      loadAppConfig({
        NODE_ENV: 'production',
        AUTH_TEST_MODE: '1',
        ALLOWED_ORIGINS: 'https://app.example.com',
        IDENTITY_LOOKUP_KEY_V1: 'k',
        IDENTITY_ADVISORY_KEY_V1: 'k',
        OTP_DIGEST_KEY_V1: 'k',
        PAIRING_DIGEST_KEY_V1: 'k',
        IDENTIFIER_ENCRYPT_KEY_V1: 'k',
      }),
    ).toThrow(/AUTH_TEST_MODE/);
  });

  it('keeps test auth closed when environment identifiers are missing', () => {
    const config = loadAppConfig({
      NODE_ENV: '',
      APP_ENV: '',
      AUTH_TEST_MODE: '1',
    });
    expect(config.authTestMode).toBe(false);
  });

  it('enables the test adapter only for explicit local/test', () => {
    const config = loadAppConfig({
      NODE_ENV: 'development',
      APP_ENV: 'local',
      AUTH_TEST_MODE: '1',
      IDENTITY_LOOKUP_KEY_V1: 'k',
      IDENTITY_ADVISORY_KEY_V1: 'k',
      OTP_DIGEST_KEY_V1: 'k',
      PAIRING_DIGEST_KEY_V1: 'k',
      IDENTIFIER_ENCRYPT_KEY_V1: 'k',
    });
    expect(config.authTestMode).toBe(true);
    expect(config.allowedOrigins).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
    expect(config.cookieNames.session).toBe('stp_session');
    expect(config.horizon.enabled).toBe(false);
    expect(config.horizon.maxJobsPerCycle).toBe(20);
  });

  it('rejects invalid horizon worker configuration before claim', () => {
    expect(() =>
      loadAppConfig({
        NODE_ENV: 'development',
        APP_ENV: 'local',
        HORIZON_WORKER_LEASE_MS: '1000',
        HORIZON_WORKER_RENEW_MS: '100',
      }),
    ).toThrow(/LEASE/);
  });
});
