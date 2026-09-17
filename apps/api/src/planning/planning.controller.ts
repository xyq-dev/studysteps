import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  listTasksQuerySchema,
  previewTemplateSchema,
  taskHorizonSchema,
} from '@studysteps/contracts';
import type { Request, Response } from 'express';
import { RuntimeConfig } from '../common/runtime-config';
import { IdentityService } from '../auth/identity.service';
import { assertAllowedOrigin } from '../auth/origin';
import { assertBoundCsrf } from '../common/csrf';
import { PlanningService } from './planning.service';

@Controller('v1')
export class PlanningController {
  constructor(
    private readonly planning: PlanningService,
    private readonly identity: IdentityService,
    private readonly runtime: RuntimeConfig,
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
  async horizon(
    @Param('studentId') _studentId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    await this.guardWrite(request);
    taskHorizonSchema.parse(body ?? {});
    return this.planning.taskHorizon();
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
