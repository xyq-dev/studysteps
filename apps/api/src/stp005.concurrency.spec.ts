import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
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
import { backendPid, waitForWaiterOnHolder } from './test/lock-barrier';

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

describe.skipIf(shouldSkipStp004Isolation())('STP 005 lock-order and in-lock reauth', () => {
  let app: INestApplication;
  let inbox: TestAuthDelivery;
  let publisher: PolicyPublishService;
  let runtime: RuntimeConfig;
  const prisma = new PrismaClient({ datasourceUrl: connectionString });

  beforeAll(async () => {
    loadStp004Env();
    assertStp004IntegrationReady();
    await prisma.$connect();
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

  function dispatch(test: request.Test): Promise<request.Response> {
    return new Promise((resolve, reject) => {
      test.end((error, response) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(response);
      });
    });
  }

  async function observerClient() {
    const client = new pg.Client({ connectionString });
    await client.connect();
    return client;
  }

  async function signIn() {
    const cookies = new CookieJar();
    const installationId = randomUUID();
    const phone = `13800138${String(200 + Math.floor(Math.random() * 80)).padStart(3, '0')}`;
    const codeRes = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .send({
        purpose: 'SIGN_IN',
        identity: { kind: 'PHONE', value: phone },
        device: { installationId },
      });
    const delivered = inbox.read(`+86${phone}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    const sessionRes = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: codeRes.body.challengeId,
        code: delivered,
        device: { installationId, label: 'lock' },
      });
    cookies.apply(sessionRes);
    return { cookies, phone, installationId };
  }

  async function createStudent(cookies: CookieJar, nickname: string) {
    const docs = await agent().get('/v1/consent-documents?ageBand=UNDER_14').set('Cookie', cookies.header());
    const created = await agent()
      .post('/v1/students')
      .set('Origin', ORIGIN)
      .set('Cookie', cookies.header())
      .set('X-CSRF-Token', cookies.get('stp_csrf') ?? '')
      .set('Idempotency-Key', randomUUID())
      .send({
        profile: { nickname, avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
        ageConfirmation: { band: 'UNDER_14', source: 'GUARDIAN_DECLARATION' },
        consentAcceptances: [{ policyKey: docs.body.policyKey, version: docs.body.version }],
      });
    expect(created.status).toBe(201);
    return created.body.profile as { id: string; version: number };
  }

  function writeHeaders(cookies: CookieJar) {
    return {
      Origin: ORIGIN,
      Cookie: cookies.header(),
      'X-CSRF-Token': cookies.get('stp_csrf') ?? '',
      'Idempotency-Key': randomUUID(),
    };
  }

  it('T02-D-STEP rechecks step-up inside the lock after wait expiry', async () => {
    const { cookies } = await signIn();
    const student = await createStudent(cookies, '锁内二次验证');
    const grade = await prisma.gradeConfig.findFirstOrThrow({
      where: { schoolSystemCode: 'SIX_THREE', stageCode: 'PRIMARY', gradeCode: 'G1' },
    });
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM student_profiles WHERE id = $1 FOR UPDATE', [student.id]);
    const holderPid = await backendPid(holder);
    const previous = runtime.value.timing.stepUpMs;
    const pending = dispatch(
      agent()
        .patch(`/v1/students/${student.id}`)
        .set(writeHeaders(cookies))
        .send({
          kind: 'EDUCATION',
          expectedVersion: student.version,
          gradeConfigId: grade.id,
          termCode: 'FULL_YEAR',
          changeKind: 'SET',
        }),
    );
    const waiter = await waitForWaiterOnHolder(observer, holderPid, 'STEP education waits on student');
    const blocked = await observer.query<{ pids: number[] }>('SELECT pg_blocking_pids($1::int) AS pids', [
      waiter.waiter_pid,
    ]);
    expect(blocked.rows[0]?.pids ?? []).toContain(holderPid);
    runtime.value.timing.stepUpMs = 1;
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await holder.query('COMMIT');
      const denied = await pending;
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('STEP_UP_REQUIRED');
    } finally {
      runtime.value.timing.stepUpMs = previous;
      await holder.end();
      await observer.end();
    }
  });

  it('T02-D-LOCK education waits on Policy after Student; publish does not reverse-lock Student', async () => {
    const { cookies } = await signIn();
    const student = await createStudent(cookies, '锁序');
    const grade = await prisma.gradeConfig.findFirstOrThrow({
      where: { schoolSystemCode: 'SIX_THREE', stageCode: 'PRIMARY', gradeCode: 'G2' },
    });
    const policy = await prisma.consentPolicy.findUniqueOrThrow({
      where: { policyKey_locale: { policyKey: 'TEST_CHILD_CORE_SERVICE', locale: 'zh-CN' } },
    });

    const policyHolder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await policyHolder.connect();
    await policyHolder.query('BEGIN');
    await policyHolder.query('SELECT id FROM consent_policies WHERE id = $1 FOR UPDATE', [policy.id]);
    const policyPid = await backendPid(policyHolder);
    const waitingPatch = dispatch(
      agent()
        .patch(`/v1/students/${student.id}`)
        .set(writeHeaders(cookies))
        .send({
          kind: 'EDUCATION',
          expectedVersion: student.version,
          gradeConfigId: grade.id,
          termCode: 'FULL_YEAR',
          changeKind: 'SET',
        }),
    );
    const waiter = await waitForWaiterOnHolder(observer, policyPid, 'LOCK education waits on policy');
    const blocked = await observer.query<{ pids: number[] }>('SELECT pg_blocking_pids($1::int) AS pids', [
      waiter.waiter_pid,
    ]);
    expect(blocked.rows[0]?.pids ?? []).toContain(policyPid);
    await policyHolder.query('COMMIT');
    const education = await waitingPatch;
    expect(education.status).toBeLessThan(300);
    await policyHolder.end();

    const studentHolder = new pg.Client({ connectionString });
    await studentHolder.connect();
    await studentHolder.query('BEGIN');
    await studentHolder.query('SELECT id FROM student_profiles WHERE id = $1 FOR UPDATE', [student.id]);
    const studentPid = await backendPid(studentHolder);
    const started = Date.now();
    const published = publisher.publishNext(
      'TEST_CHILD_CORE_SERVICE',
      `stp005-lock-${randomUUID().slice(0, 8)}`,
      'lock-order reverse probe',
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const reverseWait = await observer.query(
      `SELECT waiter.pid
         FROM pg_stat_activity waiter
         JOIN LATERAL unnest(pg_blocking_pids(waiter.pid)) AS blocker(pid) ON true
        WHERE blocker.pid = $1`,
      [studentPid],
    );
    expect(reverseWait.rows).toHaveLength(0);
    const result = await published;
    expect(result.documentId).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(2000);
    await studentHolder.query('ROLLBACK');
    await studentHolder.end();
    await observer.end();
  });
});
