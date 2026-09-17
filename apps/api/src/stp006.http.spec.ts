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
    const horizon = await agent()
      .post(`/v1/students/${student.id}/task-horizon`)
      .set(writeHeaders(auth.cookies))
      .send({});
    expect(horizon.status).toBe(409);
    expect(horizon.body.code).toBe('TASK_HORIZON_NOT_AVAILABLE');
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
});
