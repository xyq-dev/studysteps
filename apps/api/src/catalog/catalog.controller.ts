import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { importTemplateConfirmSchema } from '@studysteps/contracts';
import type { Request, Response } from 'express';
import { RuntimeConfig } from '../common/runtime-config';
import { IdentityService } from '../auth/identity.service';
import { assertAllowedOrigin } from '../auth/origin';
import { assertBoundCsrf } from '../common/csrf';
import { IdempotencyService } from '../common/idempotency.service';
import { CatalogService } from './catalog.service';
import { StudentsService } from '../students/students.service';
import { PlanningService } from '../planning/planning.service';

@Controller('v1')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly students: StudentsService,
    private readonly planning: PlanningService,
    private readonly identity: IdentityService,
    private readonly runtime: RuntimeConfig,
    private readonly idempotency: IdempotencyService,
  ) {}

  private get config() {
    return this.runtime.value;
  }

  @Get('grade-configs')
  async grades(@Req() request: Request, @Res({ passthrough: true }) res: Response) {
    await this.identity.peekSession(request.cookies?.[this.config.cookieNames.session]);
    res.setHeader('Cache-Control', 'no-store');
    return this.catalog.listGradeConfigs();
  }

  @Get('templates')
  async templates(
    @Query('studentId') studentId: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.identity.peekSession(request.cookies?.[this.config.cookieNames.session]);
    res.setHeader('Cache-Control', 'no-store');
    let catalogEntryKey: string | null = null;
    if (studentId) {
      const presented = await this.students.get(session, studentId);
      catalogEntryKey = presented.education.catalogEntryKey;
    }
    return this.catalog.listTemplates(catalogEntryKey);
  }

  @Post('students/:studentId/templates/:templateId/import')
  async importTemplate(
    @Param('studentId') studentId: string,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertAllowedOrigin(request, this.config);
    const session = await this.identity.peekSession(request.cookies?.[this.config.cookieNames.session]);
    assertBoundCsrf(request, session, this.config);
    await this.students.authorize(session, studentId, 'PLAN_READ');
    await this.catalog.assertImportAllowed(await this.catalog.catalogEntryKeyForStudent(studentId), templateId);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201);
    return this.planning.importPlan(
      session,
      studentId,
      templateId,
      importTemplateConfirmSchema.parse(body ?? {}),
      this.idempotency.readKey(request.headers['idempotency-key']),
    );
  }
}
