import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import {
  createStudentSchema,
  grantConsentSchema,
  patchStudentSchema,
  revokeDeviceSchema,
  withdrawConsentSchema,
} from '@studysteps/contracts';
import type { Request, Response } from 'express';
import { AppError } from '../common/app-error';
import { RuntimeConfig } from '../common/runtime-config';
import { IdentityService } from '../auth/identity.service';
import { assertAllowedOrigin } from '../auth/origin';
import { StudentsService } from './students.service';
import { IdempotencyService } from '../common/idempotency.service';
import { assertBoundCsrf } from '../common/csrf';

@Controller('v1')
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly identity: IdentityService,
    private readonly runtime: RuntimeConfig,
    private readonly idempotency: IdempotencyService,
  ) {}

  private get config() {
    return this.runtime.value;
  }

  @Get('consent-documents')
  async documents(@Query('ageBand') ageBand: string, @Req() request: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.guardRead(request);
    res.setHeader('Cache-Control', 'no-store');
    if (ageBand !== 'UNDER_14' && ageBand !== 'AGE_14_TO_17' && ageBand !== 'AGE_18_PLUS') {
      throw new AppError('VALIDATION_ERROR', '年龄段无效', 400);
    }
    return this.students.documents(session, ageBand);
  }

  @Get('students')
  async list(@Req() request: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.guardRead(request);
    res.setHeader('Cache-Control', 'no-store');
    return { items: await this.students.list(session) };
  }

  @Post('students')
  async create(@Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.guardWrite(request);
    const input = createStudentSchema.parse(body);
    const idempotencyKey = this.idempotency.readKey(request.headers['idempotency-key']);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201);
    return this.students.create(session, input, idempotencyKey);
  }

  @Get('students/:studentId')
  async get(@Param('studentId') studentId: string, @Req() request: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.guardRead(request);
    res.setHeader('Cache-Control', 'no-store');
    return this.students.get(session, studentId);
  }

  @Patch('students/:studentId')
  async patch(
    @Param('studentId') studentId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.guardWrite(request);
    const input = patchStudentSchema.parse(body);
    const idempotencyKey = this.idempotency.readKey(request.headers['idempotency-key']);
    res.setHeader('Cache-Control', 'no-store');
    return this.students.patch(session, studentId, input, idempotencyKey);
  }

  @Get('students/:studentId/education-changes')
  async educationChanges(
    @Param('studentId') studentId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.guardRead(request);
    res.setHeader('Cache-Control', 'no-store');
    return this.students.listEducationChanges(session, studentId);
  }

  @Get('students/:studentId/consents')
  async listConsents(@Param('studentId') studentId: string, @Req() request: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.guardRead(request);
    res.setHeader('Cache-Control', 'no-store');
    return this.students.listConsents(session, studentId);
  }

  @Post('students/:studentId/consents')
  async grant(@Param('studentId') studentId: string, @Body() body: unknown, @Req() request: Request) {
    const session = await this.guardWrite(request);
    return this.students.grant(
      session,
      studentId,
      grantConsentSchema.parse(body),
      this.idempotency.readKey(request.headers['idempotency-key']),
    );
  }

  @Post('students/:studentId/consents/:consentId/withdraw')
  async withdraw(
    @Param('studentId') studentId: string,
    @Param('consentId') consentId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    const session = await this.guardWrite(request);
    return this.students.withdraw(
      session,
      studentId,
      consentId,
      withdrawConsentSchema.parse(body),
      this.idempotency.readKey(request.headers['idempotency-key']),
    );
  }

  @Post('students/:studentId/pairings')
  async pairing(@Param('studentId') studentId: string, @Req() request: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.guardWrite(request);
    const result = await this.students.createPairing(
      session,
      studentId,
      this.idempotency.readKey(request.headers['idempotency-key']),
    );
    if (result.secretState === 'ISSUED') {
      res.status(201);
    }
    return result;
  }

  @Post('students/:studentId/pairings/:pairingId/revoke')
  async revokePairing(
    @Param('studentId') studentId: string,
    @Param('pairingId') pairingId: string,
    @Req() request: Request,
  ) {
    const session = await this.guardWrite(request);
    return this.students.revokePairing(
      session,
      studentId,
      pairingId,
      this.idempotency.readKey(request.headers['idempotency-key']),
    );
  }

  @Get('students/:studentId/device-sessions')
  async devices(@Param('studentId') studentId: string, @Req() request: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.guardRead(request);
    res.setHeader('Cache-Control', 'no-store');
    return this.students.listDeviceSessions(session, studentId);
  }

  @Post('students/:studentId/device-sessions/:sessionId/revoke')
  async revokeDevice(
    @Param('studentId') studentId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    const session = await this.guardWrite(request);
    const parsed = revokeDeviceSchema.parse(body ?? {});
    return this.students.revokeDeviceSession(
      session,
      studentId,
      sessionId,
      parsed.reasonCode,
      this.idempotency.readKey(request.headers['idempotency-key']),
    );
  }

  private async guardRead(request: Request) {
    return this.identity.peekSession(request.cookies?.[this.config.cookieNames.session]);
  }

  private async guardWrite(request: Request) {
    assertAllowedOrigin(request, this.config);
    const session = await this.identity.peekSession(request.cookies?.[this.config.cookieNames.session]);
    assertBoundCsrf(request, session, this.config);
    return session;
  }
}
