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
import { PolicyPublishService } from './students/policy-publish.service';
import { RuntimeConfig } from './common/runtime-config';
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

describe.skipIf(shouldSkipStp004Isolation())('STP 005 T02-D catalog and education writes', () => {
  let app: INestApplication;
  let inbox: TestAuthDelivery;
  let runtime: RuntimeConfig;
  let publisher: PolicyPublishService;
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
    if (dbName === 'stp004_identity' || dbName === 'stp004_identity_fresh' || dbName === 'stp005_four_to_six') {
      throw new Error(`refusing to run STP 005 HTTP tests against ${dbName}`);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new HttpErrorFilter());
    await app.init();
    inbox = app.get(TestAuthDelivery);
    runtime = app.get(RuntimeConfig);
    publisher = app.get(PolicyPublishService);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  function agent() {
    return request(app.getHttpServer());
  }

  function writeHeaders(cookies: CookieJar, key = randomUUID()) {
    return {
      Origin: ORIGIN,
      Cookie: cookies.header(),
      'X-CSRF-Token': cookies.get('stp_csrf') ?? '',
      'Idempotency-Key': key,
    };
  }

  async function signIn() {
    const phone = nextPhone();
    const cookies = new CookieJar();
    const installationId = randomUUID();
    const codeRes = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .send({
        purpose: 'SIGN_IN',
        identity: { kind: 'PHONE', value: phone },
        device: { installationId },
      });
    expect(codeRes.status).toBeLessThan(300);
    const delivered = inbox.read(`+86${phone.replace(/^\+86/, '')}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    const sessionRes = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: codeRes.body.challengeId,
        code: delivered,
        device: { installationId, label: 'stp005' },
      });
    cookies.apply(sessionRes);
    return { cookies, phone, installationId };
  }

  async function createStudent(cookies: CookieJar, nickname = '目录孩子') {
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

  async function grades(cookies: CookieJar) {
    const res = await agent().get('/v1/grade-configs').set('Cookie', cookies.header());
    expect(res.status).toBe(200);
    return res.body.items as Array<{
      id: string;
      schoolSystemCode: string;
      stageCode: string;
      gradeCode: string;
      gradeLabel: string;
      catalogEntryKey: string | null;
      nextGradeConfigId: string | null;
    }>;
  }

  function findGrade(
    items: Awaited<ReturnType<typeof grades>>,
    system: string,
    stage: string,
    code: string,
  ) {
    return items.find(
      (item) => item.schoolSystemCode === system && item.stageCode === stage && item.gradeCode === code,
    );
  }

  it('T02-D-63 / T02-D-54 catalog mapping and 初四 independence', async () => {
    const auth = await signIn();
    const items = await grades(auth.cookies);
    expect(findGrade(items, 'SIX_THREE', 'JUNIOR', 'G4')).toBeUndefined();
    expect(findGrade(items, 'SIX_THREE', 'PRIMARY', 'G6')).toBeTruthy();
    expect(findGrade(items, 'FIVE_FOUR', 'PRIMARY', 'G6')).toBeUndefined();
    const juniorFour = findGrade(items, 'FIVE_FOUR', 'JUNIOR', 'G4');
    expect(juniorFour?.catalogEntryKey).toBe('JUNIOR_G4');
    const student = await createStudent(auth.cookies);
    const sixThree = findGrade(items, 'SIX_THREE', 'PRIMARY', 'G3');
    const set = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: sixThree?.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SET',
      });
    expect(set.status).toBeLessThan(300);
    expect(set.body.education.gradeLabel).toBe('三年级');
    expect(set.body.status).toBe('ACTIVE');
    expect(set.body.learningAccess.allowed).toBe(true);
  });

  it('T02-D-X custom browse without mapping cannot import', async () => {
    const auth = await signIn();
    const items = await grades(auth.cookies);
    const custom = findGrade(items, 'CUSTOM', 'JUNIOR', 'EXPERIMENTAL');
    const student = await createStudent(auth.cookies, '自定义孩子');
    const set = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: custom?.id,
        termCode: 'FIRST_TERM',
        changeKind: 'SET',
      });
    expect(set.body.education.catalogEntryKey).toBeNull();
    const listed = await agent()
      .get(`/v1/templates?studentId=${student.id}`)
      .set('Cookie', auth.cookies.header());
    expect(listed.body.items).toHaveLength(39);
    expect(listed.body.recommendedTemplateIds).toEqual([]);
    expect(listed.body.importAllowed).toBe(false);
    const denied = await agent()
      .post(`/v1/students/${student.id}/templates/${listed.body.items[0].id}/import`)
      .set(writeHeaders(auth.cookies))
      .send({});
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe('TEMPLATE_IMPORT_NOT_ALLOWED');
  });

  it('T02-D-REJ / T02-D-SET / T02-D-PROMOTE / T02-D-TERM / T02-D-REP / T02-D-IDEM', async () => {
    const auth = await signIn();
    const items = await grades(auth.cookies);
    const g3 = findGrade(items, 'SIX_THREE', 'PRIMARY', 'G3');
    const g4 = findGrade(items, 'SIX_THREE', 'PRIMARY', 'G4');
    const g6 = findGrade(items, 'SIX_THREE', 'PRIMARY', 'G6');
    const student = await createStudent(auth.cookies);
    const rejected = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: randomUUID(),
        termCode: 'FULL_YEAR',
        changeKind: 'SET',
      });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('GRADE_CONFIG_INVALID');
    const unchanged = await agent().get(`/v1/students/${student.id}`).set('Cookie', auth.cookies.header());
    expect(unchanged.body.version).toBe(student.version);

    const idem = randomUUID();
    const set = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies, idem))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: g3?.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SET',
      });
    expect(set.body.status).toBe('ACTIVE');
    const replay = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies, idem))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: g3?.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SET',
      });
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.version).toBe(set.body.version);
    const conflictBody = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies, idem))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: g4?.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SET',
      });
    expect(conflictBody.status).toBe(409);

    const promoteWrong = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: set.body.version,
        gradeConfigId: g6?.id,
        termCode: 'FULL_YEAR',
        changeKind: 'PROMOTE',
      });
    expect(promoteWrong.status).toBe(400);
    const promote = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: set.body.version,
        gradeConfigId: g4?.id,
        termCode: 'FULL_YEAR',
        changeKind: 'PROMOTE',
      });
    expect(promote.body.education.gradeCode).toBe('G4');
    const term = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: promote.body.version,
        gradeConfigId: g4?.id,
        termCode: 'SECOND_TERM',
        changeKind: 'TERM_SWITCH',
      });
    expect(term.body.education.termCode).toBe('SECOND_TERM');
    expect(term.body.education.gradeConfigId).toBe(g4?.id);
    const repeat = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: term.body.version,
        gradeConfigId: g4?.id,
        termCode: 'SECOND_TERM',
        changeKind: 'REPEAT',
      });
    expect(repeat.body.education.gradeCode).toBe('G4');
    const history = await agent()
      .get(`/v1/students/${student.id}/education-changes`)
      .set('Cookie', auth.cookies.header());
    expect(history.body.items.map((item: { changeKind: string }) => item.changeKind)).toEqual([
      'REPEAT',
      'TERM_SWITCH',
      'PROMOTE',
      'SET',
    ]);
  });

  it('T02-D-STEP rejects education write without a live step-up window', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies);
    const items = await grades(auth.cookies);
    const g3 = findGrade(items, 'SIX_THREE', 'PRIMARY', 'G1');
    const previous = runtime.value.timing.stepUpMs;
    runtime.value.timing.stepUpMs = 1;
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const denied = await agent()
        .patch(`/v1/students/${student.id}`)
        .set(writeHeaders(auth.cookies))
        .send({
          kind: 'EDUCATION',
          expectedVersion: student.version,
          gradeConfigId: g3?.id,
          termCode: 'FULL_YEAR',
          changeKind: 'SET',
        });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('STEP_UP_REQUIRED');
    } finally {
      runtime.value.timing.stepUpMs = previous;
    }
  });

  it('T02-D-AUTH hides other archives with the same 404 shape', async () => {
    const first = await signIn();
    const second = await signIn();
    const student = await createStudent(first.cookies);
    const hidden = await agent().get(`/v1/students/${student.id}/education-changes`).set('Cookie', second.cookies.header());
    const missing = await agent()
      .get(`/v1/students/${randomUUID()}/education-changes`)
      .set('Cookie', second.cookies.header());
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.body.code).toBe(missing.body.code);
  });

  it('AGE_18_PLUS cannot become ACTIVE through fail-closed activation', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '成年拒绝');
    await prisma.studentProfile.update({
      where: { id: student.id },
      data: { ageBand: 'AGE_18_PLUS', status: 'ACTIVE' },
    });
    const detail = await agent().get(`/v1/students/${student.id}`).set('Cookie', auth.cookies.header());
    expect(detail.status).toBe(422);
    expect(detail.body.code).toBe('AGE_BAND_NOT_SUPPORTED');
    expect(detail.body.status).not.toBe('ACTIVE');
    expect(detail.body.learningAccess?.allowed).not.toBe(true);
    const listed = await agent().get('/v1/students').set('Cookie', auth.cookies.header());
    expect(listed.status).toBe(422);
    expect(listed.body.code).toBe('AGE_BAND_NOT_SUPPORTED');
  });

  it('T02-D leftover snapshots cannot be created after migration; proven leftover is upgrade-only', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '旧快照');
    await expect(
      prisma.studentProfile.update({
        where: { id: student.id },
        data: {
          stageCode: 'primary',
          schoolSystemCode: 'liusan',
          gradeCode: 'g3',
          gradeLabel: '三年级',
          termCode: '2026-1',
        },
      }),
    ).rejects.toThrow();
    const loaded = await agent().get(`/v1/students/${student.id}`).set('Cookie', auth.cookies.header());
    expect(loaded.body.education.gradeCode).toBeNull();
    expect(loaded.body.learningAccess.reason).toBe('ACADEMIC_CONFIGURATION_PENDING');
    expect(loaded.body.status).not.toBe('ACTIVE');
    expect(loaded.body.learningAccess.allowed).not.toBe(true);
    await expect(
      prisma.studentProfile.create({
        data: {
          nickname: '新建遗留',
          avatarPresetId: 'avatar-03',
          ageBand: 'UNDER_14',
          ageConfirmationSource: 'GUARDIAN_DECLARATION',
          ageConfirmedAt: new Date(),
          ageConfirmedByAccountId: (await prisma.account.create({ data: {} })).id,
          createdByAccountId: (await prisma.account.create({ data: {} })).id,
          stageCode: 'primary',
          schoolSystemCode: 'liusan',
          gradeCode: 'g3',
          gradeLabel: '三年级',
          termCode: '2026-1',
        },
      }),
    ).rejects.toThrow();
  });

  it('T02-D-REJ empty RESUME/LEAVE, reverse SKIP, REPEAT term, and year-end no-op', async () => {
    const auth = await signIn();
    const items = await grades(auth.cookies);
    const g1 = findGrade(items, 'SIX_THREE', 'PRIMARY', 'G1');
    const g3 = findGrade(items, 'SIX_THREE', 'PRIMARY', 'G3');
    const g4 = findGrade(items, 'SIX_THREE', 'PRIMARY', 'G4');
    const fiveFour = findGrade(items, 'FIVE_FOUR', 'PRIMARY', 'G3');
    const student = await createStudent(auth.cookies, '转换表');
    const emptyLeave = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({ kind: 'EDUCATION', expectedVersion: student.version, changeKind: 'LEAVE' });
    expect(emptyLeave.status).toBe(400);
    const emptyResume = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: g1?.id,
        termCode: 'FULL_YEAR',
        changeKind: 'RESUME',
      });
    expect(emptyResume.status).toBe(400);
    const set = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: g3?.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SET',
      });
    expect(set.status).toBeLessThan(300);
    const skipReverse = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: set.body.version,
        gradeConfigId: g1?.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SKIP',
      });
    expect(skipReverse.status).toBe(400);
    const skipNext = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: set.body.version,
        gradeConfigId: g4?.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SKIP',
      });
    expect(skipNext.status).toBe(400);
    const skipSystem = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: set.body.version,
        gradeConfigId: fiveFour?.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SKIP',
      });
    expect(skipSystem.status).toBe(400);
    const repeatTerm = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: set.body.version,
        gradeConfigId: g3?.id,
        termCode: 'SECOND_TERM',
        changeKind: 'REPEAT',
      });
    expect(repeatTerm.status).toBe(400);
    const firstGet = await agent().get(`/v1/students/${student.id}`).set('Cookie', auth.cookies.header());
    const secondGet = await agent().get(`/v1/students/${student.id}`).set('Cookie', auth.cookies.header());
    expect(firstGet.body.education.gradeCode).toBe('G3');
    expect(secondGet.body.education.gradeCode).toBe('G3');
    expect(secondGet.body.version).toBe(firstGet.body.version);
    expect(secondGet.body.education.gradeConfigId).toBe(g3?.id);
  });

  it('SET then policy upgrade fail-closes GET and list to CONSENT_REQUIRED', async () => {
    const auth = await signIn();
    const items = await grades(auth.cookies);
    const g1 = findGrade(items, 'SIX_THREE', 'PRIMARY', 'G1');
    const student = await createStudent(auth.cookies, '政策后读');
    const set = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: g1?.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SET',
      });
    expect(set.body.status).toBe('ACTIVE');
    expect(set.body.learningAccess.allowed).toBe(true);
    const listedActive = await agent().get('/v1/students').set('Cookie', auth.cookies.header());
    expect(listedActive.body.items.find((item: { id: string }) => item.id === student.id).status).toBe('ACTIVE');
    await publisher.publishNext(
      'TEST_CHILD_CORE_SERVICE',
      `stp005-up-${randomUUID().slice(0, 8)}`,
      'stp005 policy upgrade after SET',
    );
    const detail = await agent().get(`/v1/students/${student.id}`).set('Cookie', auth.cookies.header());
    expect(detail.body.status).toBe('ONBOARDING');
    expect(detail.body.learningAccess).toEqual({ allowed: false, reason: 'CONSENT_REQUIRED' });
    const listed = await agent().get('/v1/students').set('Cookie', auth.cookies.header());
    expect(listed.body.items.find((item: { id: string }) => item.id === student.id).status).toBe('ONBOARDING');
  });

  it('T02-D-CON concurrent education patches yield one success and one 409', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies);
    const items = await grades(auth.cookies);
    const g1 = findGrade(items, 'SIX_THREE', 'PRIMARY', 'G1');
    const g2 = findGrade(items, 'SIX_THREE', 'PRIMARY', 'G2');
    const [left, right] = await Promise.all([
      agent()
        .patch(`/v1/students/${student.id}`)
        .set(writeHeaders(auth.cookies))
        .send({
          kind: 'EDUCATION',
          expectedVersion: student.version,
          gradeConfigId: g1?.id,
          termCode: 'FULL_YEAR',
          changeKind: 'SET',
        }),
      agent()
        .patch(`/v1/students/${student.id}`)
        .set(writeHeaders(auth.cookies))
        .send({
          kind: 'EDUCATION',
          expectedVersion: student.version,
          gradeConfigId: g2?.id,
          termCode: 'FULL_YEAR',
          changeKind: 'SET',
        }),
    ]);
    const statuses = [left.status, right.status].sort();
    expect(statuses[0]).toBeLessThan(300);
    expect(statuses[1]).toBe(409);
    const history = await prisma.studentEducationHistory.count({ where: { studentProfileId: student.id } });
    expect(history).toBe(1);
  });

  it('mapped template import is deferred rather than creating a plan', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies);
    const items = await grades(auth.cookies);
    const g1 = findGrade(items, 'SIX_THREE', 'PRIMARY', 'G1');
    const set = await agent()
      .patch(`/v1/students/${student.id}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: student.version,
        gradeConfigId: g1?.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SET',
      });
    const listed = await agent()
      .get(`/v1/templates?studentId=${student.id}`)
      .set('Cookie', auth.cookies.header());
    expect(listed.body.importAllowed).toBe(true);
    expect(listed.body.recommendedTemplateIds).toHaveLength(3);
    const deferred = await agent()
      .post(`/v1/students/${student.id}/templates/${listed.body.recommendedTemplateIds[0]}/import`)
      .set(writeHeaders(auth.cookies))
      .send({});
    expect(deferred.status).toBe(400);
    expect(deferred.body.code).toBe('VALIDATION_ERROR');
    expect(set.body.education.catalogEntryKey).toBe('PRIMARY_G1');
  });
});
