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

describe.skipIf(shouldSkipStp004Isolation())('STP 006 CON-3 plan write vs withdraw', () => {
  let app: INestApplication;
  let inbox: TestAuthDelivery;
  const prisma = new PrismaClient({ datasourceUrl: connectionString });
  let phoneSeq = 0;

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

  function writeHeaders(cookies: CookieJar, key = randomUUID()) {
    return {
      Origin: ORIGIN,
      Cookie: cookies.header(),
      'X-CSRF-Token': cookies.get('stp_csrf') ?? '',
      'Idempotency-Key': key,
    };
  }

  async function signIn() {
    const cookies = new CookieJar();
    const installationId = randomUUID();
    const phone = `13800138${String(200 + (phoneSeq++ % 80)).padStart(3, '0')}`;
    const codeRes = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .send({ purpose: 'SIGN_IN', identity: { kind: 'PHONE', value: phone }, device: { installationId } });
    const delivered = inbox.read(`+86${phone}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    const sessionRes = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: codeRes.body.challengeId,
        code: delivered,
        device: { installationId, label: 'stp006-lock' },
      });
    cookies.apply(sessionRes);
    return { cookies };
  }

  async function readyStudent(cookies: CookieJar, nickname: string) {
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
    const grades = await agent().get('/v1/grade-configs').set('Cookie', cookies.header());
    expect(grades.body.items?.length).toBeGreaterThan(0);
    const g1 = grades.body.items.find(
      (item: { schoolSystemCode: string; gradeCode: string; stageCode: string }) =>
        item.schoolSystemCode === 'SIX_THREE' && item.stageCode === 'PRIMARY' && item.gradeCode === 'G1',
    );
    const set = await agent()
      .patch(`/v1/students/${created.body.profile.id}`)
      .set(writeHeaders(cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: created.body.profile.version,
        gradeConfigId: g1.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SET',
      });
    const listed = await agent()
      .get(`/v1/templates?studentId=${created.body.profile.id}`)
      .set('Cookie', cookies.header());
    const preview = await agent()
      .post(`/v1/students/${created.body.profile.id}/templates/${listed.body.recommendedTemplateIds[0]}/preview`)
      .set(writeHeaders(cookies))
      .send({});
    expect(preview.status).toBe(200);
    expect(preview.body.previewDigest).toBeTruthy();
    const pairing = await agent()
      .post(`/v1/students/${created.body.profile.id}/pairings`)
      .set(writeHeaders(cookies))
      .send({});
    const consents = await agent()
      .get(`/v1/students/${created.body.profile.id}/consents`)
      .set('Cookie', cookies.header());
    return {
      studentId: created.body.profile.id as string,
      version: set.body.version as number,
      templateId: listed.body.recommendedTemplateIds[0] as string,
      preview: preview.body,
      pairingId: pairing.body.pairingId as string,
      consentId: consents.body.items.find((item: { current: boolean }) => item.current).id as string,
    };
  }

  it('T11-3 / CON-3 write-first: import linearizes before withdraw; late import fails', async () => {
    const { cookies } = await signIn();
    const ready = await readyStudent(cookies, '计划写入先');
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [ready.pairingId]);
    const holderPid = await backendPid(holder);
    const importPromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/templates/${ready.templateId}/import`)
        .set(writeHeaders(cookies))
        .send({
          expectedStudentVersion: ready.version,
          previewDigest: ready.preview.previewDigest,
          templateVersion: ready.preview.template.version,
          tasks: ready.preview.tasks,
          coCreationAttested: true,
        }),
    );
    const writer = await waitForWaiterOnHolder(observer, holderPid, 'CON-3 import waits on pairing');
    const blocked = await observer.query<{ pids: number[] }>('SELECT pg_blocking_pids($1::int) AS pids', [
      writer.waiter_pid,
    ]);
    expect(blocked.rows[0]?.pids ?? []).toContain(holderPid);
    const withdrawPromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/consents/${ready.consentId}/withdraw`)
        .set(writeHeaders(cookies))
        .send({ reasonCode: 'GUARDIAN_REQUEST' }),
    );
    const overlap = await waitForWaiterOnHolder(observer, writer.waiter_pid, 'CON-3 withdraw waits on import');
    expect(overlap.holder_pid).toBe(writer.waiter_pid);
    await holder.query('ROLLBACK');
    const imported = await importPromise;
    expect(imported.body).toMatchObject({ origin: 'GUARDIAN_ASSISTED' });
    expect(imported.status).toBe(201);
    const withdrawn = await withdrawPromise;
    expect(withdrawn.status).toBeLessThan(300);
    expect(withdrawn.body.status).toBe('RESTRICTED');
    const late = await agent()
      .post(`/v1/students/${ready.studentId}/templates/${ready.templateId}/import`)
      .set(writeHeaders(cookies))
      .send({
        expectedStudentVersion: ready.version,
        previewDigest: ready.preview.previewDigest,
        templateVersion: ready.preview.template.version,
        tasks: ready.preview.tasks,
        coCreationAttested: true,
      });
    expect(late.status).toBeGreaterThanOrEqual(400);
    await holder.end();
    await observer.end();
  });

  it('T11-3 / CON-3 revoke-first: overlapping import cannot commit after withdraw', async () => {
    const { cookies } = await signIn();
    const ready = await readyStudent(cookies, '撤回先计划');
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [ready.pairingId]);
    const holderPid = await backendPid(holder);
    const withdrawPromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/consents/${ready.consentId}/withdraw`)
        .set(writeHeaders(cookies))
        .send({ reasonCode: 'GUARDIAN_REQUEST' }),
    );
    const revoker = await waitForWaiterOnHolder(observer, holderPid, 'CON-3 withdraw waits on pairing');
    const importPromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/templates/${ready.templateId}/import`)
        .set(writeHeaders(cookies))
        .send({
          expectedStudentVersion: ready.version,
          previewDigest: ready.preview.previewDigest,
          templateVersion: ready.preview.template.version,
          tasks: ready.preview.tasks,
          coCreationAttested: true,
        }),
    );
    const overlap = await waitForWaiterOnHolder(observer, revoker.waiter_pid, 'CON-3 import waits on withdraw');
    expect(overlap.holder_pid).toBe(revoker.waiter_pid);
    await holder.query('ROLLBACK');
    const withdrawn = await withdrawPromise;
    expect(withdrawn.body.status).toBe('RESTRICTED');
    const imported = await importPromise;
    expect(imported.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.studyPlan.count({ where: { studentProfileId: ready.studentId } })).toBe(0);
    await holder.end();
    await observer.end();
  });

  it('T11-3 / CON-3 revoke-first: overlapping manual create cannot commit after withdraw', async () => {
    const { cookies } = await signIn();
    const ready = await readyStudent(cookies, '撤回先手动');
    const preview = await agent()
      .post(`/v1/students/${ready.studentId}/plans/preview`)
      .set(writeHeaders(cookies))
      .send({
        tasks: [{ name: '自主阅读', subject: '自定义', standard: '读完', repeatKind: 'DAILY' }],
      });
    expect(preview.status).toBe(200);
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [ready.pairingId]);
    const holderPid = await backendPid(holder);
    const withdrawPromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/consents/${ready.consentId}/withdraw`)
        .set(writeHeaders(cookies))
        .send({ reasonCode: 'GUARDIAN_REQUEST' }),
    );
    const revoker = await waitForWaiterOnHolder(observer, holderPid, 'CON-3 manual withdraw waits on pairing');
    const createPromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/plans`)
        .set(writeHeaders(cookies))
        .send({
          expectedStudentVersion: ready.version,
          previewDigest: preview.body.previewDigest,
          tasks: preview.body.tasks,
          coCreationAttested: true,
        }),
    );
    const overlap = await waitForWaiterOnHolder(observer, revoker.waiter_pid, 'CON-3 manual create waits on withdraw');
    expect(overlap.holder_pid).toBe(revoker.waiter_pid);
    await holder.query('ROLLBACK');
    const withdrawn = await withdrawPromise;
    expect(withdrawn.body.status).toBe('RESTRICTED');
    const created = await createPromise;
    expect(created.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.studyPlan.count({ where: { studentProfileId: ready.studentId } })).toBe(0);
    await holder.end();
    await observer.end();
  });
});
