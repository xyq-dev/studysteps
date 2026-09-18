import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from './app.module';
import { HttpErrorFilter } from './common/http-exception.filter';
import { TestAuthDelivery } from './auth/test-delivery.adapter';
import { PolicyPublishService, expectedTestV1Body } from './students/policy-publish.service';
import { RuntimeConfig } from './common/runtime-config';
import { TEST_POLICY_KEYS, TEST_POLICY_V2_VERSION } from '@studysteps/contracts';
import { addLocalDays, isoWeekdayFromLocalDate } from '@studysteps/domain';
import {
  assertStp004IntegrationReady,
  loadStp004Env,
  shouldSkipStp004Isolation,
} from './test/load-stp004-env';

const ORIGIN = 'http://127.0.0.1:5173';
const connectionString = process.env.STP004_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

class CookieJar {
  private readonly values = new Map<string, string>();
  apply(response: request.Response): void {
    const raw = response.headers['set-cookie'];
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const item of items) {
      const pair = item.split(';')[0];
      const eq = pair.indexOf('=');
      this.values.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
    }
  }
  header(): string {
    return [...this.values.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  }
  get(name: string): string | undefined {
    return this.values.get(name);
  }
}

describe.skipIf(shouldSkipStp004Isolation())('STP 006 first-batch plans and occurrences', () => {
  let app: INestApplication;
  let inbox: TestAuthDelivery;
  let publisher: PolicyPublishService;
  let runtime: RuntimeConfig;
  const prisma = new PrismaClient({ datasourceUrl: connectionString });
  let phoneSeq = 0;

  function nextPhone() {
    return `13800138${String(200 + (phoneSeq++ % 80)).padStart(3, '0')}`;
  }

  beforeAll(async () => {
    loadStp004Env();
    assertStp004IntegrationReady();
    await prisma.$connect();
    const db = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
    const dbName = db[0]?.current_database ?? '';
    if (['stp004_identity', 'stp004_identity_fresh', 'stp005_four_to_six'].includes(dbName)) {
      throw new Error(`refusing to run STP 006 HTTP tests against ${dbName}`);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new HttpErrorFilter());
    await app.init();
    inbox = app.get(TestAuthDelivery);
    publisher = app.get(PolicyPublishService);
    runtime = app.get(RuntimeConfig);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  function agent() {
    return request(app.getHttpServer());
  }

  function writeHeaders(cookies: CookieJar, key?: string) {
    return {
      Origin: ORIGIN,
      Cookie: cookies.header(),
      'X-CSRF-Token': cookies.get('stp_csrf') ?? '',
      'Idempotency-Key': key ?? randomUUID(),
    };
  }

  async function signIn() {
    const phone = nextPhone();
    const cookies = new CookieJar();
    const installationId = randomUUID();
    const codeRes = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .send({ purpose: 'SIGN_IN', identity: { kind: 'PHONE', value: phone }, device: { installationId } });
    expect(codeRes.status).toBeLessThan(300);
    const delivered = inbox.read(`+86${phone.replace(/^\+86/, '')}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    const sessionRes = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: codeRes.body.challengeId,
        code: delivered,
        device: { installationId, label: 'stp006' },
      });
    cookies.apply(sessionRes);
    return { cookies, phone, installationId };
  }

  async function createStudent(cookies: CookieJar, nickname = '计划孩子') {
    const docs = await agent().get('/v1/consent-documents?ageBand=UNDER_14').set('Cookie', cookies.header());
    const created = await agent()
      .post('/v1/students')
      .set(writeHeaders(cookies))
      .send({
        profile: { nickname, avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
        ageConfirmation: { band: 'UNDER_14', source: 'GUARDIAN_DECLARATION' },
        consentAcceptances: [{ policyKey: docs.body.policyKey, version: docs.body.version }],
      });
    expect(created.status).toBe(201);
    return created.body.profile as { id: string; version: number };
  }

  async function setGrade(cookies: CookieJar, student: { id: string; version: number }) {
    const grades = await agent().get('/v1/grade-configs').set('Cookie', cookies.header());
    const g1 = grades.body.items.find(
      (item: { schoolSystemCode: string; gradeCode: string; stageCode: string }) =>
        item.schoolSystemCode === 'SIX_THREE' && item.stageCode === 'PRIMARY' && item.gradeCode === 'G1',
    );
    const set = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: g1.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SET',
      });
    expect(set.status).toBeLessThan(300);
    return { ...student, version: set.body.version as number, catalogEntryKey: set.body.education.catalogEntryKey as string };
  }

  async function previewAndImport(
    cookies: CookieJar,
    student: { id: string; version: number },
    options: { attested?: boolean; idempotencyKey?: string; mutate?: (body: Record<string, unknown>) => void } = {},
  ) {
    const listed = await agent().get(`/v1/templates?studentId=${student.id}`).set('Cookie', cookies.header());
    const templateId = listed.body.recommendedTemplateIds[0] as string;
    const preview = await agent()
      .post(`/v1/students/${student.id}/templates/${templateId}/preview`)
      .set(writeHeaders(cookies))
      .send({});
    expect(preview.status).toBe(200);
    const body: Record<string, unknown> = {
      expectedStudentVersion: student.version,
      previewDigest: preview.body.previewDigest,
      templateVersion: preview.body.template.version,
      tasks: preview.body.tasks,
      coCreationAttested: options.attested ?? true,
    };
    options.mutate?.(body);
    const imported = await agent()
      .post(`/v1/students/${student.id}/templates/${templateId}/import`)
      .set(writeHeaders(cookies, options.idempotencyKey))
      .send(body);
    return { templateId, preview, imported };
  }

  async function patchPlan(
    cookies: CookieJar,
    studentId: string,
    planId: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    return agent()
      .patch(`/v1/students/${studentId}/plans/${planId}`)
      .set(writeHeaders(cookies, idempotencyKey))
      .send(body);
  }

  function shanghaiToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  }

  async function postHorizon(
    cookies: CookieJar,
    studentId: string,
    body: Record<string, unknown> = {},
    idempotencyKey?: string,
  ) {
    return agent()
      .post(`/v1/students/${studentId}/task-horizon`)
      .set(writeHeaders(cookies, idempotencyKey))
      .send(body);
  }

  async function patchOccurrence(
    cookies: CookieJar,
    studentId: string,
    occurrenceId: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    return agent()
      .patch(`/v1/students/${studentId}/tasks/${occurrenceId}`)
      .set(writeHeaders(cookies, idempotencyKey))
      .send(body);
  }

  async function postReschedule(
    cookies: CookieJar,
    studentId: string,
    occurrenceId: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    return agent()
      .post(`/v1/students/${studentId}/tasks/${occurrenceId}/reschedule`)
      .set(writeHeaders(cookies, idempotencyKey))
      .send(body);
  }

  async function postFuturePreview(
    cookies: CookieJar,
    studentId: string,
    occurrenceId: string,
    body: Record<string, unknown>,
  ) {
    return agent()
      .post(`/v1/students/${studentId}/tasks/${occurrenceId}/future-change/preview`)
      .set(writeHeaders(cookies))
      .send(body);
  }

  async function postFutureConfirm(
    cookies: CookieJar,
    studentId: string,
    occurrenceId: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    return agent()
      .post(`/v1/students/${studentId}/tasks/${occurrenceId}/future-change`)
      .set(writeHeaders(cookies, idempotencyKey))
      .send(body);
  }

  async function createManualPlan(
    cookies: CookieJar,
    student: { id: string; version: number },
    tasks: Array<Record<string, unknown>>,
  ) {
    const preview = await agent()
      .post(`/v1/students/${student.id}/plans/preview`)
      .set(writeHeaders(cookies))
      .send({ tasks });
    expect(preview.status).toBe(200);
    const created = await agent()
      .post(`/v1/students/${student.id}/plans`)
      .set(writeHeaders(cookies))
      .send({
        expectedStudentVersion: student.version,
        previewDigest: preview.body.previewDigest,
        tasks: preview.body.tasks,
        coCreationAttested: true,
      });
    expect(created.status).toBe(201);
    return created.body as { id: string; version: number };
  }

  function occurrenceFingerprint(row: {
    id: string;
    occurrenceKey: string;
    originalLocalDate: string;
    scheduledLocalDate: string;
    status: string;
    cancelReason: string | null;
    gradeLabelSnapshot: string;
    gradeConfigVersionId: string;
    catalogEntryKeySnapshot: string;
    nameSnapshot: string;
  }) {
    return {
      id: row.id,
      occurrenceKey: row.occurrenceKey,
      originalLocalDate: row.originalLocalDate,
      scheduledLocalDate: row.scheduledLocalDate,
      status: row.status,
      cancelReason: row.cancelReason,
      gradeLabelSnapshot: row.gradeLabelSnapshot,
      gradeConfigVersionId: row.gradeConfigVersionId,
      catalogEntryKeySnapshot: row.catalogEntryKeySnapshot,
      nameSnapshot: row.nameSnapshot,
    };
  }

  async function shiftPlanWindowBackOneDay(planId: string) {
    const series = await prisma.taskSeries.findMany({ where: { planId }, orderBy: { id: 'asc' } });
    for (const item of series) {
      const rows = await prisma.taskOccurrence.findMany({
        where: { seriesId: item.id },
        orderBy: { occurrenceKey: 'asc' },
      });
      for (const row of rows) {
        await prisma.taskOccurrence.update({
          where: { id: row.id },
          data: {
            occurrenceKey: addLocalDays(row.occurrenceKey, -1),
            originalLocalDate: addLocalDays(row.originalLocalDate, -1),
            scheduledLocalDate: addLocalDays(row.scheduledLocalDate, -1),
          },
        });
      }
    }
  }

  async function deleteLatestOccurrence(planId: string) {
    const last = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId } },
      orderBy: { occurrenceKey: 'desc' },
    });
    await prisma.taskOccurrence.delete({ where: { id: last.id } });
    return last;
  }

  it('T06-P-PREV preview and cancel leave no business rows', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies));
    const beforePlans = await prisma.studyPlan.count({ where: { studentProfileId: student.id } });
    const beforeSeries = await prisma.taskSeries.count({
      where: { plan: { studentProfileId: student.id } },
    });
    const beforeOcc = await prisma.taskOccurrence.count({
      where: { series: { plan: { studentProfileId: student.id } } },
    });
    const listed = await agent().get(`/v1/templates?studentId=${student.id}`).set('Cookie', auth.cookies.header());
    const preview = await agent()
      .post(`/v1/students/${student.id}/templates/${listed.body.recommendedTemplateIds[0]}/preview`)
      .set(writeHeaders(auth.cookies))
      .send({});
    expect(preview.status).toBe(200);
    expect(preview.body.confirmAllowed).toBe(true);
    expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(beforePlans);
    expect(await prisma.taskSeries.count({ where: { plan: { studentProfileId: student.id } } })).toBe(beforeSeries);
    expect(
      await prisma.taskOccurrence.count({ where: { series: { plan: { studentProfileId: student.id } } } }),
    ).toBe(beforeOcc);
  });

  it('T06-P-OK / ORIGIN / IDEM legal import, replay, and attestation', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies));
    const missing = await previewAndImport(auth.cookies, student, { attested: false });
    expect(missing.imported.status).toBe(400);
    expect(missing.imported.body.code).toBe('VALIDATION_ERROR');
    expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(0);

    const key = randomUUID();
    const first = await previewAndImport(auth.cookies, student, { attested: true, idempotencyKey: key });
    expect(first.imported.status).toBe(201);
    expect(first.imported.body.origin).toBe('GUARDIAN_ASSISTED');
    expect(first.imported.body.createdByAccountId).toBeTruthy();
    expect(first.imported.body.studentConfirmedAt).toBeNull();
    expect(first.imported.body.coCreationAttestedAt).toBeTruthy();
    const occ = await prisma.taskOccurrence.count({
      where: { series: { planId: first.imported.body.id } },
    });
    expect(occ).toBeGreaterThan(0);
    expect(occ).toBeLessThanOrEqual(14);

    const replay = await previewAndImport(auth.cookies, student, { attested: true, idempotencyKey: key });
    expect(replay.imported.status).toBe(201);
    expect(replay.imported.body.id).toBe(first.imported.body.id);
    expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(1);

    const conflict = await previewAndImport(auth.cookies, student, {
      attested: true,
      idempotencyKey: key,
      mutate: (body) => {
        body.expectedStudentVersion = student.version + 9;
      },
    });
    expect(conflict.imported.status).toBe(409);
    expect(conflict.imported.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const listed = await agent().get(`/v1/students/${student.id}/plans`).set('Cookie', auth.cookies.header());
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    const detail = await agent()
      .get(`/v1/students/${student.id}/plans/${first.imported.body.id}`)
      .set('Cookie', auth.cookies.header());
    expect(detail.status).toBe(200);
    expect(detail.body.origin).toBe('GUARDIAN_ASSISTED');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const to = new Date(Date.UTC(
      Number(today.slice(0, 4)),
      Number(today.slice(5, 7)) - 1,
      Number(today.slice(8, 10)) + 13,
    )).toISOString().slice(0, 10);
    const tasks = await agent()
      .get(`/v1/students/${student.id}/tasks?from=${today}&to=${to}`)
      .set('Cookie', auth.cookies.header());
    expect(tasks.status).toBe(200);
    expect(tasks.body.items.length).toBeGreaterThan(0);
    expect(tasks.body.items.every((item: { scheduledLocalDate: string }) => item.scheduledLocalDate >= today && item.scheduledLocalDate <= to)).toBe(true);
    const one = await agent()
      .get(`/v1/students/${student.id}/tasks/${tasks.body.items[0].id}`)
      .set('Cookie', auth.cookies.header());
    expect(one.status).toBe(200);
    expect(one.body.occurrenceKey).toBe(one.body.originalLocalDate);
    const beforeHorizon = await prisma.taskOccurrence.count({
      where: { series: { plan: { studentProfileId: student.id } } },
    });
    const reread = await agent()
      .get(`/v1/students/${student.id}/tasks?from=${today}&to=${to}`)
      .set('Cookie', auth.cookies.header());
    expect(reread.status).toBe(200);
    expect(await prisma.taskOccurrence.count({
      where: { series: { plan: { studentProfileId: student.id } } },
    })).toBe(beforeHorizon);
    const horizon = await agent()
      .post(`/v1/students/${student.id}/task-horizon`)
      .set(writeHeaders(auth.cookies))
      .send({});
    expect(horizon.status).toBe(200);
    expect(horizon.body.insertedCount).toBe(0);
    expect(horizon.body.from).toBe(today);
    expect(horizon.body.to).toBe(to);
    expect(horizon.body.skipped.some((item: { reason: string }) => item.reason === 'ALREADY_EXISTS')).toBe(true);
    expect(await prisma.taskOccurrence.count({
      where: { series: { plan: { studentProfileId: student.id } } },
    })).toBe(beforeHorizon);
  });

  it('T06-P-STALE-A / consent purpose: v1 is insufficient until re-grant of test-v2', async () => {
    const auth = await signIn();
    const policy = await prisma.consentPolicy.findUniqueOrThrow({
      where: { policyKey_locale: { policyKey: TEST_POLICY_KEYS.UNDER_14, locale: 'zh-CN' } },
      include: { documents: true },
    });
    const v1 = policy.documents.find((item) => item.version === 'test-v1');
    expect(v1?.contentBody).toBe(expectedTestV1Body(TEST_POLICY_KEYS.UNDER_14));
    await prisma.consentPolicy.update({
      where: { id: policy.id },
      data: { currentDocumentVersionId: v1!.id },
    });
    try {
      const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '旧同意'));
      const blocked = await previewAndImport(auth.cookies, student, { attested: true });
      expect(blocked.imported.status).toBe(403);
      expect(blocked.imported.body.code).toBe('LEARNING_ACCESS_BLOCKED');
      expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(0);

      await publisher.ensureTestV2(TEST_POLICY_KEYS.UNDER_14);
      const latest = await agent().get(`/v1/students/${student.id}`).set('Cookie', auth.cookies.header());
      const docs = await agent().get('/v1/consent-documents?ageBand=UNDER_14').set('Cookie', auth.cookies.header());
      expect(docs.body.version).toBe(TEST_POLICY_V2_VERSION);
      const granted = await agent()
        .post(`/v1/students/${student.id}/consents`)
        .set(writeHeaders(auth.cookies))
        .send({
          expectedStudentVersion: latest.body.version,
          acceptances: [{ policyKey: docs.body.policyKey, version: docs.body.version }],
        });
      expect(granted.status).toBeLessThan(300);
      const refreshed = await agent().get(`/v1/students/${student.id}`).set('Cookie', auth.cookies.header());
      const allowed = await previewAndImport(auth.cookies, { id: student.id, version: refreshed.body.version }, { attested: true });
      expect(allowed.imported.status).toBe(201);
    } finally {
      await publisher.ensureTestV2(TEST_POLICY_KEYS.UNDER_14);
    }
  });

  it('T06-P-CUSTOM still forbids unmapped import', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '自定义年级');
    const grades = await agent().get('/v1/grade-configs').set('Cookie', auth.cookies.header());
    const custom = grades.body.items.find((item: { catalogEntryKey: string | null }) => item.catalogEntryKey == null);
    const set = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: custom.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SET',
      });
    expect(set.status).toBeLessThan(300);
    const listed = await agent().get(`/v1/templates?studentId=${student.id}`).set('Cookie', auth.cookies.header());
    const denied = await agent()
      .post(`/v1/students/${student.id}/templates/${listed.body.items[0].id}/import`)
      .set(writeHeaders(auth.cookies))
      .send({});
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe('TEMPLATE_IMPORT_NOT_ALLOWED');
  });

  it('T06-P-STALE-E education change invalidates preview digest', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '教育过期'));
    const listed = await agent().get(`/v1/templates?studentId=${student.id}`).set('Cookie', auth.cookies.header());
    const preview = await agent()
      .post(`/v1/students/${student.id}/templates/${listed.body.recommendedTemplateIds[0]}/preview`)
      .set(writeHeaders(auth.cookies))
      .send({});
    const grades = await agent().get('/v1/grade-configs').set('Cookie', auth.cookies.header());
    const g2 = grades.body.items.find(
      (item: { schoolSystemCode: string; gradeCode: string; stageCode: string }) =>
        item.schoolSystemCode === 'SIX_THREE' && item.stageCode === 'PRIMARY' && item.gradeCode === 'G2',
    );
    const promoted = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: g2.id,
        termCode: 'FULL_YEAR',
        changeKind: 'PROMOTE',
      });
    expect(promoted.status).toBeLessThan(300);
    const stale = await agent()
      .post(`/v1/students/${student.id}/templates/${listed.body.recommendedTemplateIds[0]}/import`)
      .set(writeHeaders(auth.cookies))
      .send({
        expectedStudentVersion: promoted.body.version,
        previewDigest: preview.body.previewDigest,
        templateVersion: preview.body.template.version,
        tasks: preview.body.tasks,
        coCreationAttested: true,
      });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(0);
  });

  it('T02-D-OCC snapshots stay put after promote', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '快照'));
    const created = await previewAndImport(auth.cookies, student, { attested: true });
    expect(created.imported.status).toBe(201);
    const before = await prisma.taskOccurrence.findMany({
      where: { series: { planId: created.imported.body.id } },
    });
    expect(before[0]?.gradeLabelSnapshot).toBe('一年级');
    const grades = await agent().get('/v1/grade-configs').set('Cookie', auth.cookies.header());
    const g2 = grades.body.items.find(
      (item: { schoolSystemCode: string; gradeCode: string; stageCode: string }) =>
        item.schoolSystemCode === 'SIX_THREE' && item.stageCode === 'PRIMARY' && item.gradeCode === 'G2',
    );
    const latest = await agent().get(`/v1/students/${student.id}`).set('Cookie', auth.cookies.header());
    const promoted = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: latest.body.version,
        gradeConfigId: g2.id,
        termCode: 'FULL_YEAR',
        changeKind: 'PROMOTE',
      });
    expect(promoted.status).toBeLessThan(300);
    const after = await prisma.taskOccurrence.findMany({
      where: { series: { planId: created.imported.body.id } },
    });
    expect(after.every((row) => row.gradeLabelSnapshot === '一年级')).toBe(true);
  });

  it('T06-P-STALE-T template version change invalidates confirm', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '模板过期'));
    const listed = await agent().get(`/v1/templates?studentId=${student.id}`).set('Cookie', auth.cookies.header());
    const templateId = listed.body.recommendedTemplateIds[0] as string;
    const preview = await agent()
      .post(`/v1/students/${student.id}/templates/${templateId}/preview`)
      .set(writeHeaders(auth.cookies))
      .send({});
    const stale = await agent()
      .post(`/v1/students/${student.id}/templates/${templateId}/import`)
      .set(writeHeaders(auth.cookies))
      .send({
        expectedStudentVersion: student.version,
        previewDigest: preview.body.previewDigest,
        templateVersion: `${preview.body.template.version}-stale`,
        tasks: preview.body.tasks,
        coCreationAttested: true,
      });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('PLAN_PREVIEW_STALE');
  });

  it('T06-P-STEP expired step-up cannot confirm', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '二次验证过期'));
    const previous = runtime.value.timing.stepUpMs;
    runtime.value.timing.stepUpMs = 1;
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const denied = await previewAndImport(auth.cookies, student, { attested: true });
      expect(denied.imported.status).toBe(403);
      expect(denied.imported.body.code).toBe('STEP_UP_REQUIRED');
      expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(0);
    } finally {
      runtime.value.timing.stepUpMs = previous;
    }
  });

  it('T11-3 plan write is refused after consent withdraw', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '撤回后写入'));
    const consents = await agent().get(`/v1/students/${student.id}/consents`).set('Cookie', auth.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const withdrawn = await agent()
      .post(`/v1/students/${student.id}/consents/${current.id}/withdraw`)
      .set(writeHeaders(auth.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdrawn.status).toBeLessThan(300);
    const listed = await agent().get(`/v1/templates?studentId=${student.id}`).set('Cookie', auth.cookies.header());
    const denied = await agent()
      .post(`/v1/students/${student.id}/templates/${listed.body.recommendedTemplateIds[0]}/import`)
      .set(writeHeaders(auth.cookies))
      .send({
        expectedStudentVersion: withdrawn.body.version ?? student.version,
        previewDigest: 'not-used-after-withdraw',
        templateVersion: 'v1',
        tasks: [{ name: 'x', subject: '自定义', standard: '完成' }],
        coCreationAttested: true,
      });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(['SESSION_SCOPE_FORBIDDEN', 'LEARNING_ACCESS_BLOCKED', 'CONSENT_REQUIRED']).toContain(denied.body.code);
    expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(0);
  });

  const manualTask = {
    name: '自主阅读',
    subject: '自定义',
    standard: '读完指定页并口头复述',
    repeatKind: 'DAILY' as const,
  };

  async function previewAndCreate(
    cookies: CookieJar,
    student: { id: string; version: number },
    options: { attested?: boolean; idempotencyKey?: string; mutate?: (body: Record<string, unknown>) => void; tasks?: typeof manualTask[] } = {},
  ) {
    const preview = await agent()
      .post(`/v1/students/${student.id}/plans/preview`)
      .set(writeHeaders(cookies))
      .send({ tasks: options.tasks ?? [manualTask] });
    expect(preview.status).toBe(200);
    const body: Record<string, unknown> = {
      expectedStudentVersion: student.version,
      previewDigest: preview.body.previewDigest,
      tasks: preview.body.tasks,
      coCreationAttested: options.attested ?? true,
    };
    options.mutate?.(body);
    const created = await agent()
      .post(`/v1/students/${student.id}/plans`)
      .set(writeHeaders(cookies, options.idempotencyKey))
      .send(body);
    return { preview, created };
  }

  it('S06 preview cancel and illegal input leave no rows', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '手动取消'));
    const preview = await agent()
      .post(`/v1/students/${student.id}/plans/preview`)
      .set(writeHeaders(auth.cookies))
      .send({ tasks: [manualTask] });
    expect(preview.status).toBe(200);
    expect(preview.body.template).toBeNull();
    expect(preview.body.confirmAllowed).toBe(true);
    expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(0);
    const empty = await agent()
      .post(`/v1/students/${student.id}/plans`)
      .set(writeHeaders(auth.cookies))
      .send({
        expectedStudentVersion: student.version,
        previewDigest: preview.body.previewDigest,
        tasks: [],
        coCreationAttested: true,
      });
    expect(empty.status).toBe(400);
    expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(0);
    const nameless = await agent()
      .post(`/v1/students/${student.id}/plans/preview`)
      .set(writeHeaders(auth.cookies))
      .send({ tasks: [{ name: '', subject: '自定义', standard: '完成' }] });
    expect(nameless.status).toBe(400);
    expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(0);
  });

  it('S06 legal create, replay, conflict, actor and window', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '手动成功'));
    const missing = await previewAndCreate(auth.cookies, student, { attested: false });
    expect(missing.created.status).toBe(400);
    expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(0);

    const key = randomUUID();
    const first = await previewAndCreate(auth.cookies, student, { attested: true, idempotencyKey: key });
    expect(first.created.status).toBe(201);
    expect(first.created.body.origin).toBe('GUARDIAN_ASSISTED');
    expect(first.created.body.createdByAccountId).toBeTruthy();
    expect(first.created.body.studentConfirmedAt).toBeNull();
    expect(first.created.body.sourceTemplateVersionId).toBeNull();
    expect(first.created.body.series[0].name).toBe('自主阅读');
    const occ = await prisma.taskOccurrence.findMany({
      where: { series: { planId: first.created.body.id } },
    });
    expect(occ.length).toBeGreaterThan(0);
    expect(occ.length).toBeLessThanOrEqual(14);
    expect(occ.every((row) => row.gradeLabelSnapshot === '一年级')).toBe(true);

    const replay = await previewAndCreate(auth.cookies, student, { attested: true, idempotencyKey: key });
    expect(replay.created.status).toBe(201);
    expect(replay.created.body.id).toBe(first.created.body.id);
    expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(1);

    const conflict = await previewAndCreate(auth.cookies, student, {
      attested: true,
      idempotencyKey: key,
      mutate: (body) => {
        body.expectedStudentVersion = student.version + 9;
      },
    });
    expect(conflict.created.status).toBe(409);
    expect(conflict.created.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('S06 custom grade can create while template import stays blocked', async () => {
    const auth = await signIn();
    const grades = await agent().get('/v1/grade-configs').set('Cookie', auth.cookies.header());
    const custom = grades.body.items.find(
      (item: { schoolSystemCode: string; gradeCode: string }) =>
        item.schoolSystemCode === 'CUSTOM' && item.gradeCode === 'EXPERIMENTAL',
    );
    const student = await createStudent(auth.cookies, '自定义手动');
    const set = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: custom.id,
        termCode: 'FIRST_TERM',
        changeKind: 'SET',
      });
    expect(set.status).toBeLessThan(300);
    expect(set.body.education.catalogEntryKey).toBeNull();
    const listed = await agent().get(`/v1/templates?studentId=${student.id}`).set('Cookie', auth.cookies.header());
    expect(listed.body.importAllowed).toBe(false);
    const denied = await agent()
      .post(`/v1/students/${student.id}/templates/${listed.body.items[0].id}/import`)
      .set(writeHeaders(auth.cookies))
      .send({});
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe('TEMPLATE_IMPORT_NOT_ALLOWED');
    const created = await previewAndCreate(auth.cookies, { id: student.id, version: set.body.version });
    expect(created.created.status).toBe(201);
    expect(created.created.body.sourceTemplateVersionId).toBeNull();
    const occ = await prisma.taskOccurrence.findFirst({
      where: { series: { planId: created.created.body.id } },
    });
    expect(occ?.gradeLabelSnapshot).toBe('实验班');
    expect(occ?.catalogEntryKeySnapshot).toBe('');
  });

  it('S06 withdraw refuses new writes and idempotent replay', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '手动撤回'));
    const preview = await agent()
      .post(`/v1/students/${student.id}/plans/preview`)
      .set(writeHeaders(auth.cookies))
      .send({ tasks: [manualTask] });
    const key = randomUUID();
    const consents = await agent().get(`/v1/students/${student.id}/consents`).set('Cookie', auth.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const withdrawn = await agent()
      .post(`/v1/students/${student.id}/consents/${current.id}/withdraw`)
      .set(writeHeaders(auth.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdrawn.status).toBeLessThan(300);
    const body = {
      expectedStudentVersion: withdrawn.body.version ?? student.version,
      previewDigest: preview.body.previewDigest,
      tasks: preview.body.tasks,
      coCreationAttested: true,
    };
    const denied = await agent().post(`/v1/students/${student.id}/plans`).set(writeHeaders(auth.cookies, key)).send(body);
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(['SESSION_SCOPE_FORBIDDEN', 'LEARNING_ACCESS_BLOCKED', 'CONSENT_REQUIRED']).toContain(denied.body.code);
    const replay = await agent().post(`/v1/students/${student.id}/plans`).set(writeHeaders(auth.cookies, key)).send(body);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(0);
  });

  it('S06 expired step-up cannot confirm', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '手动二次验证'));
    const previous = runtime.value.timing.stepUpMs;
    runtime.value.timing.stepUpMs = 1;
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const denied = await previewAndCreate(auth.cookies, student, { attested: true });
      expect(denied.created.status).toBe(403);
      expect(denied.created.body.code).toBe('STEP_UP_REQUIRED');
      expect(await prisma.studyPlan.count({ where: { studentProfileId: student.id } })).toBe(0);
    } finally {
      runtime.value.timing.stepUpMs = previous;
    }
  });

  it('pause resume archive persist, refuse illegal transitions, and keep occurrence identity', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '状态控制'));
    const created = await previewAndImport(auth.cookies, student, { attested: true });
    expect(created.imported.status).toBe(201);
    const planId = created.imported.body.id as string;
    const origin = created.imported.body.origin as string;
    const before = await prisma.taskOccurrence.findMany({
      where: { series: { planId } },
      orderBy: { scheduledLocalDate: 'asc' },
    });
    expect(before.length).toBeGreaterThan(0);
    const fingerprints = before.map((row) => ({
      id: row.id,
      occurrenceKey: row.occurrenceKey,
      originalLocalDate: row.originalLocalDate,
      gradeLabelSnapshot: row.gradeLabelSnapshot,
      gradeConfigId: row.gradeConfigId,
    }));

    const paused = await patchPlan(auth.cookies, student.id, planId, { action: 'PAUSE', expectedVersion: 1 });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('PAUSED');
    expect(paused.body.origin).toBe(origin);
    expect(paused.body.studentConfirmedAt).toBeNull();
    expect(paused.body.lastAdjustment.reasonCode).toBe('PLAN_PAUSED');
    expect(paused.body.lastAdjustment.payload.actorScope).toBe('GUARDIAN');
    expect(paused.body.lastAdjustment.payload.actorAccountId).toBeTruthy();

    const reread = await agent().get(`/v1/students/${student.id}/plans/${planId}`).set('Cookie', auth.cookies.header());
    expect(reread.body.status).toBe('PAUSED');
    expect(reread.body.version).toBe(paused.body.version);
    expect(reread.body.lastAdjustment.id).toBe(paused.body.lastAdjustment.id);

    const afterPause = await prisma.taskOccurrence.findMany({
      where: { series: { planId } },
      orderBy: { scheduledLocalDate: 'asc' },
    });
    expect(afterPause.map((row) => ({
      id: row.id,
      occurrenceKey: row.occurrenceKey,
      originalLocalDate: row.originalLocalDate,
      gradeLabelSnapshot: row.gradeLabelSnapshot,
      gradeConfigId: row.gradeConfigId,
    }))).toEqual(fingerprints);
    expect(afterPause.every((row) => row.status === 'CANCELLED' && row.cancelReason === 'PLAN_PAUSED')).toBe(true);
    expect(await prisma.studyPlan.count({ where: { id: planId } })).toBe(1);
    expect(await prisma.taskSeries.count({ where: { planId } })).toBeGreaterThan(0);

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const to = new Date(Date.now() + 13 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const firstRead = await agent()
      .get(`/v1/students/${student.id}/tasks?from=${today}&to=${to}`)
      .set('Cookie', auth.cookies.header());
    expect(firstRead.body.items.every((item: { executable: boolean }) => item.executable === false)).toBe(true);
    const listedPlans = await agent().get(`/v1/students/${student.id}/plans`).set('Cookie', auth.cookies.header());
    expect(listedPlans.body.items[0].status).toBe('PAUSED');
    const secondRead = await agent()
      .get(`/v1/students/${student.id}/tasks?from=${today}&to=${to}`)
      .set('Cookie', auth.cookies.header());
    expect(secondRead.body.items.length).toBe(firstRead.body.items.length);
    expect(await prisma.taskOccurrence.count({ where: { series: { planId } } })).toBe(before.length);

    const horizon = await agent()
      .post(`/v1/students/${student.id}/task-horizon`)
      .set(writeHeaders(auth.cookies))
      .send({});
    expect(horizon.status).toBe(200);
    expect(horizon.body.insertedCount).toBe(0);
    expect(horizon.body.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'PLAN_PAUSED', planId })]),
    );
    expect(await prisma.taskOccurrence.count({ where: { series: { planId } } })).toBe(before.length);

    const duplicatePause = await patchPlan(auth.cookies, student.id, planId, {
      action: 'PAUSE',
      expectedVersion: paused.body.version,
    });
    expect(duplicatePause.status).toBe(409);
    expect(duplicatePause.body.code).toBe('PLAN_STATUS_INVALID');
    expect(await prisma.planAdjustment.count({ where: { planId } })).toBe(1);

    const resumed = await patchPlan(auth.cookies, student.id, planId, {
      action: 'RESUME',
      expectedVersion: paused.body.version,
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('ACTIVE');
    expect(resumed.body.origin).toBe(origin);
    const afterResume = await prisma.taskOccurrence.findMany({ where: { series: { planId } } });
    expect(afterResume.length).toBe(before.length);
    expect(afterResume.filter((row) => row.status === 'PLANNED').length).toBe(before.length);
    expect(afterResume.every((row) => row.cancelReason === null)).toBe(true);
    expect(new Set(afterResume.map((row) => row.id))).toEqual(new Set(before.map((row) => row.id)));

    const archived = await patchPlan(auth.cookies, student.id, planId, {
      action: 'ARCHIVE',
      expectedVersion: resumed.body.version,
    });
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('ARCHIVED');
    const unarchive = await patchPlan(auth.cookies, student.id, planId, {
      action: 'RESUME',
      expectedVersion: archived.body.version,
    });
    expect(unarchive.status).toBe(409);
    expect(unarchive.body.code).toBe('PLAN_STATUS_INVALID');
    const pauseArchived = await patchPlan(auth.cookies, student.id, planId, {
      action: 'PAUSE',
      expectedVersion: archived.body.version,
    });
    expect(pauseArchived.body.code).toBe('PLAN_STATUS_INVALID');
    const visible = await agent().get(`/v1/students/${student.id}/plans/${planId}`).set('Cookie', auth.cookies.header());
    expect(visible.status).toBe(200);
    expect(visible.body.status).toBe('ARCHIVED');
    const afterArchive = await prisma.taskOccurrence.findMany({ where: { series: { planId } } });
    expect(afterArchive.length).toBe(before.length);
    expect(afterArchive.every((row) => row.status === 'CANCELLED' && row.cancelReason === 'PLAN_ARCHIVED')).toBe(true);
    const tasksAfterArchive = await agent()
      .get(`/v1/students/${student.id}/tasks?from=${today}&to=${to}`)
      .set('Cookie', auth.cookies.header());
    expect(tasksAfterArchive.body.items.every((item: { executable?: boolean }) => item.executable !== true)).toBe(true);
  });

  it('plan status patch is idempotent and rejects same-key different body and stale version', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '状态幂等'));
    const created = await previewAndImport(auth.cookies, student, { attested: true });
    const planId = created.imported.body.id as string;
    const key = randomUUID();
    const first = await patchPlan(auth.cookies, student.id, planId, { action: 'PAUSE', expectedVersion: 1 }, key);
    expect(first.status).toBe(200);
    const replay = await patchPlan(auth.cookies, student.id, planId, { action: 'PAUSE', expectedVersion: 1 }, key);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(planId);
    expect(await prisma.planAdjustment.count({ where: { planId } })).toBe(1);
    const conflict = await patchPlan(
      auth.cookies,
      student.id,
      planId,
      { action: 'ARCHIVE', expectedVersion: 1 },
      key,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const stale = await patchPlan(auth.cookies, student.id, planId, { action: 'RESUME', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
  });

  it('unauthorized, withdrawn consent and expired session refuse status writes and replay', async () => {
    const owner = await signIn();
    const student = await setGrade(owner.cookies, await createStudent(owner.cookies, '状态拒绝'));
    const created = await previewAndImport(owner.cookies, student, { attested: true });
    const planId = created.imported.body.id as string;

    const stranger = await signIn();
    const missing = await patchPlan(stranger.cookies, student.id, planId, { action: 'PAUSE', expectedVersion: 1 });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('RESOURCE_NOT_FOUND');

    const consents = await agent().get(`/v1/students/${student.id}/consents`).set('Cookie', owner.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const withdrawn = await agent()
      .post(`/v1/students/${student.id}/consents/${current.id}/withdraw`)
      .set(writeHeaders(owner.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdrawn.status).toBeLessThan(300);
    const key = randomUUID();
    const denied = await patchPlan(owner.cookies, student.id, planId, { action: 'PAUSE', expectedVersion: 1 }, key);
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(['SESSION_SCOPE_FORBIDDEN', 'LEARNING_ACCESS_BLOCKED', 'CONSENT_REQUIRED']).toContain(denied.body.code);
    const replay = await patchPlan(owner.cookies, student.id, planId, { action: 'PAUSE', expectedVersion: 1 }, key);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.studyPlan.findUniqueOrThrow({ where: { id: planId } })).toMatchObject({ status: 'ACTIVE' });
    expect(await prisma.planAdjustment.count({ where: { planId } })).toBe(0);

    const other = await signIn();
    const otherStudent = await setGrade(other.cookies, await createStudent(other.cookies, '另一家'));
    const otherPlan = await previewAndImport(other.cookies, otherStudent, { attested: true });
    const expiredOut = await agent()
      .delete('/v1/auth/session')
      .set('Origin', ORIGIN)
      .set('Cookie', other.cookies.header())
      .set('X-CSRF-Token', other.cookies.get('stp_csrf') ?? '');
    expect(expiredOut.status).toBe(204);
    const expiredKey = randomUUID();
    const expired = await patchPlan(
      other.cookies,
      otherStudent.id,
      otherPlan.imported.body.id,
      { action: 'PAUSE', expectedVersion: 1 },
      expiredKey,
    );
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('AUTH_SESSION_INVALID');
    const expiredReplay = await patchPlan(
      other.cookies,
      otherStudent.id,
      otherPlan.imported.body.id,
      { action: 'PAUSE', expectedVersion: 1 },
      expiredKey,
    );
    expect(expiredReplay.status).toBe(401);
  });

  it('fills only missing horizon dates, skips ended/weekly/past, and does not revive cancelled rows', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '窗口规则'));
    const today = shanghaiToday();
    const ended = await createManualPlan(auth.cookies, student, [
      {
        name: '期末截止',
        subject: '自定义',
        standard: '完成',
        repeatKind: 'DAILY',
        startLocalDate: today,
        endLocalDate: today,
        ongoing: false,
      },
    ]);
    const endedRows = await prisma.taskOccurrence.findMany({ where: { series: { planId: ended.id } } });
    expect(endedRows.map((row) => row.occurrenceKey)).toEqual([today]);
    const endedAgain = await postHorizon(auth.cookies, student.id);
    expect(endedAgain.status).toBe(200);
    expect(endedAgain.body.insertedCount).toBe(0);
    expect(await prisma.taskOccurrence.count({ where: { series: { planId: ended.id } } })).toBe(1);

    const weekday = isoWeekdayFromLocalDate(today);
    const otherWeekday = (weekday === 1 ? 2 : 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
    const weeklyStudent = await setGrade(auth.cookies, await createStudent(auth.cookies, '每周指定'));
    const weekly = await createManualPlan(auth.cookies, weeklyStudent, [
      {
        name: '只练一天',
        subject: '自定义',
        standard: '完成',
        repeatKind: 'WEEKLY_DAYS',
        weekdays: [weekday],
        startLocalDate: today,
        ongoing: true,
      },
    ]);
    const weeklyRows = await prisma.taskOccurrence.findMany({ where: { series: { planId: weekly.id } } });
    expect(weeklyRows.length).toBeGreaterThan(0);
    expect(weeklyRows.length).toBeLessThan(14);
    expect(weeklyRows.every((row) => isoWeekdayFromLocalDate(row.occurrenceKey) === weekday)).toBe(true);
    expect(weeklyRows.every((row) => isoWeekdayFromLocalDate(row.occurrenceKey) !== otherWeekday || weekday === otherWeekday)).toBe(true);
    const weeklyAgain = await postHorizon(auth.cookies, weeklyStudent.id);
    expect(weeklyAgain.status).toBe(200);
    expect(weeklyAgain.body.insertedCount).toBe(0);
    expect(await prisma.taskOccurrence.count({ where: { series: { planId: weekly.id } } })).toBe(weeklyRows.length);

    const cancelStudent = await setGrade(auth.cookies, await createStudent(auth.cookies, '不复活'));
    const created = await previewAndImport(auth.cookies, cancelStudent, { attested: true });
    const planId = created.imported.body.id as string;
    const last = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId } },
      orderBy: { occurrenceKey: 'desc' },
    });
    await prisma.taskOccurrence.update({
      where: { id: last.id },
      data: { status: 'CANCELLED', cancelReason: 'USER_CANCELLED' },
    });
    const cancelledHorizon = await postHorizon(auth.cookies, cancelStudent.id);
    expect(cancelledHorizon.status).toBe(200);
    expect(cancelledHorizon.body.insertedCount).toBe(0);
    const revived = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: last.id } });
    expect(revived).toMatchObject({ status: 'CANCELLED', cancelReason: 'USER_CANCELLED' });
    expect(
      await prisma.taskOccurrence.count({
        where: { seriesId: last.seriesId, occurrenceKey: last.occurrenceKey },
      }),
    ).toBe(1);
  });

  it('cross-day fixture only inserts the new window edge and keeps prior rows unchanged', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '跨日夹具'));
    const created = await previewAndImport(auth.cookies, student, { attested: true });
    const planId = created.imported.body.id as string;
    const today = shanghaiToday();
    const key = randomUUID();
    const first = await postHorizon(auth.cookies, student.id, {}, key);
    expect(first.status).toBe(200);
    expect(first.body.insertedCount).toBe(0);
    await shiftPlanWindowBackOneDay(planId);
    const shifted = await prisma.taskOccurrence.findMany({
      where: { series: { planId } },
      orderBy: { occurrenceKey: 'asc' },
    });
    expect(shifted.some((row) => row.occurrenceKey < today)).toBe(true);
    const beforeCount = shifted.length;
    const fingerprints = shifted.map(occurrenceFingerprint);
    const getAfterShift = await agent()
      .get(`/v1/students/${student.id}/tasks?from=${addLocalDays(today, -1)}&to=${addLocalDays(today, 13)}`)
      .set('Cookie', auth.cookies.header());
    expect(getAfterShift.status).toBe(200);
    expect(await prisma.taskOccurrence.count({ where: { series: { planId } } })).toBe(beforeCount);

    const replay = await postHorizon(auth.cookies, student.id, {}, key);
    expect(replay.status).toBe(200);
    expect(replay.body.insertedCount).toBe(0);
    expect(replay.body.from).toBe(first.body.from);
    expect(await prisma.taskOccurrence.count({ where: { series: { planId } } })).toBe(beforeCount);

    const conflict = await postHorizon(auth.cookies, student.id, { expectedStudentVersion: 9 }, key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const filled = await postHorizon(auth.cookies, student.id);
    expect(filled.status).toBe(200);
    expect(filled.body.from).toBe(today);
    expect(filled.body.to).toBe(addLocalDays(today, 13));
    expect(filled.body.insertedCount).toBeGreaterThan(0);
    const after = await prisma.taskOccurrence.findMany({
      where: { series: { planId } },
      orderBy: { occurrenceKey: 'asc' },
    });
    expect(after.length).toBe(beforeCount + filled.body.insertedCount);
    const byId = new Map(after.map((row) => [row.id, row]));
    for (const previous of fingerprints) {
      expect(occurrenceFingerprint(byId.get(previous.id)!)).toEqual(previous);
    }
    const inserted = after.filter((row) => !fingerprints.some((item) => item.id === row.id));
    expect(inserted.every((row) => row.occurrenceKey >= today)).toBe(true);
    expect(inserted.some((row) => row.occurrenceKey === addLocalDays(today, 13))).toBe(true);
    expect(inserted.every((row) => row.occurrenceKey !== addLocalDays(today, -1))).toBe(true);
    expect(after.filter((row) => row.occurrenceKey < today).every((row) => fingerprints.some((item) => item.id === row.id))).toBe(true);
  });

  it('archived plans skip generation; promote uses new snapshot only on newly inserted rows', async () => {
    const auth = await signIn();
    const archivedStudent = await setGrade(auth.cookies, await createStudent(auth.cookies, '归档不生成'));
    const archivedPlan = await previewAndImport(auth.cookies, archivedStudent, { attested: true });
    const archivedId = archivedPlan.imported.body.id as string;
    const archived = await patchPlan(auth.cookies, archivedStudent.id, archivedId, {
      action: 'ARCHIVE',
      expectedVersion: 1,
    });
    expect(archived.status).toBe(200);
    const beforeArchiveCount = await prisma.taskOccurrence.count({ where: { series: { planId: archivedId } } });
    const archivedHorizon = await postHorizon(auth.cookies, archivedStudent.id);
    expect(archivedHorizon.status).toBe(200);
    expect(archivedHorizon.body.insertedCount).toBe(0);
    expect(archivedHorizon.body.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'PLAN_ARCHIVED', planId: archivedId })]),
    );
    expect(await prisma.taskOccurrence.count({ where: { series: { planId: archivedId } } })).toBe(beforeArchiveCount);

    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '升年级快照'));
    const created = await previewAndImport(auth.cookies, student, { attested: true });
    const planId = created.imported.body.id as string;
    const deleted = await deleteLatestOccurrence(planId);
    const remaining = await prisma.taskOccurrence.findMany({ where: { series: { planId } } });
    expect(remaining.every((row) => row.gradeLabelSnapshot === '一年级')).toBe(true);
    const grades = await agent().get('/v1/grade-configs').set('Cookie', auth.cookies.header());
    const g2 = grades.body.items.find(
      (item: { schoolSystemCode: string; gradeCode: string; stageCode: string }) =>
        item.schoolSystemCode === 'SIX_THREE' && item.stageCode === 'PRIMARY' && item.gradeCode === 'G2',
    );
    const latest = await agent().get(`/v1/students/${student.id}`).set('Cookie', auth.cookies.header());
    const promoted = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: latest.body.version,
        gradeConfigId: g2.id,
        termCode: 'FULL_YEAR',
        changeKind: 'PROMOTE',
      });
    expect(promoted.status).toBeLessThan(300);
    const filled = await postHorizon(auth.cookies, student.id);
    expect(filled.status).toBe(200);
    expect(filled.body.insertedCount).toBeGreaterThan(0);
    const after = await prisma.taskOccurrence.findMany({ where: { series: { planId } } });
    const inserted = after.filter((row) => !remaining.some((item) => item.id === row.id));
    expect(inserted.some((row) => row.occurrenceKey === deleted.occurrenceKey)).toBe(true);
    expect(inserted.every((row) => row.gradeLabelSnapshot === '二年级')).toBe(true);
    expect(after.filter((row) => remaining.some((item) => item.id === row.id)).every((row) => row.gradeLabelSnapshot === '一年级')).toBe(true);
  });

  it('rejects client-chosen windows and distinguishes no-op from unauthorized replay', async () => {
    const owner = await signIn();
    const student = await setGrade(owner.cookies, await createStudent(owner.cookies, '补齐拒绝'));
    const created = await previewAndImport(owner.cookies, student, { attested: true });
    expect(created.imported.status).toBe(201);
    const widened = await postHorizon(owner.cookies, student.id, { from: '2020-01-01', to: '2030-12-31' });
    expect(widened.status).toBe(400);
    expect(widened.body.code).toBe('VALIDATION_ERROR');

    const empty = await setGrade(owner.cookies, await createStudent(owner.cookies, '无计划'));
    const noPlan = await postHorizon(owner.cookies, empty.id);
    expect(noPlan.status).toBe(200);
    expect(noPlan.body.insertedCount).toBe(0);
    expect(noPlan.body.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'NO_PLAN' })]));

    const stranger = await signIn();
    const missing = await postHorizon(stranger.cookies, student.id);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('RESOURCE_NOT_FOUND');

    const consents = await agent().get(`/v1/students/${student.id}/consents`).set('Cookie', owner.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const withdrawn = await agent()
      .post(`/v1/students/${student.id}/consents/${current.id}/withdraw`)
      .set(writeHeaders(owner.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdrawn.status).toBeLessThan(300);
    const key = randomUUID();
    const denied = await postHorizon(owner.cookies, student.id, {}, key);
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(['SESSION_SCOPE_FORBIDDEN', 'LEARNING_ACCESS_BLOCKED', 'CONSENT_REQUIRED']).toContain(denied.body.code);
    const replay = await postHorizon(owner.cookies, student.id, {}, key);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.status).not.toBe(200);

    const other = await signIn();
    const otherStudent = await setGrade(other.cookies, await createStudent(other.cookies, '另一家补齐'));
    await previewAndImport(other.cookies, otherStudent, { attested: true });
    const expiredOut = await agent()
      .delete('/v1/auth/session')
      .set('Origin', ORIGIN)
      .set('Cookie', other.cookies.header())
      .set('X-CSRF-Token', other.cookies.get('stp_csrf') ?? '');
    expect(expiredOut.status).toBe(204);
    const expiredKey = randomUUID();
    const expired = await postHorizon(other.cookies, otherStudent.id, {}, expiredKey);
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('AUTH_SESSION_INVALID');
    const expiredReplay = await postHorizon(other.cookies, otherStudent.id, {}, expiredKey);
    expect(expiredReplay.status).toBe(401);
  });

  it('reschedules only the scheduled date, keeps identity, and does not overwrite a sibling day', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '单次改期'));
    const created = await previewAndImport(auth.cookies, student, { attested: true });
    expect(created.imported.status).toBe(201);
    const planId = created.imported.body.id as string;
    const today = shanghaiToday();
    const rows = await prisma.taskOccurrence.findMany({
      where: { series: { planId }, status: 'PLANNED' },
      orderBy: { scheduledLocalDate: 'asc' },
    });
    const seriesId = rows.find((row) => rows.filter((item) => item.seriesId === row.seriesId).length > 1)?.seriesId;
    const sameSeries = rows.filter((row) => row.seriesId === seriesId);
    expect(sameSeries.length).toBeGreaterThan(1);
    const moving = sameSeries[0]!;
    const sibling = sameSeries[1]!;
    const farDate = addLocalDays(today, 20);
    const moved = await postReschedule(auth.cookies, student.id, moving.id, {
      scheduledLocalDate: farDate,
      reason: '调到窗口外',
      expectedVersion: moving.version,
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      id: moving.id,
      occurrenceKey: moving.occurrenceKey,
      originalLocalDate: moving.originalLocalDate,
      scheduledLocalDate: farDate,
      seriesId: moving.seriesId,
      version: moving.version + 1,
      gradeLabelSnapshot: moving.gradeLabelSnapshot,
    });
    const persisted = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: moving.id } });
    expect(persisted).toMatchObject({
      occurrenceKey: moving.occurrenceKey,
      originalLocalDate: moving.originalLocalDate,
      scheduledLocalDate: farDate,
      gradeLabelSnapshot: moving.gradeLabelSnapshot,
      gradeConfigId: moving.gradeConfigId,
    });
    const audit = await prisma.planAdjustment.findMany({
      where: { planId, occurrenceId: moving.id, reasonCode: 'TASK_RESCHEDULED' },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.payloadJson)).toMatchObject({
      fromScheduledLocalDate: moving.scheduledLocalDate,
      toScheduledLocalDate: farDate,
      occurrenceKey: moving.occurrenceKey,
      originalLocalDate: moving.originalLocalDate,
      reason: '调到窗口外',
      actorScope: 'GUARDIAN',
    });

    const oldDay = await agent()
      .get(`/v1/students/${student.id}/tasks?date=${moving.scheduledLocalDate}`)
      .set('Cookie', auth.cookies.header());
    expect(oldDay.body.items.some((item: { id: string }) => item.id === moving.id)).toBe(false);
    const newDay = await agent()
      .get(`/v1/students/${student.id}/tasks?date=${farDate}`)
      .set('Cookie', auth.cookies.header());
    expect(newDay.body.items.some((item: { id: string; scheduledLocalDate: string }) => item.id === moving.id && item.scheduledLocalDate === farDate)).toBe(true);

    const collision = await postReschedule(auth.cookies, student.id, moving.id, {
      scheduledLocalDate: sibling.scheduledLocalDate,
      reason: '撞日',
      expectedVersion: moved.body.version,
    });
    expect(collision.status).toBe(409);
    expect(collision.body.code).toBe('TASK_DATE_CONFLICT');
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: moving.id } })).toMatchObject({
      scheduledLocalDate: farDate,
      occurrenceKey: moving.occurrenceKey,
    });
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: sibling.id } })).toMatchObject({
      scheduledLocalDate: sibling.scheduledLocalDate,
      occurrenceKey: sibling.occurrenceKey,
      status: sibling.status,
    });
    expect(await prisma.taskOccurrence.count({ where: { seriesId: moving.seriesId } })).toBe(
      rows.filter((row) => row.seriesId === moving.seriesId).length,
    );

    const sameDay = await postReschedule(auth.cookies, student.id, moving.id, {
      scheduledLocalDate: farDate,
      reason: '无变化',
      expectedVersion: moved.body.version,
    });
    expect(sameDay.status).toBe(200);
    expect(sameDay.body.scheduledLocalDate).toBe(farDate);
    expect(sameDay.body.version).toBe(moved.body.version);
    expect(await prisma.planAdjustment.count({ where: { planId, occurrenceId: moving.id, reasonCode: 'TASK_RESCHEDULED' } })).toBe(1);

    const horizon = await postHorizon(auth.cookies, student.id);
    expect(horizon.status).toBe(200);
    expect(
      await prisma.taskOccurrence.count({
        where: { seriesId: moving.seriesId, occurrenceKey: moving.occurrenceKey },
      }),
    ).toBe(1);
    const afterHorizon = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: moving.id } });
    expect(afterHorizon.scheduledLocalDate).toBe(farDate);
    expect(afterHorizon.occurrenceKey).toBe(moving.occurrenceKey);

    const paused = await patchPlan(auth.cookies, student.id, planId, {
      action: 'PAUSE',
      expectedVersion: 1,
    });
    expect(paused.status).toBe(200);
    const pausedFar = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: moving.id } });
    expect(pausedFar).toMatchObject({ status: 'CANCELLED', cancelReason: 'PLAN_PAUSED', scheduledLocalDate: farDate });
    const resumed = await patchPlan(auth.cookies, student.id, planId, {
      action: 'RESUME',
      expectedVersion: paused.body.version,
    });
    expect(resumed.status).toBe(200);
    const restoredFar = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: moving.id } });
    expect(restoredFar).toMatchObject({
      status: 'PLANNED',
      cancelReason: null,
      scheduledLocalDate: farDate,
      occurrenceKey: moving.occurrenceKey,
    });
  });

  it('rejects past, illegal, unauthorized and stale reschedule requests and keeps idempotency', async () => {
    const owner = await signIn();
    const student = await setGrade(owner.cookies, await createStudent(owner.cookies, '改期拒绝'));
    const created = await previewAndImport(owner.cookies, student, { attested: true });
    const planId = created.imported.body.id as string;
    const today = shanghaiToday();
    const moving = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId }, status: 'PLANNED' },
      orderBy: { scheduledLocalDate: 'asc' },
    });
    const target = addLocalDays(today, 20);

    const past = await postReschedule(owner.cookies, student.id, moving.id, {
      scheduledLocalDate: addLocalDays(today, -1),
      reason: '改到昨天',
      expectedVersion: moving.version,
    });
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('VALIDATION_ERROR');

    const stale = await postReschedule(owner.cookies, student.id, moving.id, {
      scheduledLocalDate: target,
      reason: '旧版本',
      expectedVersion: 999,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');

    const stranger = await signIn();
    const missing = await postReschedule(stranger.cookies, student.id, moving.id, {
      scheduledLocalDate: target,
      reason: '越权',
      expectedVersion: moving.version,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('RESOURCE_NOT_FOUND');

    const key = randomUUID();
    const first = await postReschedule(
      owner.cookies,
      student.id,
      moving.id,
      { scheduledLocalDate: target, reason: '第一次', expectedVersion: moving.version },
      key,
    );
    expect(first.status).toBe(200);
    const replay = await postReschedule(
      owner.cookies,
      student.id,
      moving.id,
      { scheduledLocalDate: target, reason: '第一次', expectedVersion: moving.version },
      key,
    );
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(moving.id);
    expect(replay.body.scheduledLocalDate).toBe(target);
    expect(await prisma.planAdjustment.count({ where: { planId, occurrenceId: moving.id, reasonCode: 'TASK_RESCHEDULED' } })).toBe(1);
    const conflict = await postReschedule(
      owner.cookies,
      student.id,
      moving.id,
      { scheduledLocalDate: addLocalDays(today, 21), reason: '异体', expectedVersion: moving.version },
      key,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const pausedStudent = await setGrade(owner.cookies, await createStudent(owner.cookies, '暂停后改期'));
    const pausedPlan = await previewAndImport(owner.cookies, pausedStudent, { attested: true });
    const pausedId = pausedPlan.imported.body.id as string;
    const pausedRow = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: pausedId }, status: 'PLANNED' },
    });
    const paused = await patchPlan(owner.cookies, pausedStudent.id, pausedId, { action: 'PAUSE', expectedVersion: 1 });
    expect(paused.status).toBe(200);
    const afterPause = await postReschedule(owner.cookies, pausedStudent.id, pausedRow.id, {
      scheduledLocalDate: addLocalDays(today, 2),
      reason: '暂停后',
      expectedVersion: pausedRow.version,
    });
    expect(afterPause.status).toBe(409);
    expect(['PLAN_STATUS_INVALID', 'TASK_NOT_ADJUSTABLE']).toContain(afterPause.body.code);

    const consents = await agent().get(`/v1/students/${student.id}/consents`).set('Cookie', owner.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const withdrawn = await agent()
      .post(`/v1/students/${student.id}/consents/${current.id}/withdraw`)
      .set(writeHeaders(owner.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdrawn.status).toBeLessThan(300);
    const deniedKey = randomUUID();
    const latest = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: moving.id } });
    const denied = await postReschedule(
      owner.cookies,
      student.id,
      moving.id,
      { scheduledLocalDate: addLocalDays(today, 5), reason: '撤回后', expectedVersion: latest.version },
      deniedKey,
    );
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(['SESSION_SCOPE_FORBIDDEN', 'LEARNING_ACCESS_BLOCKED', 'CONSENT_REQUIRED']).toContain(denied.body.code);
    const deniedReplay = await postReschedule(
      owner.cookies,
      student.id,
      moving.id,
      { scheduledLocalDate: addLocalDays(today, 5), reason: '撤回后', expectedVersion: latest.version },
      deniedKey,
    );
    expect(deniedReplay.status).toBeGreaterThanOrEqual(400);
    expect(deniedReplay.status).not.toBe(200);

    const other = await signIn();
    const otherStudent = await setGrade(other.cookies, await createStudent(other.cookies, '另一家改期'));
    const otherPlan = await previewAndImport(other.cookies, otherStudent, { attested: true });
    const otherRow = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: otherPlan.imported.body.id }, status: 'PLANNED' },
    });
    const expiredOut = await agent()
      .delete('/v1/auth/session')
      .set('Origin', ORIGIN)
      .set('Cookie', other.cookies.header())
      .set('X-CSRF-Token', other.cookies.get('stp_csrf') ?? '');
    expect(expiredOut.status).toBe(204);
    const expiredKey = randomUUID();
    const expired = await postReschedule(
      other.cookies,
      otherStudent.id,
      otherRow.id,
      { scheduledLocalDate: addLocalDays(today, 2), reason: '过期', expectedVersion: otherRow.version },
      expiredKey,
    );
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('AUTH_SESSION_INVALID');
    const expiredReplay = await postReschedule(
      other.cookies,
      otherStudent.id,
      otherRow.id,
      { scheduledLocalDate: addLocalDays(today, 2), reason: '过期', expectedVersion: otherRow.version },
      expiredKey,
    );
    expect(expiredReplay.status).toBe(401);
  });

  it('edits only the selected occurrence snapshots and keeps series plus siblings', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '本次内容'));
    const created = await previewAndImport(auth.cookies, student, { attested: true });
    expect(created.imported.status).toBe(201);
    const planId = created.imported.body.id as string;
    const rows = await prisma.taskOccurrence.findMany({
      where: { series: { planId }, status: 'PLANNED' },
      orderBy: { scheduledLocalDate: 'asc' },
      include: { series: true },
    });
    const seriesId = rows.find((row) => rows.filter((item) => item.seriesId === row.seriesId).length > 1)?.seriesId;
    const sameSeries = rows.filter((row) => row.seriesId === seriesId);
    expect(sameSeries.length).toBeGreaterThan(1);
    const editing = sameSeries[0]!;
    const sibling = sameSeries[1]!;
    const seriesBefore = await prisma.taskSeries.findUniqueOrThrow({ where: { id: editing.seriesId } });

    const edited = await patchOccurrence(auth.cookies, student.id, editing.id, {
      name: '只改今天',
      subject: '语文',
      standard: '读完指定页',
      durationMinutes: 25,
      steps: ['先读', '再勾选'],
      expectedVersion: editing.version,
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      id: editing.id,
      occurrenceKey: editing.occurrenceKey,
      scheduledLocalDate: editing.scheduledLocalDate,
      originalLocalDate: editing.originalLocalDate,
      seriesId: editing.seriesId,
      name: '只改今天',
      subject: '语文',
      completionStandard: '读完指定页',
      durationMinutes: 25,
      steps: ['先读', '再勾选'],
      version: editing.version + 1,
      gradeLabelSnapshot: editing.gradeLabelSnapshot,
    });
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: sibling.id } })).toMatchObject({
      nameSnapshot: sibling.nameSnapshot,
      subjectSnapshot: sibling.subjectSnapshot,
      completionStandardSnapshot: sibling.completionStandardSnapshot,
      durationMinutesSnapshot: sibling.durationMinutesSnapshot,
      stepsSnapshotJson: sibling.stepsSnapshotJson,
      scheduledLocalDate: sibling.scheduledLocalDate,
      occurrenceKey: sibling.occurrenceKey,
    });
    expect(await prisma.taskSeries.findUniqueOrThrow({ where: { id: editing.seriesId } })).toMatchObject({
      name: seriesBefore.name,
      subject: seriesBefore.subject,
      completionStandard: seriesBefore.completionStandard,
      durationMinutes: seriesBefore.durationMinutes,
      stepsJson: seriesBefore.stepsJson,
    });
    const audit = await prisma.planAdjustment.findMany({
      where: { planId, occurrenceId: editing.id, reasonCode: 'TASK_CONTENT_EDITED' },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.payloadJson).fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'name', to: '只改今天' })]),
    );

    const sameBody = await patchOccurrence(auth.cookies, student.id, editing.id, {
      name: '只改今天',
      subject: '语文',
      standard: '读完指定页',
      durationMinutes: 25,
      steps: ['先读', '再勾选'],
      expectedVersion: edited.body.version,
    });
    expect(sameBody.status).toBe(200);
    expect(sameBody.body.version).toBe(edited.body.version);
    expect(await prisma.planAdjustment.count({ where: { planId, occurrenceId: editing.id, reasonCode: 'TASK_CONTENT_EDITED' } })).toBe(1);

    const latest = await prisma.taskOccurrence.findFirstOrThrow({
      where: { seriesId: editing.seriesId },
      orderBy: { occurrenceKey: 'desc' },
    });
    await prisma.taskOccurrence.delete({ where: { id: latest.id } });
    const horizon = await postHorizon(auth.cookies, student.id);
    expect(horizon.status).toBe(200);
    expect(horizon.body.insertedCount).toBeGreaterThan(0);
    const reinserted = await prisma.taskOccurrence.findFirstOrThrow({
      where: { seriesId: editing.seriesId, occurrenceKey: latest.occurrenceKey },
    });
    expect(reinserted.id).not.toBe(latest.id);
    expect(reinserted).toMatchObject({
      nameSnapshot: seriesBefore.name,
      subjectSnapshot: seriesBefore.subject,
      completionStandardSnapshot: seriesBefore.completionStandard,
    });
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: editing.id } })).toMatchObject({
      nameSnapshot: '只改今天',
      completionStandardSnapshot: '读完指定页',
    });

    const paused = await patchPlan(auth.cookies, student.id, planId, { action: 'PAUSE', expectedVersion: 1 });
    expect(paused.status).toBe(200);
    const resumed = await patchPlan(auth.cookies, student.id, planId, {
      action: 'RESUME',
      expectedVersion: paused.body.version,
    });
    expect(resumed.status).toBe(200);
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: editing.id } })).toMatchObject({
      status: 'PLANNED',
      nameSnapshot: '只改今天',
      subjectSnapshot: '语文',
      completionStandardSnapshot: '读完指定页',
      durationMinutesSnapshot: 25,
      scheduledLocalDate: editing.scheduledLocalDate,
      occurrenceKey: editing.occurrenceKey,
    });
  });

  it('rejects invalid, unauthorized, stale and paused content edits and keeps idempotency', async () => {
    const owner = await signIn();
    const student = await setGrade(owner.cookies, await createStudent(owner.cookies, '内容拒绝'));
    const created = await previewAndImport(owner.cookies, student, { attested: true });
    const planId = created.imported.body.id as string;
    const row = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId }, status: 'PLANNED' },
      orderBy: { scheduledLocalDate: 'asc' },
    });
    const valid = {
      name: '合法改名',
      subject: '语文',
      standard: '读完指定页',
      durationMinutes: 10,
      steps: ['先读'],
    };

    const empty = await patchOccurrence(owner.cookies, student.id, row.id, {
      ...valid,
      name: '',
      expectedVersion: row.version,
    });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('VALIDATION_ERROR');

    const stale = await patchOccurrence(owner.cookies, student.id, row.id, {
      ...valid,
      expectedVersion: 999,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');

    const stranger = await signIn();
    const missing = await patchOccurrence(stranger.cookies, student.id, row.id, {
      ...valid,
      expectedVersion: row.version,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('RESOURCE_NOT_FOUND');

    const key = randomUUID();
    const first = await patchOccurrence(owner.cookies, student.id, row.id, { ...valid, expectedVersion: row.version }, key);
    expect(first.status).toBe(200);
    const replay = await patchOccurrence(owner.cookies, student.id, row.id, { ...valid, expectedVersion: row.version }, key);
    expect(replay.status).toBe(200);
    expect(replay.body.name).toBe('合法改名');
    expect(await prisma.planAdjustment.count({ where: { planId, occurrenceId: row.id, reasonCode: 'TASK_CONTENT_EDITED' } })).toBe(1);
    const conflict = await patchOccurrence(
      owner.cookies,
      student.id,
      row.id,
      { ...valid, name: '异体', expectedVersion: row.version },
      key,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const pausedStudent = await setGrade(owner.cookies, await createStudent(owner.cookies, '暂停后编辑'));
    const pausedPlan = await previewAndImport(owner.cookies, pausedStudent, { attested: true });
    const pausedId = pausedPlan.imported.body.id as string;
    const pausedRow = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: pausedId }, status: 'PLANNED' },
    });
    const paused = await patchPlan(owner.cookies, pausedStudent.id, pausedId, { action: 'PAUSE', expectedVersion: 1 });
    expect(paused.status).toBe(200);
    const afterPause = await patchOccurrence(owner.cookies, pausedStudent.id, pausedRow.id, {
      ...valid,
      expectedVersion: pausedRow.version,
    });
    expect(afterPause.status).toBe(409);
    expect(['PLAN_STATUS_INVALID', 'TASK_NOT_ADJUSTABLE']).toContain(afterPause.body.code);

    const consents = await agent().get(`/v1/students/${student.id}/consents`).set('Cookie', owner.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const withdrawn = await agent()
      .post(`/v1/students/${student.id}/consents/${current.id}/withdraw`)
      .set(writeHeaders(owner.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdrawn.status).toBeLessThan(300);
    const deniedKey = randomUUID();
    const latest = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: row.id } });
    const denied = await patchOccurrence(
      owner.cookies,
      student.id,
      row.id,
      { ...valid, name: '撤回后', expectedVersion: latest.version },
      deniedKey,
    );
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(['SESSION_SCOPE_FORBIDDEN', 'LEARNING_ACCESS_BLOCKED', 'CONSENT_REQUIRED']).toContain(denied.body.code);
    const deniedReplay = await patchOccurrence(
      owner.cookies,
      student.id,
      row.id,
      { ...valid, name: '撤回后', expectedVersion: latest.version },
      deniedKey,
    );
    expect(deniedReplay.status).toBeGreaterThanOrEqual(400);
    expect(deniedReplay.status).not.toBe(200);
  });

  it('applies FUTURE content from the original key and keeps exceptions, dates and other series', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '未来内容'));
    const today = shanghaiToday();
    const created = await createManualPlan(auth.cookies, student, [
      {
        name: '主规则',
        subject: '语文',
        standard: '读完一页',
        repeatKind: 'DAILY',
        startLocalDate: today,
        ongoing: true,
      },
      {
        name: '另一规则',
        subject: '数学',
        standard: '完成练习',
        repeatKind: 'DAILY',
        startLocalDate: today,
        ongoing: true,
      },
    ]);
    const planId = created.id;
    const rows = await prisma.taskOccurrence.findMany({
      where: { series: { planId }, status: 'PLANNED' },
      orderBy: { occurrenceKey: 'asc' },
      include: { series: true },
    });
    const seriesId = rows.find((row) => rows.filter((item) => item.seriesId === row.seriesId).length > 3)?.seriesId;
    const sameSeries = rows.filter((row) => row.seriesId === seriesId).sort((a, b) => a.occurrenceKey.localeCompare(b.occurrenceKey));
    const otherSeries = rows.find((row) => row.seriesId !== seriesId);
    expect(sameSeries.length).toBeGreaterThan(3);
    expect(otherSeries).toBeTruthy();
    const before = sameSeries[0]!;
    const anchor = sameSeries[1]!;
    const later = sameSeries[2]!;
    const far = sameSeries[3]!;
    const edited = await patchOccurrence(auth.cookies, student.id, later.id, {
      name: '单次例外',
      subject: later.subjectSnapshot,
      standard: later.completionStandardSnapshot,
      durationMinutes: later.durationMinutesSnapshot,
      steps: JSON.parse(later.stepsSnapshotJson),
      expectedVersion: later.version,
    });
    expect(edited.status).toBe(200);
    const reverted = await patchOccurrence(auth.cookies, student.id, later.id, {
      name: later.nameSnapshot,
      subject: later.subjectSnapshot,
      standard: later.completionStandardSnapshot,
      durationMinutes: later.durationMinutesSnapshot,
      steps: JSON.parse(later.stepsSnapshotJson),
      expectedVersion: edited.body.version,
    });
    expect(reverted.status).toBe(200);
    const farDate = addLocalDays(shanghaiToday(), 20);
    const moved = await postReschedule(auth.cookies, student.id, far.id, {
      scheduledLocalDate: farDate,
      reason: '改期锚点外实例',
      expectedVersion: far.version,
    });
    expect(moved.status).toBe(200);
    const anchorDate = addLocalDays(shanghaiToday(), 15);
    const movedAnchor = await postReschedule(auth.cookies, student.id, anchor.id, {
      scheduledLocalDate: anchorDate,
      reason: '改期锚点本身',
      expectedVersion: anchor.version,
    });
    expect(movedAnchor.status).toBe(200);

    const freshStudent = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    const series = await prisma.taskSeries.findUniqueOrThrow({ where: { id: seriesId! } });
    const plan = await prisma.studyPlan.findUniqueOrThrow({ where: { id: planId } });
    const liveAnchor = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: anchor.id } });
    const versions = {
      expectedStudentVersion: freshStudent.version,
      expectedPlanVersion: plan.version,
      expectedSeriesVersion: series.version,
      expectedOccurrenceVersion: liveAnchor.version,
    };
    const proposal = {
      kind: 'CONTENT',
      name: '未来统一名',
      subject: '语文',
      standard: '按新课文完成',
      durationMinutes: 25,
      steps: ['先读新课文'],
      reason: '统一后续内容',
    };
    const mixedRejected = await postFuturePreview(auth.cookies, student.id, liveAnchor.id, {
      ...versions,
      proposal: { kind: 'SCHEDULE', name: '混填', reason: '缺字段' },
    });
    expect(mixedRejected.status).toBe(400);

    const preview = await postFuturePreview(auth.cookies, student.id, liveAnchor.id, { ...versions, proposal });
    expect(preview.status).toBe(200);
    expect(preview.body.cutoffOccurrenceKey).toBe(liveAnchor.occurrenceKey);
    expect(preview.body.cutoffOccurrenceKey).not.toBe(liveAnchor.scheduledLocalDate);
    expect(preview.body.anchor.scheduledLocalDate).toBe(anchorDate);
    expect(preview.body.effects.modified.some((item: { id: string }) => item.id === liveAnchor.id)).toBe(true);
    expect(preview.body.effects.preservedException.some((item: { id: string }) => item.id === later.id)).toBe(true);
    expect(preview.body.effects.unchanged.some((item: { id: string }) => item.id === before.id)).toBe(true);
    expect(await prisma.taskSeriesRevision.count({ where: { taskSeriesId: seriesId! } })).toBe(1);

    const stale = await postFutureConfirm(auth.cookies, student.id, liveAnchor.id, {
      ...versions,
      proposal,
      previewDigest: 'stale-digest-value-xx',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('TASK_FUTURE_PREVIEW_STALE');

    const confirmed = await postFutureConfirm(auth.cookies, student.id, liveAnchor.id, {
      ...versions,
      proposal,
      previewDigest: preview.body.previewDigest,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.plan.version).toBe(plan.version);
    expect(confirmed.body.series.version).toBe(series.version + 1);
    expect(confirmed.body.adjustmentId).toBeTruthy();

    const afterRows = await prisma.taskOccurrence.findMany({ where: { seriesId } });
    expect(afterRows.find((row) => row.id === before.id)?.nameSnapshot).toBe(before.nameSnapshot);
    expect(afterRows.find((row) => row.id === liveAnchor.id)?.nameSnapshot).toBe('未来统一名');
    expect(afterRows.find((row) => row.id === liveAnchor.id)?.scheduledLocalDate).toBe(anchorDate);
    expect(afterRows.find((row) => row.id === liveAnchor.id)?.occurrenceKey).toBe(anchor.occurrenceKey);
    expect(afterRows.find((row) => row.id === later.id)?.nameSnapshot).toBe(later.nameSnapshot);
    expect(afterRows.find((row) => row.id === later.id)?.contentExceptionAdjustmentId).toBeTruthy();
    expect(afterRows.find((row) => row.id === far.id)?.scheduledLocalDate).toBe(farDate);
    expect(afterRows.find((row) => row.id === far.id)?.occurrenceKey).toBe(far.occurrenceKey);
    expect(afterRows.find((row) => row.id === far.id)?.nameSnapshot).toBe('未来统一名');
    expect(otherSeries && (await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: otherSeries.id } })).nameSnapshot).toBe(
      otherSeries?.nameSnapshot,
    );

    const gap = afterRows.find((row) => row.occurrenceKey > liveAnchor.occurrenceKey && row.id !== later.id && row.id !== far.id);
    if (gap) {
      await prisma.taskOccurrence.delete({ where: { id: gap.id } });
      const horizon = await agent()
        .post(`/v1/students/${student.id}/task-horizon`)
        .set(writeHeaders(auth.cookies))
        .send({});
      expect(horizon.status).toBe(200);
      const regenerated = await prisma.taskOccurrence.findFirst({
        where: { seriesId, occurrenceKey: gap.occurrenceKey },
      });
      expect(regenerated?.nameSnapshot).toBe('未来统一名');
      expect(regenerated?.id).not.toBe(gap.id);
    }

    const afterHorizon = await prisma.taskOccurrence.findMany({ where: { seriesId } });
    const secondAnchor = afterHorizon.find(
      (row) =>
        row.occurrenceKey > liveAnchor.occurrenceKey &&
        row.id !== later.id &&
        row.id !== far.id &&
        row.contentExceptionAdjustmentId == null &&
        row.status === 'PLANNED',
    );
    if (secondAnchor) {
      const afterFirst = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: secondAnchor.id } });
      const afterStudent = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
      const afterSeries = await prisma.taskSeries.findUniqueOrThrow({ where: { id: seriesId! } });
      const secondProposal = { ...proposal, name: '第二次切点名', reason: '更晚切点' };
      const secondPreview = await postFuturePreview(auth.cookies, student.id, afterFirst.id, {
        expectedStudentVersion: afterStudent.version,
        expectedPlanVersion: plan.version,
        expectedSeriesVersion: afterSeries.version,
        expectedOccurrenceVersion: afterFirst.version,
        proposal: secondProposal,
      });
      expect(secondPreview.status).toBe(200);
      const second = await postFutureConfirm(auth.cookies, student.id, afterFirst.id, {
        expectedStudentVersion: afterStudent.version,
        expectedPlanVersion: plan.version,
        expectedSeriesVersion: afterSeries.version,
        expectedOccurrenceVersion: afterFirst.version,
        proposal: secondProposal,
        previewDigest: secondPreview.body.previewDigest,
      });
      expect(second.status).toBe(200);
      const twice = await prisma.taskOccurrence.findMany({ where: { seriesId } });
      expect(twice.find((row) => row.id === liveAnchor.id)?.nameSnapshot).toBe('未来统一名');
      expect(twice.find((row) => row.id === afterFirst.id)?.nameSnapshot).toBe('第二次切点名');
      expect(twice.find((row) => row.id === later.id)?.nameSnapshot).toBe(later.nameSnapshot);
      const regenTarget = twice.find(
        (row) =>
          row.occurrenceKey > afterFirst.occurrenceKey &&
          row.id !== later.id &&
          row.id !== far.id &&
          row.contentExceptionAdjustmentId == null &&
          row.status === 'PLANNED',
      );
      if (regenTarget) {
        await prisma.taskOccurrence.delete({ where: { id: regenTarget.id } });
        const again = await agent()
          .post(`/v1/students/${student.id}/task-horizon`)
          .set(writeHeaders(auth.cookies))
          .send({});
        expect(again.status).toBe(200);
        const regeneratedLater = await prisma.taskOccurrence.findFirst({
          where: { seriesId, occurrenceKey: regenTarget.occurrenceKey },
        });
        expect(regeneratedLater?.nameSnapshot).toBe('第二次切点名');
      }
    }
  });

  it('keeps FUTURE preview/cancel/no-op/idempotency and refuses unauthorized replay', async () => {
    const owner = await signIn();
    const student = await setGrade(owner.cookies, await createStudent(owner.cookies, '未来幂等'));
    const created = await previewAndImport(owner.cookies, student, { attested: true });
    const planId = created.imported.body.id as string;
    const row = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId }, status: 'PLANNED' },
      include: { series: true },
    });
    const studentRow = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    const plan = await prisma.studyPlan.findUniqueOrThrow({ where: { id: planId } });
    const versions = {
      expectedStudentVersion: studentRow.version,
      expectedPlanVersion: plan.version,
      expectedSeriesVersion: row.series.version,
      expectedOccurrenceVersion: row.version,
    };
    const sameProposal = {
      kind: 'CONTENT',
      name: row.nameSnapshot,
      subject: row.subjectSnapshot,
      standard: row.completionStandardSnapshot,
      durationMinutes: row.durationMinutesSnapshot,
      steps: JSON.parse(row.stepsSnapshotJson),
      reason: '无变化',
    };
    const preview = await postFuturePreview(owner.cookies, student.id, row.id, { ...versions, proposal: sameProposal });
    expect(preview.status).toBe(200);
    expect(preview.body.noOp).toBe(true);
    expect(await prisma.taskSeriesRevision.count({ where: { taskSeriesId: row.seriesId } })).toBe(1);
    const noOp = await postFutureConfirm(owner.cookies, student.id, row.id, {
      ...versions,
      proposal: sameProposal,
      previewDigest: preview.body.previewDigest,
    });
    expect(noOp.status).toBe(200);
    expect(noOp.body.noOp).toBe(true);
    expect(noOp.body.adjustmentId).toBeNull();
    expect(await prisma.taskSeriesRevision.count({ where: { taskSeriesId: row.seriesId } })).toBe(1);

    const changedProposal = { ...sameProposal, name: '第二次修订', reason: '再改一次' };
    const nextStudent = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    const nextSeries = await prisma.taskSeries.findUniqueOrThrow({ where: { id: row.seriesId } });
    const nextRow = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: row.id } });
    const nextVersions = {
      expectedStudentVersion: nextStudent.version,
      expectedPlanVersion: plan.version,
      expectedSeriesVersion: nextSeries.version,
      expectedOccurrenceVersion: nextRow.version,
    };
    const nextPreview = await postFuturePreview(owner.cookies, student.id, row.id, {
      ...nextVersions,
      proposal: changedProposal,
    });
    expect(nextPreview.status).toBe(200);
    const key = randomUUID();
    const first = await postFutureConfirm(
      owner.cookies,
      student.id,
      row.id,
      { ...nextVersions, proposal: changedProposal, previewDigest: nextPreview.body.previewDigest },
      key,
    );
    expect(first.status).toBe(200);
    const replay = await postFutureConfirm(
      owner.cookies,
      student.id,
      row.id,
      { ...nextVersions, proposal: changedProposal, previewDigest: nextPreview.body.previewDigest },
      key,
    );
    expect(replay.status).toBe(200);
    expect(replay.body.adjustmentId).toBe(first.body.adjustmentId);
    expect(await prisma.planAdjustment.count({ where: { seriesId: row.seriesId, reasonCode: 'SERIES_FUTURE_CONTENT_CHANGED' } })).toBe(1);
    const conflict = await postFutureConfirm(
      owner.cookies,
      student.id,
      row.id,
      { ...nextVersions, proposal: { ...changedProposal, name: '异体' }, previewDigest: nextPreview.body.previewDigest },
      key,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const consents = await agent().get(`/v1/students/${student.id}/consents`).set('Cookie', owner.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    await agent()
      .post(`/v1/students/${student.id}/consents/${current.id}/withdraw`)
      .set(writeHeaders(owner.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    const denied = await postFutureConfirm(
      owner.cookies,
      student.id,
      row.id,
      { ...nextVersions, proposal: changedProposal, previewDigest: nextPreview.body.previewDigest },
      key,
    );
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.status).not.toBe(200);
  });

  it('applies FUTURE schedule from the original key, restores removals, and keeps exceptions plus other series', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '未来排期'));
    const today = shanghaiToday();
    const created = await createManualPlan(auth.cookies, student, [
      {
        name: '主规则',
        subject: '语文',
        standard: '读完一页',
        repeatKind: 'DAILY',
        startLocalDate: today,
        ongoing: true,
      },
      {
        name: '另一规则',
        subject: '数学',
        standard: '完成练习',
        repeatKind: 'DAILY',
        startLocalDate: today,
        ongoing: true,
      },
    ]);
    const planId = created.id;
    const rows = await prisma.taskOccurrence.findMany({
      where: { series: { planId }, status: 'PLANNED' },
      orderBy: { occurrenceKey: 'asc' },
      include: { series: true },
    });
    const seriesId = rows.find((row) => rows.filter((item) => item.seriesId === row.seriesId).length > 3)?.seriesId;
    const sameSeries = rows.filter((row) => row.seriesId === seriesId).sort((a, b) => a.occurrenceKey.localeCompare(b.occurrenceKey));
    const otherSeries = rows.find((row) => row.seriesId !== seriesId);
    expect(sameSeries.length).toBeGreaterThan(3);
    expect(otherSeries).toBeTruthy();
    const before = sameSeries[0]!;
    const anchor = sameSeries[1]!;
    const later = sameSeries[2]!;
    const far = sameSeries[3]!;
    const laterDate = addLocalDays(shanghaiToday(), 20);
    const moved = await postReschedule(auth.cookies, student.id, later.id, {
      scheduledLocalDate: laterDate,
      reason: '排期例外',
      expectedVersion: later.version,
    });
    expect(moved.status).toBe(200);
    const edited = await patchOccurrence(auth.cookies, student.id, far.id, {
      name: '内容例外名',
      subject: far.subjectSnapshot,
      standard: far.completionStandardSnapshot,
      durationMinutes: far.durationMinutesSnapshot,
      steps: JSON.parse(far.stepsSnapshotJson),
      expectedVersion: far.version,
    });
    expect(edited.status).toBe(200);

    const weekday = isoWeekdayFromLocalDate(anchor.occurrenceKey);
    const studentRow = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    const series = await prisma.taskSeries.findUniqueOrThrow({ where: { id: seriesId! } });
    const plan = await prisma.studyPlan.findUniqueOrThrow({ where: { id: planId } });
    const liveAnchor = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: anchor.id } });
    const versions = {
      expectedStudentVersion: studentRow.version,
      expectedPlanVersion: plan.version,
      expectedSeriesVersion: series.version,
      expectedOccurrenceVersion: liveAnchor.version,
    };
    const weeklyProposal = {
      kind: 'SCHEDULE' as const,
      repeatKind: 'WEEKLY_DAYS' as const,
      weekdays: [weekday],
      endLocalDate: null,
      ongoing: true,
      reason: '改成每周一天',
    };
    const preview = await postFuturePreview(auth.cookies, student.id, liveAnchor.id, { ...versions, proposal: weeklyProposal });
    expect(preview.status).toBe(200);
    expect(preview.body.cutoffOccurrenceKey).toBe(liveAnchor.occurrenceKey);
    expect(preview.body.effects.cancelled.length).toBeGreaterThan(0);
    expect(preview.body.effects.preservedException.some((item: { id: string }) => item.id === later.id)).toBe(true);
    expect(preview.body.effects.unchanged.some((item: { id: string }) => item.id === before.id)).toBe(true);
    expect(preview.body.conflicts).toEqual([]);
    expect(await prisma.taskSeriesRevision.count({ where: { taskSeriesId: seriesId! } })).toBe(1);

    const confirmed = await postFutureConfirm(auth.cookies, student.id, liveAnchor.id, {
      ...versions,
      proposal: weeklyProposal,
      previewDigest: preview.body.previewDigest,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.plan.version).toBe(plan.version);
    expect(confirmed.body.series.version).toBe(series.version + 1);
    expect(confirmed.body.adjustmentId).toBeTruthy();
    expect(
      await prisma.planAdjustment.count({ where: { seriesId: seriesId!, reasonCode: 'SERIES_FUTURE_SCHEDULE_CHANGED' } }),
    ).toBe(1);
    expect(await prisma.planAdjustment.count({ where: { seriesId: seriesId!, reasonCode: 'TASK_RESCHEDULED' } })).toBe(1);

    const afterRows = await prisma.taskOccurrence.findMany({ where: { seriesId } });
    expect(afterRows.find((row) => row.id === before.id)?.status).toBe('PLANNED');
    expect(afterRows.find((row) => row.id === liveAnchor.id)?.status).toBe('PLANNED');
    expect(afterRows.find((row) => row.id === liveAnchor.id)?.scheduleRevisionNo).toBe(confirmed.body.series.version);
    expect(afterRows.find((row) => row.id === later.id)?.status).toBe('PLANNED');
    expect(afterRows.find((row) => row.id === later.id)?.scheduledLocalDate).toBe(laterDate);
    expect(afterRows.find((row) => row.id === later.id)?.occurrenceKey).toBe(later.occurrenceKey);
    expect(afterRows.find((row) => row.id === far.id)?.nameSnapshot).toBe('内容例外名');
    const cancelled = afterRows.filter(
      (row) =>
        row.occurrenceKey > liveAnchor.occurrenceKey &&
        row.id !== later.id &&
        row.status === 'CANCELLED' &&
        row.cancelReason === 'SERIES_RULE_REMOVED',
    );
    expect(cancelled.length).toBeGreaterThan(0);
    expect(cancelled.every((row) => row.id === afterRows.find((item) => item.occurrenceKey === row.occurrenceKey)?.id)).toBe(
      true,
    );
    expect(otherSeries && (await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: otherSeries.id } })).status).toBe(
      'PLANNED',
    );

    const restoredTarget =
      cancelled.find((row) => isoWeekdayFromLocalDate(row.occurrenceKey) !== isoWeekdayFromLocalDate(laterDate)) ??
      cancelled[0]!;
    const restoreWeekday = isoWeekdayFromLocalDate(restoredTarget.occurrenceKey);
    const restoredStudent = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    const restoredSeries = await prisma.taskSeries.findUniqueOrThrow({ where: { id: seriesId! } });
    const restoredAnchor = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: liveAnchor.id } });
    const restoreProposal = {
      kind: 'SCHEDULE' as const,
      repeatKind: 'WEEKLY_DAYS' as const,
      weekdays: [...new Set([weekday, restoreWeekday])],
      endLocalDate: null,
      ongoing: true,
      reason: '把旧日再纳入',
    };
    const restorePreview = await postFuturePreview(auth.cookies, student.id, restoredAnchor.id, {
      expectedStudentVersion: restoredStudent.version,
      expectedPlanVersion: plan.version,
      expectedSeriesVersion: restoredSeries.version,
      expectedOccurrenceVersion: restoredAnchor.version,
      proposal: restoreProposal,
    });
    expect(restorePreview.status).toBe(200);
    expect(restorePreview.body.effects.restored.some((item: { id: string }) => item.id === restoredTarget.id)).toBe(true);
    const restored = await postFutureConfirm(auth.cookies, student.id, restoredAnchor.id, {
      expectedStudentVersion: restoredStudent.version,
      expectedPlanVersion: plan.version,
      expectedSeriesVersion: restoredSeries.version,
      expectedOccurrenceVersion: restoredAnchor.version,
      proposal: restoreProposal,
      previewDigest: restorePreview.body.previewDigest,
    });
    expect(restored.status).toBe(200);
    const revived = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: restoredTarget.id } });
    expect(revived).toMatchObject({
      status: 'PLANNED',
      cancelReason: null,
      occurrenceKey: restoredTarget.occurrenceKey,
      scheduledLocalDate: restoredTarget.scheduledLocalDate,
      gradeLabelSnapshot: restoredTarget.gradeLabelSnapshot,
    });

    await prisma.taskOccurrence.update({
      where: { id: revived.id },
      data: { status: 'CANCELLED', cancelReason: 'USER_CANCELLED' },
    });
    const userCancelHorizon = await agent()
      .post(`/v1/students/${student.id}/task-horizon`)
      .set(writeHeaders(auth.cookies))
      .send({});
    expect(userCancelHorizon.status).toBe(200);
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: revived.id } })).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'USER_CANCELLED',
    });
  });

  it('keeps CONTENT and SCHEDULE axes independent and rejects same-series collisions without partial writes', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, '双轴排期'));
    const today = shanghaiToday();
    const created = await createManualPlan(auth.cookies, student, [
      {
        name: '主规则',
        subject: '语文',
        standard: '读完一页',
        repeatKind: 'DAILY',
        startLocalDate: today,
        ongoing: true,
      },
    ]);
    const planId = created.id;
    const rows = await prisma.taskOccurrence.findMany({
      where: { series: { planId }, status: 'PLANNED' },
      orderBy: { occurrenceKey: 'asc' },
    });
    expect(rows.length).toBeGreaterThan(3);
    const anchor = rows[0]!;
    const later = rows[1]!;
    const versions = async (occurrenceId: string) => {
      const studentRow = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
      const row = await prisma.taskOccurrence.findUniqueOrThrow({
        where: { id: occurrenceId },
        include: { series: { include: { plan: true } } },
      });
      return {
        expectedStudentVersion: studentRow.version,
        expectedPlanVersion: row.series.plan.version,
        expectedSeriesVersion: row.series.version,
        expectedOccurrenceVersion: row.version,
        seriesId: row.seriesId,
        seriesVersion: row.series.version,
        lock: {
          expectedStudentVersion: studentRow.version,
          expectedPlanVersion: row.series.plan.version,
          expectedSeriesVersion: row.series.version,
          expectedOccurrenceVersion: row.version,
        },
      };
    };

    const contentProposal = {
      kind: 'CONTENT' as const,
      name: '先改内容',
      subject: '语文',
      standard: '按新课文完成',
      durationMinutes: 25,
      steps: ['先读新课文'],
      reason: '内容轴',
    };
    const contentVersions = await versions(anchor.id);
    const contentPreview = await postFuturePreview(auth.cookies, student.id, anchor.id, {
      ...contentVersions.lock,
      proposal: contentProposal,
    });
    expect(contentPreview.status).toBe(200);
    const contentConfirm = await postFutureConfirm(auth.cookies, student.id, anchor.id, {
      ...contentVersions.lock,
      proposal: contentProposal,
      previewDigest: contentPreview.body.previewDigest,
    });
    expect(contentConfirm.status).toBe(200);

    const weekday = isoWeekdayFromLocalDate(anchor.occurrenceKey);
    const scheduleProposal = {
      kind: 'SCHEDULE' as const,
      repeatKind: 'WEEKLY_DAYS' as const,
      weekdays: [weekday],
      endLocalDate: null,
      ongoing: true,
      reason: '排期轴',
    };
    const scheduleVersions = await versions(anchor.id);
    const schedulePreview = await postFuturePreview(auth.cookies, student.id, anchor.id, {
      ...scheduleVersions.lock,
      proposal: scheduleProposal,
    });
    expect(schedulePreview.status).toBe(200);
    const scheduleConfirm = await postFutureConfirm(auth.cookies, student.id, anchor.id, {
      ...scheduleVersions.lock,
      proposal: scheduleProposal,
      previewDigest: schedulePreview.body.previewDigest,
    });
    expect(scheduleConfirm.status).toBe(200);
    const afterSchedule = await prisma.taskOccurrence.findMany({ where: { seriesId: contentVersions.seriesId } });
    expect(afterSchedule.find((row) => row.id === anchor.id)?.nameSnapshot).toBe('先改内容');
    expect(afterSchedule.find((row) => row.id === later.id)?.nameSnapshot).toBe('先改内容');
    const cancelledAfterWeekly = afterSchedule.filter((row) => row.status === 'CANCELLED');
    expect(cancelledAfterWeekly.length).toBeGreaterThan(0);

    const secondContent = { ...contentProposal, name: '再改内容', reason: '排期后再改内容' };
    const secondVersions = await versions(anchor.id);
    const secondPreview = await postFuturePreview(auth.cookies, student.id, anchor.id, {
      ...secondVersions.lock,
      proposal: secondContent,
    });
    expect(secondPreview.status).toBe(200);
    const secondConfirm = await postFutureConfirm(auth.cookies, student.id, anchor.id, {
      ...secondVersions.lock,
      proposal: secondContent,
      previewDigest: secondPreview.body.previewDigest,
    });
    expect(secondConfirm.status).toBe(200);
    const afterContent = await prisma.taskOccurrence.findMany({ where: { seriesId: contentVersions.seriesId } });
    expect(afterContent.find((row) => row.id === anchor.id)?.nameSnapshot).toBe('再改内容');
    expect(afterContent.find((row) => row.id === later.id && later.status === 'PLANNED')?.status ?? afterContent.find((row) => row.id === later.id)?.status).toBeDefined();
    expect(afterContent.find((row) => row.id === later.id)?.status).toBe(
      afterSchedule.find((row) => row.id === later.id)?.status,
    );
    expect(afterContent.find((row) => row.id === later.id)?.scheduledLocalDate).toBe(
      afterSchedule.find((row) => row.id === later.id)?.scheduledLocalDate,
    );

    const occupant = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: anchor.id } });
    const farDate = addLocalDays(shanghaiToday(), 20);
    const moved = await postReschedule(auth.cookies, student.id, occupant.id, {
      scheduledLocalDate: farDate,
      reason: '占住窗口外日期',
      expectedVersion: occupant.version,
    });
    expect(moved.status).toBe(200);
    const collideProposal = {
      kind: 'SCHEDULE' as const,
      repeatKind: 'DAILY' as const,
      weekdays: null,
      endLocalDate: null,
      ongoing: true,
      reason: '会撞日',
    };
    const collideVersions = await versions(occupant.id);
    const collidePreview = await postFuturePreview(auth.cookies, student.id, occupant.id, {
      ...collideVersions.lock,
      proposal: collideProposal,
    });
    expect(collidePreview.status).toBe(200);
    expect(collidePreview.body.conflicts.length).toBeGreaterThan(0);
    const beforeCount = await prisma.taskSeriesRevision.count({ where: { taskSeriesId: contentVersions.seriesId } });
    const collideConfirm = await postFutureConfirm(auth.cookies, student.id, occupant.id, {
      ...collideVersions.lock,
      proposal: collideProposal,
      previewDigest: collidePreview.body.previewDigest,
    });
    expect(collideConfirm.status).toBe(409);
    expect(collideConfirm.body.code).toBe('TASK_DATE_CONFLICT');
    expect(await prisma.taskSeriesRevision.count({ where: { taskSeriesId: contentVersions.seriesId } })).toBe(beforeCount);
    expect(await prisma.taskSeries.findUniqueOrThrow({ where: { id: contentVersions.seriesId } })).toMatchObject({
      version: collideVersions.seriesVersion,
    });
    const returned = await postReschedule(auth.cookies, student.id, occupant.id, {
      scheduledLocalDate: occupant.occurrenceKey,
      reason: '改回原日以便继续',
      expectedVersion: (await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: occupant.id } })).version,
    });
    expect(returned.status).toBe(200);

    const staleVersions = await versions(occupant.id);
    const stale = await postFutureConfirm(auth.cookies, student.id, occupant.id, {
      ...staleVersions.lock,
      proposal: collideProposal,
      previewDigest: 'stale-digest-value-xx',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('TASK_FUTURE_PREVIEW_STALE');

    const noOpProposal = {
      kind: 'SCHEDULE' as const,
      repeatKind: 'WEEKLY_DAYS' as const,
      weekdays: [weekday],
      endLocalDate: null,
      ongoing: true,
      reason: '无变化',
    };
    const noOpVersions = await versions(occupant.id);
    const noOpPreview = await postFuturePreview(auth.cookies, student.id, occupant.id, {
      ...noOpVersions.lock,
      proposal: noOpProposal,
    });
    expect(noOpPreview.status).toBe(200);
    expect(noOpPreview.body.noOp).toBe(true);
    const noOp = await postFutureConfirm(auth.cookies, student.id, occupant.id, {
      ...noOpVersions.lock,
      proposal: noOpProposal,
      previewDigest: noOpPreview.body.previewDigest,
    });
    expect(noOp.status).toBe(200);
    expect(noOp.body.noOp).toBe(true);
    expect(noOp.body.adjustmentId).toBeNull();

    const addProposal = {
      kind: 'SCHEDULE' as const,
      repeatKind: 'DAILY' as const,
      weekdays: null,
      endLocalDate: null,
      ongoing: true,
      reason: '补回每天',
    };
    const addVersions = await versions(occupant.id);
    const addPreview = await postFuturePreview(auth.cookies, student.id, occupant.id, {
      ...addVersions.lock,
      proposal: addProposal,
    });
    expect(addPreview.status).toBe(200);
    const addConfirm = await postFutureConfirm(auth.cookies, student.id, occupant.id, {
      ...addVersions.lock,
      proposal: addProposal,
      previewDigest: addPreview.body.previewDigest,
    });
    expect(addConfirm.status).toBe(200);
    const gap = await prisma.taskOccurrence.findFirst({
      where: {
        seriesId: contentVersions.seriesId,
        status: 'PLANNED',
        occurrenceKey: { gt: occupant.occurrenceKey },
        scheduleExceptionAdjustmentId: null,
      },
      orderBy: { occurrenceKey: 'asc' },
    });
    if (gap) {
      const oldGrade = gap.gradeLabelSnapshot;
      await prisma.taskOccurrence.delete({ where: { id: gap.id } });
      const horizon = await agent()
        .post(`/v1/students/${student.id}/task-horizon`)
        .set(writeHeaders(auth.cookies))
        .send({});
      expect(horizon.status).toBe(200);
      const regenerated = await prisma.taskOccurrence.findFirst({
        where: { seriesId: contentVersions.seriesId, occurrenceKey: gap.occurrenceKey },
      });
      expect(regenerated?.id).not.toBe(gap.id);
      expect(regenerated?.nameSnapshot).toBe('再改内容');
      expect(regenerated?.gradeLabelSnapshot).toBe(oldGrade);
      const leftover = await prisma.taskOccurrence.findUnique({ where: { id: gap.id } });
      expect(leftover).toBeNull();
    }

    const key = randomUUID();
    const idemVersions = await versions(occupant.id);
    const idemProposal = {
      kind: 'SCHEDULE' as const,
      repeatKind: 'WEEKLY_DAYS' as const,
      weekdays: [weekday],
      endLocalDate: null,
      ongoing: true,
      reason: '幂等排期',
    };
    const idemPreview = await postFuturePreview(auth.cookies, student.id, occupant.id, {
      ...idemVersions.lock,
      proposal: idemProposal,
    });
    expect(idemPreview.status).toBe(200);
    const first = await postFutureConfirm(
      auth.cookies,
      student.id,
      occupant.id,
      { ...idemVersions.lock, proposal: idemProposal, previewDigest: idemPreview.body.previewDigest },
      key,
    );
    expect(first.status).toBe(200);
    const replay = await postFutureConfirm(
      auth.cookies,
      student.id,
      occupant.id,
      { ...idemVersions.lock, proposal: idemProposal, previewDigest: idemPreview.body.previewDigest },
      key,
    );
    expect(replay.status).toBe(200);
    expect(replay.body.adjustmentId).toBe(first.body.adjustmentId);
    const different = await postFutureConfirm(
      auth.cookies,
      student.id,
      occupant.id,
      {
        ...idemVersions.lock,
        proposal: { ...idemProposal, reason: '异体' },
        previewDigest: idemPreview.body.previewDigest,
      },
      key,
    );
    expect(different.status).toBe(409);
    expect(different.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  async function postSplitPreview(
    cookies: CookieJar,
    studentId: string,
    occurrenceId: string,
    body: Record<string, unknown>,
  ) {
    return agent()
      .post(`/v1/students/${studentId}/tasks/${occurrenceId}/split/preview`)
      .set(writeHeaders(cookies))
      .send(body);
  }

  async function postSplitConfirm(
    cookies: CookieJar,
    studentId: string,
    occurrenceId: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    return agent()
      .post(`/v1/students/${studentId}/tasks/${occurrenceId}/split`)
      .set(writeHeaders(cookies, idempotencyKey))
      .send(body);
  }

  function splitChildrenFor(row: { nameSnapshot: string; subjectSnapshot: string; completionStandardSnapshot: string; scheduledLocalDate: string }, extra: Partial<{ date: string; name: string }> = {}) {
    const date = extra.date ?? row.scheduledLocalDate;
    return [
      {
        name: extra.name ?? `${row.nameSnapshot}上`,
        subject: row.subjectSnapshot,
        standard: '完成前半',
        durationMinutes: 10,
        steps: ['先做前半'],
        scheduledLocalDate: date,
      },
      {
        name: `${row.nameSnapshot}下`,
        subject: row.subjectSnapshot,
        standard: '完成后半',
        durationMinutes: 10,
        steps: ['再做后半'],
        scheduledLocalDate: date,
      },
    ];
  }

  it('previews split without writing and confirms parent SPLIT with independent ONCE children', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, `拆分${randomUUID().slice(0, 6)}`));
    const plan = await createManualPlan(auth.cookies, student, [
      {
        name: '朗读课文',
        subject: '语文',
        standard: '读完整篇',
        durationMinutes: 20,
        steps: ['先读'],
        repeatKind: 'ONCE',
        startLocalDate: shanghaiToday(),
        endLocalDate: shanghaiToday(),
        ongoing: false,
      },
    ]);
    const parent = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: plan.id }, status: 'PLANNED' },
      include: { series: true },
    });
    const beforeCounts = await prisma.taskOccurrence.count({ where: { series: { planId: plan.id } } });
    const versions = {
      expectedStudentVersion: (await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } })).version,
      expectedPlanVersion: plan.version,
      expectedSeriesVersion: parent.series.version,
      expectedOccurrenceVersion: parent.version,
    };
    const children = splitChildrenFor(parent);
    const preview = await postSplitPreview(auth.cookies, student.id, parent.id, { ...versions, children, reason: '拆成两次' });
    expect(preview.status).toBe(200);
    expect(preview.body.parent.id).toBe(parent.id);
    expect(preview.body.parent.willCancelReason).toBe('SPLIT');
    expect(preview.body.children).toHaveLength(2);
    expect(preview.body.previewDigest).toBeTruthy();
    expect(await prisma.taskOccurrence.count({ where: { series: { planId: plan.id } } })).toBe(beforeCounts);
    expect(await prisma.planAdjustment.count({ where: { planId: plan.id, reasonCode: 'TASK_SPLIT' } })).toBe(0);

    const confirmed = await postSplitConfirm(auth.cookies, student.id, parent.id, {
      ...versions,
      children,
      reason: '拆成两次',
      previewDigest: preview.body.previewDigest,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.parent.status).toBe('CANCELLED');
    expect(confirmed.body.parent.cancelReason).toBe('SPLIT');
    expect(confirmed.body.parent.id).toBe(parent.id);
    expect(confirmed.body.parent.occurrenceKey).toBe(parent.occurrenceKey);
    expect(confirmed.body.children).toHaveLength(2);
    const storedParent = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: parent.id } });
    expect(storedParent.seriesId).toBe(parent.seriesId);
    expect(storedParent.occurrenceKey).toBe(parent.occurrenceKey);
    expect(storedParent.nameSnapshot).toBe(parent.nameSnapshot);
    expect(storedParent.gradeLabelSnapshot).toBe(parent.gradeLabelSnapshot);
    expect(storedParent.contentExceptionAdjustmentId).toBeNull();
    const childRows = await prisma.taskOccurrence.findMany({ where: { sourceOccurrenceId: parent.id }, include: { series: { include: { revisions: true } } } });
    expect(childRows).toHaveLength(2);
    expect(childRows.every((row) => row.series.planId === plan.id)).toBe(true);
    expect(childRows.every((row) => row.series.repeatKind === 'ONCE')).toBe(true);
    expect(childRows.every((row) => row.series.revisions.some((rev) => rev.revisionNo === 1 && rev.changeKind === 'BASELINE'))).toBe(true);
    expect(childRows.every((row) => row.contentRevisionNo === 1 && row.scheduleRevisionNo === 1)).toBe(true);
    const listed = await agent().get(`/v1/students/${student.id}/tasks?date=${parent.scheduledLocalDate}`).set('Cookie', auth.cookies.header());
    expect(listed.status).toBe(200);
    expect(listed.body.items.some((item: { id: string }) => item.id === parent.id)).toBe(false);
    expect(listed.body.items.filter((item: { sourceOccurrenceId: string | null }) => item.sourceOccurrenceId === parent.id)).toHaveLength(2);
    expect(listed.body.items).toHaveLength(2);
    const byId = await agent().get(`/v1/students/${student.id}/tasks/${parent.id}`).set('Cookie', auth.cookies.header());
    expect(byId.status).toBe(200);
    expect(byId.body.cancelReason).toBe('SPLIT');
    expect(byId.body.executable).toBe(false);
    expect(byId.body.splitChildren).toHaveLength(2);
    const audit = await prisma.planAdjustment.findFirstOrThrow({ where: { id: confirmed.body.adjustmentId } });
    expect(audit.reasonCode).toBe('TASK_SPLIT');
    const payload = JSON.parse(audit.payloadJson) as { actorAccountId?: string; children?: unknown[] };
    expect(payload.actorAccountId).toBeTruthy();
    expect(payload.children).toHaveLength(2);
    const planAfter = await prisma.studyPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(planAfter.version).toBe(plan.version);
    expect(planAfter.studentConfirmedAt).toBeNull();
    const horizon = await postHorizon(auth.cookies, student.id, {});
    expect(horizon.status).toBe(200);
    expect(await prisma.taskOccurrence.count({ where: { id: parent.id, status: 'PLANNED' } })).toBe(0);
    expect(await prisma.taskOccurrence.count({ where: { sourceOccurrenceId: parent.id } })).toBe(2);

    const child = childRows[0]!;
    const childFuture = await postFuturePreview(auth.cookies, student.id, child.id, {
      expectedStudentVersion: versions.expectedStudentVersion,
      expectedPlanVersion: plan.version,
      expectedSeriesVersion: child.series.version,
      expectedOccurrenceVersion: child.version,
      proposal: {
        kind: 'CONTENT',
        name: '不该改',
        subject: '语文',
        standard: '完成',
        durationMinutes: 10,
        steps: [],
        reason: '子任务未来',
      },
    });
    expect(childFuture.status).toBe(409);
    expect(childFuture.body.code).toBe('TASK_NOT_ADJUSTABLE');
    const childSplit = await postSplitPreview(auth.cookies, student.id, child.id, {
      expectedStudentVersion: versions.expectedStudentVersion,
      expectedPlanVersion: plan.version,
      expectedSeriesVersion: child.series.version,
      expectedOccurrenceVersion: child.version,
      children,
      reason: '再拆',
    });
    expect(childSplit.status).toBe(409);
    expect(childSplit.body.code).toBe('TASK_NOT_ADJUSTABLE');
    const edited = await patchOccurrence(auth.cookies, student.id, child.id, {
      name: '子任务改名',
      subject: child.subjectSnapshot,
      standard: '完成前半',
      durationMinutes: 10,
      steps: ['先做前半'],
      expectedVersion: child.version,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.name).toBe('子任务改名');
    const moved = await postReschedule(auth.cookies, student.id, child.id, {
      scheduledLocalDate: shanghaiToday() === child.scheduledLocalDate ? addLocalDays(child.scheduledLocalDate, 1) : shanghaiToday(),
      reason: '子任务改期',
      expectedVersion: edited.body.version,
    });
    expect(moved.status).toBe(200);
    expect((await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe('CANCELLED');
    expect((await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: parent.id } })).cancelReason).toBe('SPLIT');
  });

  it('rejects illegal split counts, past dates, stale preview and concurrent replay rules', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, `拆分拒${randomUUID().slice(0, 6)}`));
    const plan = await createManualPlan(auth.cookies, student, [
      {
        name: '口算',
        subject: '数学',
        standard: '做完十题',
        durationMinutes: 15,
        steps: [],
        repeatKind: 'ONCE',
        startLocalDate: shanghaiToday(),
        endLocalDate: shanghaiToday(),
        ongoing: false,
      },
    ]);
    const parent = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: plan.id }, status: 'PLANNED' },
      include: { series: true },
    });
    const versions = {
      expectedStudentVersion: (await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } })).version,
      expectedPlanVersion: plan.version,
      expectedSeriesVersion: parent.series.version,
      expectedOccurrenceVersion: parent.version,
    };
    const oneChild = await postSplitPreview(auth.cookies, student.id, parent.id, {
      ...versions,
      children: splitChildrenFor(parent).slice(0, 1),
      reason: '一条不算拆分',
    });
    expect(oneChild.status).toBe(400);
    const past = await postSplitPreview(auth.cookies, student.id, parent.id, {
      ...versions,
      children: splitChildrenFor(parent, { date: '2020-01-01' }),
      reason: '过去日期',
    });
    expect(past.status).toBe(400);
    const preview = await postSplitPreview(auth.cookies, student.id, parent.id, {
      ...versions,
      children: splitChildrenFor(parent),
      reason: '合法拆分',
    });
    expect(preview.status).toBe(200);
    const stale = await postSplitConfirm(auth.cookies, student.id, parent.id, {
      ...versions,
      children: splitChildrenFor(parent),
      reason: '合法拆分',
      previewDigest: 'stale-digest-value-xx',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('TASK_SPLIT_PREVIEW_STALE');
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({
      status: 'PLANNED',
      cancelReason: null,
    });
    const oldVersion = await postSplitConfirm(auth.cookies, student.id, parent.id, {
      ...versions,
      expectedOccurrenceVersion: parent.version + 9,
      children: splitChildrenFor(parent),
      reason: '合法拆分',
      previewDigest: preview.body.previewDigest,
    });
    expect(oldVersion.status).toBe(409);
    expect(oldVersion.body.code).toBe('VERSION_CONFLICT');
    const key = randomUUID();
    const first = await postSplitConfirm(
      auth.cookies,
      student.id,
      parent.id,
      { ...versions, children: splitChildrenFor(parent), reason: '合法拆分', previewDigest: preview.body.previewDigest },
      key,
    );
    expect(first.status).toBe(200);
    const replay = await postSplitConfirm(
      auth.cookies,
      student.id,
      parent.id,
      { ...versions, children: splitChildrenFor(parent), reason: '合法拆分', previewDigest: preview.body.previewDigest },
      key,
    );
    expect(replay.status).toBe(200);
    expect(replay.body.adjustmentId).toBe(first.body.adjustmentId);
    const different = await postSplitConfirm(
      auth.cookies,
      student.id,
      parent.id,
      { ...versions, children: splitChildrenFor(parent), reason: '异体拆分', previewDigest: preview.body.previewDigest },
      key,
    );
    expect(different.status).toBe(409);
    expect(different.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const again = await postSplitConfirm(auth.cookies, student.id, parent.id, {
      ...versions,
      expectedOccurrenceVersion: first.body.parent.version,
      children: splitChildrenFor(parent),
      reason: '再次拆分',
      previewDigest: preview.body.previewDigest,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('TASK_NOT_ADJUSTABLE');
    expect(await prisma.taskOccurrence.count({ where: { sourceOccurrenceId: parent.id } })).toBe(2);
  });

  it('keeps SPLIT parents cancelled through pause/resume and future schedule restore', async () => {
    const auth = await signIn();
    const student = await setGrade(auth.cookies, await createStudent(auth.cookies, `拆分停${randomUUID().slice(0, 6)}`));
    const imported = await previewAndImport(auth.cookies, student);
    expect(imported.imported.status).toBe(201);
    const planId = imported.imported.body.id as string;
    const parent = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId }, status: 'PLANNED' },
      include: { series: true },
    });
    const studentRow = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.id } });
    const versions = {
      expectedStudentVersion: studentRow.version,
      expectedPlanVersion: imported.imported.body.version as number,
      expectedSeriesVersion: parent.series.version,
      expectedOccurrenceVersion: parent.version,
    };
    const preview = await postSplitPreview(auth.cookies, student.id, parent.id, {
      ...versions,
      children: splitChildrenFor(parent),
      reason: '先拆再暂停',
    });
    expect(preview.status).toBe(200);
    const confirmed = await postSplitConfirm(auth.cookies, student.id, parent.id, {
      ...versions,
      children: splitChildrenFor(parent),
      reason: '先拆再暂停',
      previewDigest: preview.body.previewDigest,
    });
    expect(confirmed.status).toBe(200);
    const paused = await patchPlan(auth.cookies, student.id, planId, {
      action: 'PAUSE',
      expectedVersion: imported.imported.body.version,
    });
    expect(paused.status).toBe(200);
    const afterPause = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: parent.id } });
    expect(afterPause.cancelReason).toBe('SPLIT');
    const resumed = await patchPlan(auth.cookies, student.id, planId, {
      action: 'RESUME',
      expectedVersion: paused.body.version,
    });
    expect(resumed.status).toBe(200);
    const afterResume = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: parent.id } });
    expect(afterResume.status).toBe('CANCELLED');
    expect(afterResume.cancelReason).toBe('SPLIT');
    const sibling = await prisma.taskOccurrence.findFirstOrThrow({
      where: { seriesId: parent.seriesId, status: 'PLANNED' },
      include: { series: true },
    });
    const schedulePreview = await postFuturePreview(auth.cookies, student.id, sibling.id, {
      expectedStudentVersion: studentRow.version,
      expectedPlanVersion: resumed.body.version,
      expectedSeriesVersion: sibling.series.version,
      expectedOccurrenceVersion: sibling.version,
      proposal: {
        kind: 'SCHEDULE',
        repeatKind: 'DAILY',
        weekdays: null,
        endLocalDate: null,
        ongoing: true,
        reason: '不复活拆分父',
      },
    });
    if (schedulePreview.status === 200) {
      const scheduleConfirm = await postFutureConfirm(auth.cookies, student.id, sibling.id, {
        expectedStudentVersion: studentRow.version,
        expectedPlanVersion: resumed.body.version,
        expectedSeriesVersion: sibling.series.version,
        expectedOccurrenceVersion: sibling.version,
        proposal: {
          kind: 'SCHEDULE',
          repeatKind: 'DAILY',
          weekdays: null,
          endLocalDate: null,
          ongoing: true,
          reason: '不复活拆分父',
        },
        previewDigest: schedulePreview.body.previewDigest,
      });
      expect([200, 409]).toContain(scheduleConfirm.status);
    }
    expect((await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: parent.id } })).cancelReason).toBe('SPLIT');
  });
});
