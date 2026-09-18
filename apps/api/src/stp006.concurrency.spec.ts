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
import { isoWeekdayFromLocalDate } from '@studysteps/domain';
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

  async function importReadyPlan(cookies: CookieJar, ready: Awaited<ReturnType<typeof readyStudent>>) {
    const imported = await agent()
      .post(`/v1/students/${ready.studentId}/templates/${ready.templateId}/import`)
      .set(writeHeaders(cookies))
      .send({
        expectedStudentVersion: ready.version,
        previewDigest: ready.preview.previewDigest,
        templateVersion: ready.preview.template.version,
        tasks: ready.preview.tasks,
        coCreationAttested: true,
      });
    expect(imported.status).toBe(201);
    return imported.body as { id: string; version: number };
  }

  it('T07 two status patches serialize on the plan row; loser gets VERSION_CONFLICT', async () => {
    const { cookies } = await signIn();
    const ready = await readyStudent(cookies, '双状态竞争');
    const plan = await importReadyPlan(cookies, ready);
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM study_plans WHERE id = $1 FOR UPDATE', [plan.id]);
    const holderPid = await backendPid(holder);
    const pausePromise = dispatch(
      agent()
        .patch(`/v1/students/${ready.studentId}/plans/${plan.id}`)
        .set(writeHeaders(cookies))
        .send({ action: 'PAUSE', expectedVersion: plan.version }),
    );
    const pauseWaiter = await waitForWaiterOnHolder(observer, holderPid, 'T07 pause waits on plan');
    const blockedPause = await observer.query<{ pids: number[] }>('SELECT pg_blocking_pids($1::int) AS pids', [
      pauseWaiter.waiter_pid,
    ]);
    expect(blockedPause.rows[0]?.pids ?? []).toContain(holderPid);
    const archivePromise = dispatch(
      agent()
        .patch(`/v1/students/${ready.studentId}/plans/${plan.id}`)
        .set(writeHeaders(cookies))
        .send({ action: 'ARCHIVE', expectedVersion: plan.version }),
    );
    const archiveWaiter = await waitForWaiterOnHolder(observer, pauseWaiter.waiter_pid, 'T07 archive waits on pause');
    expect(archiveWaiter.holder_pid).toBe(pauseWaiter.waiter_pid);
    await holder.query('ROLLBACK');
    const paused = await pausePromise;
    const archived = await archivePromise;
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('PAUSED');
    expect(archived.status).toBe(409);
    expect(archived.body.code).toBe('VERSION_CONFLICT');
    expect(await prisma.studyPlan.findUniqueOrThrow({ where: { id: plan.id } })).toMatchObject({ status: 'PAUSED' });
    expect(await prisma.planAdjustment.count({ where: { planId: plan.id } })).toBe(1);
    await holder.end();
    await observer.end();
  });

  it('T11-3 / CON-3 write-first: pause linearizes before withdraw; late pause fails', async () => {
    const { cookies } = await signIn();
    const ready = await readyStudent(cookies, '暂停先撤回');
    const plan = await importReadyPlan(cookies, ready);
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [ready.pairingId]);
    const holderPid = await backendPid(holder);
    const pausePromise = dispatch(
      agent()
        .patch(`/v1/students/${ready.studentId}/plans/${plan.id}`)
        .set(writeHeaders(cookies))
        .send({ action: 'PAUSE', expectedVersion: plan.version }),
    );
    const writer = await waitForWaiterOnHolder(observer, holderPid, 'CON-3 pause waits on pairing');
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
    const overlap = await waitForWaiterOnHolder(observer, writer.waiter_pid, 'CON-3 withdraw waits on pause');
    expect(overlap.holder_pid).toBe(writer.waiter_pid);
    await holder.query('ROLLBACK');
    const paused = await pausePromise;
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('PAUSED');
    const withdrawn = await withdrawPromise;
    expect(withdrawn.status).toBeLessThan(300);
    expect(withdrawn.body.status).toBe('RESTRICTED');
    const late = await agent()
      .patch(`/v1/students/${ready.studentId}/plans/${plan.id}`)
      .set(writeHeaders(cookies))
      .send({ action: 'RESUME', expectedVersion: paused.body.version });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.studyPlan.findUniqueOrThrow({ where: { id: plan.id } })).toMatchObject({ status: 'PAUSED' });
    await holder.end();
    await observer.end();
  });

  async function deleteLatestOccurrence(planId: string) {
    const last = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId } },
      orderBy: { occurrenceKey: 'desc' },
    });
    await prisma.taskOccurrence.delete({ where: { id: last.id } });
    return last;
  }

  it('two overlapping horizon POSTs wait on the plan row and insert each key once', async () => {
    const { cookies } = await signIn();
    const ready = await readyStudent(cookies, '双补齐竞争');
    const plan = await importReadyPlan(cookies, ready);
    const deleted = await deleteLatestOccurrence(plan.id);
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM study_plans WHERE id = $1 FOR UPDATE', [plan.id]);
    const holderPid = await backendPid(holder);
    const firstPromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/task-horizon`)
        .set(writeHeaders(cookies))
        .send({}),
    );
    const firstWaiter = await waitForWaiterOnHolder(observer, holderPid, 'horizon A waits on plan');
    const blockedFirst = await observer.query<{ pids: number[] }>('SELECT pg_blocking_pids($1::int) AS pids', [
      firstWaiter.waiter_pid,
    ]);
    expect(blockedFirst.rows[0]?.pids ?? []).toContain(holderPid);
    const secondPromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/task-horizon`)
        .set(writeHeaders(cookies))
        .send({}),
    );
    const secondWaiter = await waitForWaiterOnHolder(observer, firstWaiter.waiter_pid, 'horizon B waits on A');
    expect(secondWaiter.holder_pid).toBe(firstWaiter.waiter_pid);
    await holder.query('ROLLBACK');
    const first = await firstPromise;
    const second = await secondPromise;
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.insertedCount + second.body.insertedCount).toBe(1);
    expect(
      await prisma.taskOccurrence.count({
        where: { series: { planId: plan.id }, occurrenceKey: deleted.occurrenceKey },
      }),
    ).toBe(1);
    const grouped = await prisma.taskOccurrence.groupBy({
      by: ['seriesId', 'occurrenceKey'],
      where: { series: { planId: plan.id } },
      _count: { _all: true },
    });
    expect(grouped.every((row) => row._count._all === 1)).toBe(true);
    await holder.end();
    await observer.end();
  });

  it('pause-first overlapping horizon does not generate; horizon-first then pause cancels the new row', async () => {
    const { cookies } = await signIn();
    const pauseFirstReady = await readyStudent(cookies, '暂停先补齐');
    const pauseFirstPlan = await importReadyPlan(cookies, pauseFirstReady);
    const pauseHolder = new pg.Client({ connectionString });
    const pauseObserver = await observerClient();
    await pauseHolder.connect();
    await pauseHolder.query('BEGIN');
    await pauseHolder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [pauseFirstReady.pairingId]);
    const pauseHolderPid = await backendPid(pauseHolder);
    const pausePromise = dispatch(
      agent()
        .patch(`/v1/students/${pauseFirstReady.studentId}/plans/${pauseFirstPlan.id}`)
        .set(writeHeaders(cookies))
        .send({ action: 'PAUSE', expectedVersion: pauseFirstPlan.version }),
    );
    const pauseWaiter = await waitForWaiterOnHolder(pauseObserver, pauseHolderPid, 'pause waits on pairing');
    const horizonAfterPausePromise = dispatch(
      agent()
        .post(`/v1/students/${pauseFirstReady.studentId}/task-horizon`)
        .set(writeHeaders(cookies))
        .send({}),
    );
    const horizonAfterPauseWaiter = await waitForWaiterOnHolder(
      pauseObserver,
      pauseWaiter.waiter_pid,
      'horizon waits on pause',
    );
    expect(horizonAfterPauseWaiter.holder_pid).toBe(pauseWaiter.waiter_pid);
    await pauseHolder.query('ROLLBACK');
    const paused = await pausePromise;
    const horizonAfterPause = await horizonAfterPausePromise;
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('PAUSED');
    expect(horizonAfterPause.status).toBe(200);
    expect(horizonAfterPause.body.insertedCount).toBe(0);
    expect(horizonAfterPause.body.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'PLAN_PAUSED', planId: pauseFirstPlan.id })]),
    );
    expect(await prisma.taskOccurrence.count({ where: { series: { planId: pauseFirstPlan.id }, status: 'PLANNED' } })).toBe(0);
    await pauseHolder.end();
    await pauseObserver.end();

    const horizonFirstReady = await readyStudent(cookies, '补齐先暂停');
    const horizonFirstPlan = await importReadyPlan(cookies, horizonFirstReady);
    const deleted = await deleteLatestOccurrence(horizonFirstPlan.id);
    const horizonHolder = new pg.Client({ connectionString });
    const horizonObserver = await observerClient();
    await horizonHolder.connect();
    await horizonHolder.query('BEGIN');
    await horizonHolder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [horizonFirstReady.pairingId]);
    const horizonHolderPid = await backendPid(horizonHolder);
    const horizonPromise = dispatch(
      agent()
        .post(`/v1/students/${horizonFirstReady.studentId}/task-horizon`)
        .set(writeHeaders(cookies))
        .send({}),
    );
    const horizonWaiter = await waitForWaiterOnHolder(horizonObserver, horizonHolderPid, 'horizon waits on pairing');
    const pauseAfterPromise = dispatch(
      agent()
        .patch(`/v1/students/${horizonFirstReady.studentId}/plans/${horizonFirstPlan.id}`)
        .set(writeHeaders(cookies))
        .send({ action: 'PAUSE', expectedVersion: horizonFirstPlan.version }),
    );
    const pauseAfterWaiter = await waitForWaiterOnHolder(
      horizonObserver,
      horizonWaiter.waiter_pid,
      'pause waits on horizon',
    );
    expect(pauseAfterWaiter.holder_pid).toBe(horizonWaiter.waiter_pid);
    await horizonHolder.query('ROLLBACK');
    const horizonFirst = await horizonPromise;
    const pausedAfter = await pauseAfterPromise;
    expect(horizonFirst.status).toBe(200);
    expect(horizonFirst.body.insertedCount).toBe(1);
    expect(pausedAfter.status).toBe(200);
    expect(pausedAfter.body.status).toBe('PAUSED');
    const newRow = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: horizonFirstPlan.id }, occurrenceKey: deleted.occurrenceKey },
    });
    expect(newRow.status).toBe('CANCELLED');
    expect(newRow.cancelReason).toBe('PLAN_PAUSED');
    await horizonHolder.end();
    await horizonObserver.end();
  });

  it('archive-first overlapping horizon does not generate; horizon-first then archive cancels the new row', async () => {
    const { cookies } = await signIn();
    const archiveFirstReady = await readyStudent(cookies, '归档先补齐');
    const archiveFirstPlan = await importReadyPlan(cookies, archiveFirstReady);
    const archiveHolder = new pg.Client({ connectionString });
    const archiveObserver = await observerClient();
    await archiveHolder.connect();
    await archiveHolder.query('BEGIN');
    await archiveHolder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [archiveFirstReady.pairingId]);
    const archiveHolderPid = await backendPid(archiveHolder);
    const archivePromise = dispatch(
      agent()
        .patch(`/v1/students/${archiveFirstReady.studentId}/plans/${archiveFirstPlan.id}`)
        .set(writeHeaders(cookies))
        .send({ action: 'ARCHIVE', expectedVersion: archiveFirstPlan.version }),
    );
    const archiveWaiter = await waitForWaiterOnHolder(archiveObserver, archiveHolderPid, 'archive waits on pairing');
    const horizonAfterArchivePromise = dispatch(
      agent()
        .post(`/v1/students/${archiveFirstReady.studentId}/task-horizon`)
        .set(writeHeaders(cookies))
        .send({}),
    );
    const horizonAfterArchiveWaiter = await waitForWaiterOnHolder(
      archiveObserver,
      archiveWaiter.waiter_pid,
      'horizon waits on archive',
    );
    expect(horizonAfterArchiveWaiter.holder_pid).toBe(archiveWaiter.waiter_pid);
    await archiveHolder.query('ROLLBACK');
    const archived = await archivePromise;
    const horizonAfterArchive = await horizonAfterArchivePromise;
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('ARCHIVED');
    expect(horizonAfterArchive.status).toBe(200);
    expect(horizonAfterArchive.body.insertedCount).toBe(0);
    expect(horizonAfterArchive.body.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'PLAN_ARCHIVED', planId: archiveFirstPlan.id })]),
    );
    await archiveHolder.end();
    await archiveObserver.end();

    const horizonFirstReady = await readyStudent(cookies, '补齐先归档');
    const horizonFirstPlan = await importReadyPlan(cookies, horizonFirstReady);
    const deleted = await deleteLatestOccurrence(horizonFirstPlan.id);
    const horizonHolder = new pg.Client({ connectionString });
    const horizonObserver = await observerClient();
    await horizonHolder.connect();
    await horizonHolder.query('BEGIN');
    await horizonHolder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [horizonFirstReady.pairingId]);
    const horizonHolderPid = await backendPid(horizonHolder);
    const horizonPromise = dispatch(
      agent()
        .post(`/v1/students/${horizonFirstReady.studentId}/task-horizon`)
        .set(writeHeaders(cookies))
        .send({}),
    );
    const horizonWaiter = await waitForWaiterOnHolder(horizonObserver, horizonHolderPid, 'horizon waits on pairing');
    const archiveAfterPromise = dispatch(
      agent()
        .patch(`/v1/students/${horizonFirstReady.studentId}/plans/${horizonFirstPlan.id}`)
        .set(writeHeaders(cookies))
        .send({ action: 'ARCHIVE', expectedVersion: horizonFirstPlan.version }),
    );
    const archiveAfterWaiter = await waitForWaiterOnHolder(
      horizonObserver,
      horizonWaiter.waiter_pid,
      'archive waits on horizon',
    );
    expect(archiveAfterWaiter.holder_pid).toBe(horizonWaiter.waiter_pid);
    await horizonHolder.query('ROLLBACK');
    const horizonFirst = await horizonPromise;
    const archivedAfter = await archiveAfterPromise;
    expect(horizonFirst.status).toBe(200);
    expect(horizonFirst.body.insertedCount).toBe(1);
    expect(archivedAfter.status).toBe(200);
    expect(archivedAfter.body.status).toBe('ARCHIVED');
    const newRow = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: horizonFirstPlan.id }, occurrenceKey: deleted.occurrenceKey },
    });
    expect(newRow.status).toBe('CANCELLED');
    expect(newRow.cancelReason).toBe('PLAN_ARCHIVED');
    await horizonHolder.end();
    await horizonObserver.end();
  });

  it('pause-first overlapping reschedule is rejected; reschedule-first then pause cancels the moved row', async () => {
    const { cookies } = await signIn();
    const pauseFirstReady = await readyStudent(cookies, '暂停先改期');
    const pauseFirstPlan = await importReadyPlan(cookies, pauseFirstReady);
    const pauseFirstRow = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: pauseFirstPlan.id }, status: 'PLANNED' },
      orderBy: { scheduledLocalDate: 'asc' },
    });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const farDate = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Shanghai',
    });
    const pauseHolder = new pg.Client({ connectionString });
    const pauseObserver = await observerClient();
    await pauseHolder.connect();
    await pauseHolder.query('BEGIN');
    await pauseHolder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [pauseFirstReady.pairingId]);
    const pauseHolderPid = await backendPid(pauseHolder);
    const pausePromise = dispatch(
      agent()
        .patch(`/v1/students/${pauseFirstReady.studentId}/plans/${pauseFirstPlan.id}`)
        .set(writeHeaders(cookies))
        .send({ action: 'PAUSE', expectedVersion: pauseFirstPlan.version }),
    );
    const pauseWaiter = await waitForWaiterOnHolder(pauseObserver, pauseHolderPid, 'pause waits on pairing');
    const rescheduleAfterPausePromise = dispatch(
      agent()
        .post(`/v1/students/${pauseFirstReady.studentId}/tasks/${pauseFirstRow.id}/reschedule`)
        .set(writeHeaders(cookies))
        .send({ scheduledLocalDate: farDate, reason: '暂停后改期', expectedVersion: pauseFirstRow.version }),
    );
    const rescheduleAfterPauseWaiter = await waitForWaiterOnHolder(
      pauseObserver,
      pauseWaiter.waiter_pid,
      'reschedule waits on pause',
    );
    expect(rescheduleAfterPauseWaiter.holder_pid).toBe(pauseWaiter.waiter_pid);
    await pauseHolder.query('ROLLBACK');
    const paused = await pausePromise;
    const rescheduleAfterPause = await rescheduleAfterPausePromise;
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('PAUSED');
    expect(rescheduleAfterPause.status).toBe(409);
    expect(['PLAN_STATUS_INVALID', 'TASK_NOT_ADJUSTABLE']).toContain(rescheduleAfterPause.body.code);
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: pauseFirstRow.id } })).toMatchObject({
      scheduledLocalDate: pauseFirstRow.scheduledLocalDate,
      status: 'CANCELLED',
      cancelReason: 'PLAN_PAUSED',
    });
    await pauseHolder.end();
    await pauseObserver.end();

    const rescheduleFirstReady = await readyStudent(cookies, '改期先暂停');
    const rescheduleFirstPlan = await importReadyPlan(cookies, rescheduleFirstReady);
    const moving = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: rescheduleFirstPlan.id }, status: 'PLANNED' },
      orderBy: { scheduledLocalDate: 'asc' },
    });
    const rescheduleHolder = new pg.Client({ connectionString });
    const rescheduleObserver = await observerClient();
    await rescheduleHolder.connect();
    await rescheduleHolder.query('BEGIN');
    await rescheduleHolder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [rescheduleFirstReady.pairingId]);
    const rescheduleHolderPid = await backendPid(rescheduleHolder);
    const reschedulePromise = dispatch(
      agent()
        .post(`/v1/students/${rescheduleFirstReady.studentId}/tasks/${moving.id}/reschedule`)
        .set(writeHeaders(cookies))
        .send({ scheduledLocalDate: farDate, reason: '先改期', expectedVersion: moving.version }),
    );
    const rescheduleWaiter = await waitForWaiterOnHolder(
      rescheduleObserver,
      rescheduleHolderPid,
      'reschedule waits on pairing',
    );
    const pauseAfterPromise = dispatch(
      agent()
        .patch(`/v1/students/${rescheduleFirstReady.studentId}/plans/${rescheduleFirstPlan.id}`)
        .set(writeHeaders(cookies))
        .send({ action: 'PAUSE', expectedVersion: rescheduleFirstPlan.version }),
    );
    const pauseAfterWaiter = await waitForWaiterOnHolder(
      rescheduleObserver,
      rescheduleWaiter.waiter_pid,
      'pause waits on reschedule',
    );
    expect(pauseAfterWaiter.holder_pid).toBe(rescheduleWaiter.waiter_pid);
    await rescheduleHolder.query('ROLLBACK');
    const moved = await reschedulePromise;
    const pausedAfter = await pauseAfterPromise;
    expect(moved.status).toBe(200);
    expect(moved.body.scheduledLocalDate).toBe(farDate);
    expect(pausedAfter.status).toBe(200);
    expect(pausedAfter.body.status).toBe('PAUSED');
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: moving.id } })).toMatchObject({
      scheduledLocalDate: farDate,
      occurrenceKey: moving.occurrenceKey,
      status: 'CANCELLED',
      cancelReason: 'PLAN_PAUSED',
    });
    expect(today).toBeTruthy();
    await rescheduleHolder.end();
    await rescheduleObserver.end();
  });

  it('archive-first overlapping reschedule is rejected; reschedule-first then archive cancels the moved row', async () => {
    const { cookies } = await signIn();
    const archiveFirstReady = await readyStudent(cookies, '归档先改期');
    const archiveFirstPlan = await importReadyPlan(cookies, archiveFirstReady);
    const archiveFirstRow = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: archiveFirstPlan.id }, status: 'PLANNED' },
      orderBy: { scheduledLocalDate: 'asc' },
    });
    const farDate = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Shanghai',
    });
    const archiveHolder = new pg.Client({ connectionString });
    const archiveObserver = await observerClient();
    await archiveHolder.connect();
    await archiveHolder.query('BEGIN');
    await archiveHolder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [archiveFirstReady.pairingId]);
    const archiveHolderPid = await backendPid(archiveHolder);
    const archivePromise = dispatch(
      agent()
        .patch(`/v1/students/${archiveFirstReady.studentId}/plans/${archiveFirstPlan.id}`)
        .set(writeHeaders(cookies))
        .send({ action: 'ARCHIVE', expectedVersion: archiveFirstPlan.version }),
    );
    const archiveWaiter = await waitForWaiterOnHolder(archiveObserver, archiveHolderPid, 'archive waits on pairing');
    const rescheduleAfterArchivePromise = dispatch(
      agent()
        .post(`/v1/students/${archiveFirstReady.studentId}/tasks/${archiveFirstRow.id}/reschedule`)
        .set(writeHeaders(cookies))
        .send({ scheduledLocalDate: farDate, reason: '归档后改期', expectedVersion: archiveFirstRow.version }),
    );
    const rescheduleAfterArchiveWaiter = await waitForWaiterOnHolder(
      archiveObserver,
      archiveWaiter.waiter_pid,
      'reschedule waits on archive',
    );
    expect(rescheduleAfterArchiveWaiter.holder_pid).toBe(archiveWaiter.waiter_pid);
    await archiveHolder.query('ROLLBACK');
    const archived = await archivePromise;
    const rescheduleAfterArchive = await rescheduleAfterArchivePromise;
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('ARCHIVED');
    expect(rescheduleAfterArchive.status).toBe(409);
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: archiveFirstRow.id } })).toMatchObject({
      scheduledLocalDate: archiveFirstRow.scheduledLocalDate,
      occurrenceKey: archiveFirstRow.occurrenceKey,
    });
    await archiveHolder.end();
    await archiveObserver.end();

    const rescheduleFirstReady = await readyStudent(cookies, '改期先归档');
    const rescheduleFirstPlan = await importReadyPlan(cookies, rescheduleFirstReady);
    const moving = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: rescheduleFirstPlan.id }, status: 'PLANNED' },
      orderBy: { scheduledLocalDate: 'asc' },
    });
    const rescheduleHolder = new pg.Client({ connectionString });
    const rescheduleObserver = await observerClient();
    await rescheduleHolder.connect();
    await rescheduleHolder.query('BEGIN');
    await rescheduleHolder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [rescheduleFirstReady.pairingId]);
    const rescheduleHolderPid = await backendPid(rescheduleHolder);
    const reschedulePromise = dispatch(
      agent()
        .post(`/v1/students/${rescheduleFirstReady.studentId}/tasks/${moving.id}/reschedule`)
        .set(writeHeaders(cookies))
        .send({ scheduledLocalDate: farDate, reason: '先改期再归档', expectedVersion: moving.version }),
    );
    const rescheduleWaiter = await waitForWaiterOnHolder(
      rescheduleObserver,
      rescheduleHolderPid,
      'reschedule waits on pairing before archive',
    );
    const archiveAfterPromise = dispatch(
      agent()
        .patch(`/v1/students/${rescheduleFirstReady.studentId}/plans/${rescheduleFirstPlan.id}`)
        .set(writeHeaders(cookies))
        .send({ action: 'ARCHIVE', expectedVersion: rescheduleFirstPlan.version }),
    );
    const archiveAfterWaiter = await waitForWaiterOnHolder(
      rescheduleObserver,
      rescheduleWaiter.waiter_pid,
      'archive waits on reschedule',
    );
    expect(archiveAfterWaiter.holder_pid).toBe(rescheduleWaiter.waiter_pid);
    await rescheduleHolder.query('ROLLBACK');
    const moved = await reschedulePromise;
    const archivedAfter = await archiveAfterPromise;
    expect(moved.status).toBe(200);
    expect(archivedAfter.status).toBe(200);
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: moving.id } })).toMatchObject({
      scheduledLocalDate: farDate,
      occurrenceKey: moving.occurrenceKey,
      status: 'CANCELLED',
      cancelReason: 'PLAN_ARCHIVED',
    });
    await rescheduleHolder.end();
    await rescheduleObserver.end();
  });

  it('consent withdraw overlapping reschedule linearizes; late replay stays rejected', async () => {
    const { cookies } = await signIn();
    const ready = await readyStudent(cookies, '改期同意竞争');
    const plan = await importReadyPlan(cookies, ready);
    const moving = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: plan.id }, status: 'PLANNED' },
      orderBy: { scheduledLocalDate: 'asc' },
    });
    const farDate = new Date(Date.now() + 22 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Shanghai',
    });
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [ready.pairingId]);
    const holderPid = await backendPid(holder);
    const reschedulePromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/tasks/${moving.id}/reschedule`)
        .set(writeHeaders(cookies))
        .send({ scheduledLocalDate: farDate, reason: '撤回竞争', expectedVersion: moving.version }),
    );
    const writer = await waitForWaiterOnHolder(observer, holderPid, 'reschedule waits on pairing');
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
    const overlap = await waitForWaiterOnHolder(observer, writer.waiter_pid, 'withdraw waits on reschedule');
    expect(overlap.holder_pid).toBe(writer.waiter_pid);
    await holder.query('ROLLBACK');
    const moved = await reschedulePromise;
    expect(moved.status).toBe(200);
    expect(moved.body.scheduledLocalDate).toBe(farDate);
    const withdrawn = await withdrawPromise;
    expect(withdrawn.status).toBeLessThan(300);
    const late = await agent()
      .post(`/v1/students/${ready.studentId}/tasks/${moving.id}/reschedule`)
      .set(writeHeaders(cookies))
      .send({
        scheduledLocalDate: new Date(Date.now() + 23 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', {
          timeZone: 'Asia/Shanghai',
        }),
        reason: '晚到',
        expectedVersion: moved.body.version,
      });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: moving.id } })).toMatchObject({
      scheduledLocalDate: farDate,
      occurrenceKey: moving.occurrenceKey,
    });
    await holder.end();
    await observer.end();
  });

  it('edit and reschedule with the same expectedVersion serialize; loser gets VERSION_CONFLICT', async () => {
    const { cookies } = await signIn();
    const ready = await readyStudent(cookies, '内容改期竞争');
    const plan = await importReadyPlan(cookies, ready);
    const row = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: plan.id }, status: 'PLANNED' },
      orderBy: { scheduledLocalDate: 'asc' },
    });
    const farDate = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Shanghai',
    });
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [ready.pairingId]);
    const holderPid = await backendPid(holder);
    const editPromise = dispatch(
      agent()
        .patch(`/v1/students/${ready.studentId}/tasks/${row.id}`)
        .set(writeHeaders(cookies))
        .send({
          name: '并发改名',
          subject: '语文',
          standard: '读完指定页',
          durationMinutes: 12,
          steps: ['先读'],
          expectedVersion: row.version,
        }),
    );
    const editWaiter = await waitForWaiterOnHolder(observer, holderPid, 'edit waits on pairing');
    const blocked = await observer.query<{ pids: number[] }>('SELECT pg_blocking_pids($1::int) AS pids', [
      editWaiter.waiter_pid,
    ]);
    expect(blocked.rows[0]?.pids ?? []).toContain(holderPid);
    const reschedulePromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/tasks/${row.id}/reschedule`)
        .set(writeHeaders(cookies))
        .send({ scheduledLocalDate: farDate, reason: '并发改期', expectedVersion: row.version }),
    );
    const rescheduleWaiter = await waitForWaiterOnHolder(observer, editWaiter.waiter_pid, 'reschedule waits on edit');
    expect(rescheduleWaiter.holder_pid).toBe(editWaiter.waiter_pid);
    await holder.query('ROLLBACK');
    const edited = await editPromise;
    const moved = await reschedulePromise;
    expect([edited.status, moved.status].sort()).toEqual([200, 409]);
    const winner = edited.status === 200 ? edited : moved;
    const loser = edited.status === 409 ? edited : moved;
    expect(loser.body.code).toBe('VERSION_CONFLICT');
    const persisted = await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: row.id } });
    expect(persisted.version).toBe(row.version + 1);
    if (winner.status === 200 && winner.body.name === '并发改名') {
      expect(persisted.nameSnapshot).toBe('并发改名');
      expect(persisted.scheduledLocalDate).toBe(row.scheduledLocalDate);
    } else {
      expect(persisted.scheduledLocalDate).toBe(farDate);
      expect(persisted.nameSnapshot).toBe(row.nameSnapshot);
    }
    await holder.end();
    await observer.end();
  });

  it('pause-first overlapping content edit is rejected; withdraw waits on edit', async () => {
    const { cookies } = await signIn();
    const pauseReady = await readyStudent(cookies, '暂停先编辑');
    const pausePlan = await importReadyPlan(cookies, pauseReady);
    const pauseRow = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: pausePlan.id }, status: 'PLANNED' },
    });
    const pauseHolder = new pg.Client({ connectionString });
    const pauseObserver = await observerClient();
    await pauseHolder.connect();
    await pauseHolder.query('BEGIN');
    await pauseHolder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [pauseReady.pairingId]);
    const pauseHolderPid = await backendPid(pauseHolder);
    const pausePromise = dispatch(
      agent()
        .patch(`/v1/students/${pauseReady.studentId}/plans/${pausePlan.id}`)
        .set(writeHeaders(cookies))
        .send({ action: 'PAUSE', expectedVersion: pausePlan.version }),
    );
    const pauseWaiter = await waitForWaiterOnHolder(pauseObserver, pauseHolderPid, 'pause waits on pairing');
    const editAfterPausePromise = dispatch(
      agent()
        .patch(`/v1/students/${pauseReady.studentId}/tasks/${pauseRow.id}`)
        .set(writeHeaders(cookies))
        .send({
          name: '暂停后不应写入',
          subject: '语文',
          standard: '读完指定页',
          durationMinutes: 10,
          steps: ['先读'],
          expectedVersion: pauseRow.version,
        }),
    );
    const editAfterPauseWaiter = await waitForWaiterOnHolder(
      pauseObserver,
      pauseWaiter.waiter_pid,
      'edit waits on pause',
    );
    expect(editAfterPauseWaiter.holder_pid).toBe(pauseWaiter.waiter_pid);
    await pauseHolder.query('ROLLBACK');
    const paused = await pausePromise;
    const editAfterPause = await editAfterPausePromise;
    expect(paused.status).toBe(200);
    expect(editAfterPause.status).toBe(409);
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: pauseRow.id } })).toMatchObject({
      nameSnapshot: pauseRow.nameSnapshot,
      status: 'CANCELLED',
      cancelReason: 'PLAN_PAUSED',
    });
    await pauseHolder.end();
    await pauseObserver.end();

    const ready = await readyStudent(cookies, '编辑同意竞争');
    const plan = await importReadyPlan(cookies, ready);
    const row = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: plan.id }, status: 'PLANNED' },
    });
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [ready.pairingId]);
    const holderPid = await backendPid(holder);
    const editPromise = dispatch(
      agent()
        .patch(`/v1/students/${ready.studentId}/tasks/${row.id}`)
        .set(writeHeaders(cookies))
        .send({
          name: '撤回前写入',
          subject: '语文',
          standard: '读完指定页',
          durationMinutes: 10,
          steps: ['先读'],
          expectedVersion: row.version,
        }),
    );
    const writer = await waitForWaiterOnHolder(observer, holderPid, 'edit waits on pairing');
    const withdrawPromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/consents/${ready.consentId}/withdraw`)
        .set(writeHeaders(cookies))
        .send({ reasonCode: 'GUARDIAN_REQUEST' }),
    );
    const overlap = await waitForWaiterOnHolder(observer, writer.waiter_pid, 'withdraw waits on edit');
    expect(overlap.holder_pid).toBe(writer.waiter_pid);
    await holder.query('ROLLBACK');
    const edited = await editPromise;
    expect(edited.status).toBe(200);
    expect(edited.body.name).toBe('撤回前写入');
    const withdrawn = await withdrawPromise;
    expect(withdrawn.status).toBeLessThan(300);
    const late = await agent()
      .patch(`/v1/students/${ready.studentId}/tasks/${row.id}`)
      .set(writeHeaders(cookies))
      .send({
        name: '晚到',
        subject: '语文',
        standard: '读完指定页',
        durationMinutes: 10,
        steps: ['先读'],
        expectedVersion: edited.body.version,
      });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.taskOccurrence.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      nameSnapshot: '撤回前写入',
    });
    await holder.end();
    await observer.end();
  });

  it('future content waits on single edit and expired step-up after lock wait writes nothing', async () => {
    const { cookies } = await signIn();
    const ready = await readyStudent(cookies, '未来竞争');
    const plan = await importReadyPlan(cookies, ready);
    const row = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: plan.id }, status: 'PLANNED' },
      include: { series: true },
    });
    const student = await prisma.studentProfile.findUniqueOrThrow({ where: { id: ready.studentId } });
    const versions = {
      expectedStudentVersion: student.version,
      expectedPlanVersion: plan.version,
      expectedSeriesVersion: row.series.version,
      expectedOccurrenceVersion: row.version,
    };
    const proposal = {
      kind: 'CONTENT',
      name: '未来竞争名',
      subject: '语文',
      standard: '读完指定页',
      durationMinutes: 10,
      steps: ['先读'],
      reason: '并发',
    };
    const preview = await agent()
      .post(`/v1/students/${ready.studentId}/tasks/${row.id}/future-change/preview`)
      .set(writeHeaders(cookies))
      .send({ ...versions, proposal });
    expect(preview.status).toBe(200);

    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [ready.pairingId]);
    const holderPid = await backendPid(holder);
    const editPromise = dispatch(
      agent()
        .patch(`/v1/students/${ready.studentId}/tasks/${row.id}`)
        .set(writeHeaders(cookies))
        .send({
          name: '单次先写',
          subject: '语文',
          standard: '读完指定页',
          durationMinutes: 10,
          steps: ['先读'],
          expectedVersion: row.version,
        }),
    );
    const editor = await waitForWaiterOnHolder(observer, holderPid, 'single edit waits on pairing');
    const futurePromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/tasks/${row.id}/future-change`)
        .set(writeHeaders(cookies))
        .send({ ...versions, proposal, previewDigest: preview.body.previewDigest }),
    );
    const futureWaiter = await waitForWaiterOnHolder(observer, editor.waiter_pid, 'future waits on edit');
    expect(futureWaiter.holder_pid).toBe(editor.waiter_pid);
    await holder.query('ROLLBACK');
    const edited = await editPromise;
    const future = await futurePromise;
    expect(edited.status).toBe(200);
    expect(future.status).toBe(409);
    expect(['VERSION_CONFLICT', 'TASK_FUTURE_PREVIEW_STALE']).toContain(future.body.code);
    expect(await prisma.taskSeriesRevision.count({ where: { taskSeriesId: row.seriesId } })).toBe(1);
    await holder.end();
    await observer.end();

    const stepReady = await readyStudent(cookies, '未来二次验证');
    const stepPlan = await importReadyPlan(cookies, stepReady);
    const stepRow = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: stepPlan.id }, status: 'PLANNED' },
      include: { series: true },
    });
    const stepStudent = await prisma.studentProfile.findUniqueOrThrow({ where: { id: stepReady.studentId } });
    const stepPreview = await agent()
      .post(`/v1/students/${stepReady.studentId}/tasks/${stepRow.id}/future-change/preview`)
      .set(writeHeaders(cookies))
      .send({
        expectedStudentVersion: stepStudent.version,
        expectedPlanVersion: stepPlan.version,
        expectedSeriesVersion: stepRow.series.version,
        expectedOccurrenceVersion: stepRow.version,
        proposal,
      });
    expect(stepPreview.status).toBe(200);
    const pairing = await prisma.devicePairing.findUniqueOrThrow({ where: { id: stepReady.pairingId } });
    const adminUrl = process.env.STP004_ADMIN_DATABASE_URL;
    if (!adminUrl) {
      throw new Error('STP004_ADMIN_DATABASE_URL is required to backdate step-up without changing stepUpMs');
    }
    const stepHolder = new pg.Client({ connectionString: adminUrl });
    const stepObserver = await observerClient();
    await stepHolder.connect();
    await stepHolder.query('BEGIN');
    await stepHolder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [stepReady.pairingId]);
    const stepHolderPid = await backendPid(stepHolder);
    const pending = dispatch(
      agent()
        .post(`/v1/students/${stepReady.studentId}/tasks/${stepRow.id}/future-change`)
        .set(writeHeaders(cookies))
        .send({
          expectedStudentVersion: stepStudent.version,
          expectedPlanVersion: stepPlan.version,
          expectedSeriesVersion: stepRow.series.version,
          expectedOccurrenceVersion: stepRow.version,
          proposal,
          previewDigest: stepPreview.body.previewDigest,
        }),
    );
    const waiter = await waitForWaiterOnHolder(stepObserver, stepHolderPid, 'future waits for expired step-up');
    expect((await stepObserver.query('SELECT pg_blocking_pids($1::int) AS pids', [waiter.waiter_pid])).rows[0].pids).toContain(
      stepHolderPid,
    );
    await stepHolder.query('SET LOCAL session_replication_role = replica');
    await stepHolder.query(
      `UPDATE device_sessions SET step_up_verified_at = clock_timestamp() - interval '6 minutes' WHERE id = $1`,
      [pairing.createdBySessionId],
    );
    await stepHolder.query('COMMIT');
    const denied = await pending;
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('STEP_UP_REQUIRED');
    expect(await prisma.taskSeriesRevision.count({ where: { taskSeriesId: stepRow.seriesId } })).toBe(1);
    expect(await prisma.planAdjustment.count({
      where: { seriesId: stepRow.seriesId, reasonCode: 'SERIES_FUTURE_CONTENT_CHANGED' },
    })).toBe(0);
    await stepHolder.end();
    await stepObserver.end();
  });

  it('future schedule waits on horizon and pause-first writes nothing', async () => {
    const { cookies } = await signIn();
    const ready = await readyStudent(cookies, '排期竞争');
    const plan = await importReadyPlan(cookies, ready);
    const row = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: plan.id }, status: 'PLANNED' },
      include: { series: true },
    });
    const student = await prisma.studentProfile.findUniqueOrThrow({ where: { id: ready.studentId } });
    const weekday = isoWeekdayFromLocalDate(row.occurrenceKey);
    const versions = {
      expectedStudentVersion: student.version,
      expectedPlanVersion: plan.version,
      expectedSeriesVersion: row.series.version,
      expectedOccurrenceVersion: row.version,
    };
    const proposal = {
      kind: 'SCHEDULE',
      repeatKind: 'WEEKLY_DAYS',
      weekdays: [weekday],
      endLocalDate: null,
      ongoing: true,
      reason: '并发排期',
    };
    const preview = await agent()
      .post(`/v1/students/${ready.studentId}/tasks/${row.id}/future-change/preview`)
      .set(writeHeaders(cookies))
      .send({ ...versions, proposal });
    expect(preview.status).toBe(200);

    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM study_plans WHERE id = $1 FOR UPDATE', [plan.id]);
    const holderPid = await backendPid(holder);
    const horizonPromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/task-horizon`)
        .set(writeHeaders(cookies))
        .send({}),
    );
    const horizonWaiter = await waitForWaiterOnHolder(observer, holderPid, 'horizon waits on plan');
    const schedulePromise = dispatch(
      agent()
        .post(`/v1/students/${ready.studentId}/tasks/${row.id}/future-change`)
        .set(writeHeaders(cookies))
        .send({ ...versions, proposal, previewDigest: preview.body.previewDigest }),
    );
    const scheduleWaiter = await waitForWaiterOnHolder(observer, horizonWaiter.waiter_pid, 'schedule waits on horizon');
    expect(scheduleWaiter.holder_pid).toBe(horizonWaiter.waiter_pid);
    await holder.query('ROLLBACK');
    const horizon = await horizonPromise;
    const scheduled = await schedulePromise;
    expect(horizon.status).toBe(200);
    expect([200, 409]).toContain(scheduled.status);
    if (scheduled.status === 200) {
      expect(scheduled.body.series.version).toBe(row.series.version + 1);
      expect(
        await prisma.planAdjustment.count({
          where: { seriesId: row.seriesId, reasonCode: 'SERIES_FUTURE_SCHEDULE_CHANGED' },
        }),
      ).toBe(1);
    } else {
      expect(['VERSION_CONFLICT', 'TASK_FUTURE_PREVIEW_STALE']).toContain(scheduled.body.code);
      expect(
        await prisma.planAdjustment.count({
          where: { seriesId: row.seriesId, reasonCode: 'SERIES_FUTURE_SCHEDULE_CHANGED' },
        }),
      ).toBe(0);
    }
    const grouped = await prisma.taskOccurrence.groupBy({
      by: ['seriesId', 'occurrenceKey'],
      where: { seriesId: row.seriesId },
      _count: { _all: true },
    });
    expect(grouped.every((item) => item._count._all === 1)).toBe(true);
    await holder.end();
    await observer.end();

    const pauseReady = await readyStudent(cookies, '排期暂停竞争');
    const pausePlan = await importReadyPlan(cookies, pauseReady);
    const pauseRow = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: pausePlan.id }, status: 'PLANNED' },
      include: { series: true },
    });
    const pauseStudent = await prisma.studentProfile.findUniqueOrThrow({ where: { id: pauseReady.studentId } });
    const pauseWeekday = isoWeekdayFromLocalDate(pauseRow.occurrenceKey);
    const pauseProposal = {
      kind: 'SCHEDULE',
      repeatKind: 'WEEKLY_DAYS',
      weekdays: [pauseWeekday],
      endLocalDate: null,
      ongoing: true,
      reason: '暂停竞争',
    };
    const pausePreview = await agent()
      .post(`/v1/students/${pauseReady.studentId}/tasks/${pauseRow.id}/future-change/preview`)
      .set(writeHeaders(cookies))
      .send({
        expectedStudentVersion: pauseStudent.version,
        expectedPlanVersion: pausePlan.version,
        expectedSeriesVersion: pauseRow.series.version,
        expectedOccurrenceVersion: pauseRow.version,
        proposal: pauseProposal,
      });
    expect(pausePreview.status).toBe(200);
    const pauseHolder = new pg.Client({ connectionString });
    const pauseObserver = await observerClient();
    await pauseHolder.connect();
    await pauseHolder.query('BEGIN');
    await pauseHolder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [pauseReady.pairingId]);
    const pauseHolderPid = await backendPid(pauseHolder);
    const pausePromise = dispatch(
      agent()
        .patch(`/v1/students/${pauseReady.studentId}/plans/${pausePlan.id}`)
        .set(writeHeaders(cookies))
        .send({ action: 'PAUSE', expectedVersion: pausePlan.version }),
    );
    const pauseWaiter = await waitForWaiterOnHolder(pauseObserver, pauseHolderPid, 'pause waits on pairing');
    const scheduleAfterPausePromise = dispatch(
      agent()
        .post(`/v1/students/${pauseReady.studentId}/tasks/${pauseRow.id}/future-change`)
        .set(writeHeaders(cookies))
        .send({
          expectedStudentVersion: pauseStudent.version,
          expectedPlanVersion: pausePlan.version,
          expectedSeriesVersion: pauseRow.series.version,
          expectedOccurrenceVersion: pauseRow.version,
          proposal: pauseProposal,
          previewDigest: pausePreview.body.previewDigest,
        }),
    );
    const scheduleAfterPauseWaiter = await waitForWaiterOnHolder(
      pauseObserver,
      pauseWaiter.waiter_pid,
      'schedule waits on pause',
    );
    expect(scheduleAfterPauseWaiter.holder_pid).toBe(pauseWaiter.waiter_pid);
    await pauseHolder.query('ROLLBACK');
    const paused = await pausePromise;
    const scheduleAfterPause = await scheduleAfterPausePromise;
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('PAUSED');
    expect(scheduleAfterPause.status).toBe(409);
    expect(['PLAN_STATUS_INVALID', 'VERSION_CONFLICT', 'TASK_NOT_ADJUSTABLE']).toContain(scheduleAfterPause.body.code);
    expect(
      await prisma.planAdjustment.count({
        where: { seriesId: pauseRow.seriesId, reasonCode: 'SERIES_FUTURE_SCHEDULE_CHANGED' },
      }),
    ).toBe(0);
    expect(await prisma.taskSeriesRevision.count({ where: { taskSeriesId: pauseRow.seriesId } })).toBe(1);
    await pauseHolder.end();
    await pauseObserver.end();
  });
});
