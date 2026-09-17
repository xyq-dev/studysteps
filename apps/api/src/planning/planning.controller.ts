import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import {
  createManualPlanSchema,
  listTasksQuerySchema,
  patchPlanSchema,
  previewManualPlanSchema,
  previewTemplateSchema,
  taskHorizonSchema,
} from '@studysteps/contracts';
import type { Request, Response } from 'express';
import { RuntimeConfig } from '../common/runtime-config';
import { IdentityService } from '../auth/identity.service';
import { assertAllowedOrigin } from '../auth/origin';
import { assertBoundCsrf } from '../common/csrf';
import { IdempotencyService } from '../common/idempotency.service';
import { PlanningService } from './planning.service';

@Controller('v1')
export class PlanningController {
  constructor(
    private readonly planning: PlanningService,
    private readonly identity: IdentityService,
    private readonly runtime: RuntimeConfig,
    private readonly idempotency: IdempotencyService,
  ) {}

  private get config() {
    return this.runtime.value;
  }

  @Post('students/:studentId/templates/:templateId/preview')
  @HttpCode(200)
  async preview(
    @Param('studentId') studentId: string,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.guardWrite(request);
    res.setHeader('Cache-Control', 'no-store');
    return this.planning.preview(session, studentId, templateId, previewTemplateSchema.parse(body ?? {}));
  }

  @Post('students/:studentId/plans/preview')
  @HttpCode(200)
  async previewManual(
    @Param('studentId') studentId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.guardWrite(request);
    res.setHeader('Cache-Control', 'no-store');
    return this.planning.previewManual(session, studentId, previewManualPlanSchema.parse(body ?? {}));
  }

  @Post('students/:studentId/plans')
  async createPlan(
    @Param('studentId') studentId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.guardWrite(request);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201);
    return this.planning.createPlan(
      session,
      studentId,
      createManualPlanSchema.parse(body ?? {}),
      this.idempotency.readKey(request.headers['idempotency-key']),
    );
  }

  @Get('students/:studentId/plans')
  async plans(@Param('studentId') studentId: string, @Req() request: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.guardRead(request);
    res.setHeader('Cache-Control', 'no-store');
    return this.planning.listPlans(session, studentId);
  }

  @Get('students/:studentId/plans/:planId')
  async plan(
    @Param('studentId') studentId: string,
    @Param('planId') planId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.guardRead(request);
    res.setHeader('Cache-Control', 'no-store');
    return this.planning.getPlan(session, studentId, planId);
  }

  @Patch('students/:studentId/plans/:planId')
  async patchPlan(
    @Param('studentId') studentId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.guardWrite(request);
    res.setHeader('Cache-Control', 'no-store');
    return this.planning.patchPlan(
      session,
      studentId,
      planId,
      patchPlanSchema.parse(body ?? {}),
      this.idempotency.readKey(request.headers['idempotency-key']),
    );
  }

  @Get('students/:studentId/tasks')
  async tasks(
    @Param('studentId') studentId: string,
    @Query() query: Record<string, string | undefined>,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.guardRead(request);
    res.setHeader('Cache-Control', 'no-store');
    return this.planning.listTasks(session, studentId, listTasksQuerySchema.parse(query));
  }

  @Get('students/:studentId/tasks/:occurrenceId')
  async task(
    @Param('studentId') studentId: string,
    @Param('occurrenceId') occurrenceId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.guardRead(request);
    res.setHeader('Cache-Control', 'no-store');
    return this.planning.getTask(session, studentId, occurrenceId);
  }

  @Post('students/:studentId/task-horizon')
  @HttpCode(200)
  async horizon(
    @Param('studentId') studentId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.guardWrite(request);
    res.setHeader('Cache-Control', 'no-store');
    return this.planning.taskHorizon(
      session,
      studentId,
      taskHorizonSchema.parse(body ?? {}),
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
