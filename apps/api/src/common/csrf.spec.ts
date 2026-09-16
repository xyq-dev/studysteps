import { describe, expect, it } from 'vitest';
import { sha256Hex } from './crypto';
import { assertBoundCsrf } from './csrf';
import { loadAppConfig } from './config';

function request(header?: string, cookie?: string) {
  return {
    headers: header ? { 'x-csrf-token': header } : {},
    cookies: cookie ? { stp_csrf: cookie } : {},
  } as never;
}

describe('session-bound CSRF', () => {
  const config = loadAppConfig({ NODE_ENV: 'test', APP_ENV: 'test' });

  it('rejects matching client values that are not bound to the session digest', () => {
    expect(() =>
      assertBoundCsrf(request('token-a', 'token-a'), { csrfDigest: sha256Hex('other') }, config),
    ).toThrowError(/CSRF/);
  });

  it('accepts header, cookie and session digest together', () => {
    expect(() =>
      assertBoundCsrf(request('token-a', 'token-a'), { csrfDigest: sha256Hex('token-a') }, config),
    ).not.toThrow();
  });
});
