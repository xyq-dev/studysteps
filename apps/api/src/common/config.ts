const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

export type AppConfig = {
  appEnv: string;
  nodeEnv: string;
  port: number;
  listenHost: string;
  authTestMode: boolean;
  authTestInboxKey: string;
  allowedOrigins: string[];
  cookieSecure: boolean;
  cookieNames: { session: string; csrf: string };
  keys: {
    lookup: Buffer;
    advisory: Buffer;
    otp: Buffer;
    pairing: Buffer;
    identifier: Buffer;
  };
  timing: {
    guardianAbsoluteMs: number;
    guardianIdleMs: number;
    studentAbsoluteMs: number;
    studentIdleMs: number;
    stepUpMs: number;
    lastSeenThrottleMs: number;
    otpTtlMs: number;
    pairingTtlMs: number;
    otpMaxAttempts: number;
    pairingMaxAttempts: number;
    otpIdPerHour: number;
    otpDevicePerHour: number;
    otpIpPerHour: number;
    authFailDevicePerMinute: number;
    authFailIpPerMinute: number;
  };
};

function readKey(env: NodeJS.ProcessEnv, name: string, required: boolean): Buffer {
  const raw = env[name];
  if (!raw) {
    if (required) {
      throw new Error(`${name} is required`);
    }
    return Buffer.alloc(32);
  }
  if (raw.startsWith('hex:')) {
    return Buffer.from(raw.slice(4), 'hex');
  }
  return Buffer.from(raw, 'utf8');
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? '';
  const appEnv = env.APP_ENV ?? '';
  const production = nodeEnv === 'production';
  const explicitTest = env.AUTH_TEST_MODE === '1';
  const authTestMode = !production && (appEnv === 'local' || appEnv === 'test') && explicitTest;

  if (production && explicitTest) {
    throw new Error('AUTH_TEST_MODE cannot be enabled when NODE_ENV=production');
  }

  const origins = production
    ? (env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [...LOCAL_ORIGINS];

  if (origins.includes('*') || (production && origins.some((origin) => origin.includes('localhost')))) {
    throw new Error('production origins must be explicit and non-local');
  }

  const requiredKeys = production || authTestMode;
  return {
    appEnv,
    nodeEnv,
    port: Number(env.PORT ?? 3000),
    listenHost: env.LISTEN_HOST ?? '127.0.0.1',
    authTestMode,
    authTestInboxKey: env.AUTH_TEST_INBOX_KEY ?? '',
    allowedOrigins: origins,
    cookieSecure: production,
    cookieNames: production
      ? { session: '__Host-stp_session', csrf: '__Host-stp_csrf' }
      : { session: 'stp_session', csrf: 'stp_csrf' },
    keys: {
      lookup: readKey(env, 'IDENTITY_LOOKUP_KEY_V1', requiredKeys),
      advisory: readKey(env, 'IDENTITY_ADVISORY_KEY_V1', requiredKeys),
      otp: readKey(env, 'OTP_DIGEST_KEY_V1', requiredKeys),
      pairing: readKey(env, 'PAIRING_DIGEST_KEY_V1', requiredKeys),
      identifier: readKey(env, 'IDENTIFIER_ENCRYPT_KEY_V1', requiredKeys),
    },
    timing: {
      guardianAbsoluteMs: 24 * 60 * 60 * 1000,
      guardianIdleMs: 2 * 60 * 60 * 1000,
      studentAbsoluteMs: 7 * 24 * 60 * 60 * 1000,
      studentIdleMs: 48 * 60 * 60 * 1000,
      stepUpMs: 5 * 60 * 1000,
      lastSeenThrottleMs: 60 * 1000,
      otpTtlMs: 5 * 60 * 1000,
      pairingTtlMs: 10 * 60 * 1000,
      otpMaxAttempts: 5,
      pairingMaxAttempts: 5,
      otpIdPerHour: authTestMode ? 80 : 5,
      otpDevicePerHour: authTestMode ? 80 : 10,
      otpIpPerHour: authTestMode ? 400 : 20,
      authFailDevicePerMinute: authTestMode ? 200 : 20,
      authFailIpPerMinute: authTestMode ? 600 : 60,
    },
  };
}

export function assertTestAuthAllowed(config: AppConfig): void {
  if (!config.authTestMode) {
    throw new Error('test auth adapter is disabled');
  }
}
