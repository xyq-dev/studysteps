import { Body, Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import { createSessionSchema, requestAuthCodeSchema } from '@studysteps/contracts';
import type { Request, Response } from 'express';
import { RuntimeConfig } from '../common/runtime-config';
import { IdentityService } from './identity.service';
import { StudentsService } from '../students/students.service';
import { assertAllowedOrigin, readClientIp } from './origin';
import { clearSessionCookies, setSessionCookies } from './cookies';
import { assertBoundCsrf } from '../common/csrf';

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly identity: IdentityService,
    private readonly students: StudentsService,
    private readonly runtime: RuntimeConfig,
  ) {}

  private get config() {
    return this.runtime.value;
  }

  @Post('code')
  async requestCode(@Body() body: unknown, @Req() request: Request) {
    const origin = assertAllowedOrigin(request, this.config);
    const input = requestAuthCodeSchema.parse(body);
    if (input.purpose === 'SIGN_IN') {
      return this.identity.requestCode(input, origin, readClientIp(request));
    }
    const session = await this.identity.peekSession(this.token(request));
    assertBoundCsrf(request, session, this.config);
    return this.identity.requestCode(input, origin, readClientIp(request), {
      id: session.id,
      accountId: session.accountId ?? session.issuedByAccountId,
      deviceDigest: session.deviceInstallationDigest,
      scope: session.scope,
    });
  }

  @Post('session')
  async createSession(@Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const origin = assertAllowedOrigin(request, this.config);
    const existing = await this.optionalLoadedSession(request);
    if (existing) {
      assertBoundCsrf(request, existing, this.config);
    }
    const input = createSessionSchema.parse(body);
    const granted =
      input.grantType === 'PAIRING_CODE'
        ? await this.students.consumePairing(input.pairingId, input.code, input.device.installationId, origin)
        : input.grantType === 'STUDENT_MODE'
          ? await this.students.enterStudentMode(
              existing ?? (await this.identity.peekSession(this.token(request))),
              input.studentId,
              origin,
            )
          : await this.identity.grantSession(input, origin, readClientIp(request), existing);
    setSessionCookies(response, this.config, granted.sessionToken, granted.csrfToken);
    response.setHeader('Cache-Control', 'no-store');
    return granted.body;
  }

  @Get('session')
  async current(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const session = await this.identity.peekSession(this.token(request));
    response.setHeader('Cache-Control', 'no-store');
    const body = await this.identity.currentSession(session);
    return { session: body.session };
  }

  @Delete('session')
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    assertAllowedOrigin(request, this.config);
    const token = this.token(request);
    const row = await this.identity.findSessionByToken(token);
    if (row && !row.revokedAt) {
      assertBoundCsrf(request, row, this.config);
      await this.identity.logout(token);
    }
    clearSessionCookies(response, this.config);
    response.status(204);
  }

  private token(request: Request): string | undefined {
    return request.cookies?.[this.config.cookieNames.session] as string | undefined;
  }

  private async optionalLoadedSession(request: Request) {
    const token = this.token(request);
    if (!token) {
      return undefined;
    }
    try {
      return await this.identity.loadSession(token, { touch: false });
    } catch {
      return undefined;
    }
  }
}
