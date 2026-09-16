import type { Response } from 'express';
import type { AppConfig } from '../common/config';

export function setSessionCookies(
  response: Response,
  config: AppConfig,
  sessionToken: string,
  csrfToken: string,
): void {
  const base = {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
  };
  response.cookie(config.cookieNames.session, sessionToken, base);
  response.cookie(config.cookieNames.csrf, csrfToken, {
    ...base,
    httpOnly: false,
  });
}

export function clearSessionCookies(response: Response, config: AppConfig): void {
  response.clearCookie(config.cookieNames.session, { path: '/' });
  response.clearCookie(config.cookieNames.csrf, { path: '/' });
}
