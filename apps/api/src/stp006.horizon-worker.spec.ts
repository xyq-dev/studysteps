import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from './app.module';
import { HttpErrorFilter } from './common/http-exception.filter';
import { TestAuthDelivery } from './auth/test-delivery.adapter';
import { RuntimeConfig } from './common/runtime-config';
import { HorizonWorkerService } from './horizon-worker/service';
import { HorizonWorkerModule } from './horizon-worker/module';
import { TaskHorizonJobRepository } from './planning/task-horizon-job.repository';
import { HORIZON_REQUEUE_REASON, addLocalDays, localDateInTimeZone } from '@studysteps/domain';
import {
  assertStp004IntegrationReady,
  loadStp004Env,
  shouldSkipStp004Isolation,
} from './test/load-stp004-env';
import { backendPid, waitForWaiterOnHolder } from './test/lock-barrier';
import pg from 'pg';

const ORIGIN = 'http://127.0.0.1:5173';
const connectionString = process.env.STP004_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const apiRoot = join(__dirname, '..');

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

describe.skipIf(shouldSkipStp004Isolation())('STP 006-D horizon standing-job worker', () => {
  let app: INestApplication;
  let inbox: TestAuthDelivery;
  const prisma = new PrismaClient({ datasourceUrl: connectionString });
  let phoneSeq = 0;

  function nextPhone() {
    return `13800138${String(250 + (phoneSeq++ % 30)).padStart(3, '0')}`;
  }

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
    expect(app.get(RuntimeConfig).value.horizon.enabled).toBe(false);
    expect(() => app.get(HorizonWorkerService)).toThrow();
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
    expect(delivered).toBeTruthy();
    const sessionRes = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: codeRes.body.challengeId,
        code: delivered,
        device: { installationId, label: 'horizon-worker' },
      });
    cookies.apply(sessionRes);
    return { cookies, phone, installationId };
  }

  async function readyStudent(nickname: string) {
    const signed = await signIn();
    const docs = await agent()
      .get('/v1/consent-documents?ageBand=UNDER_14')
      .set('Origin', ORIGIN)
      .set('Cookie', signed.cookies.header());
    expect(docs.status).toBeLessThan(300);
    const created = await agent()
      .post('/v1/students')
      .set(writeHeaders(signed.cookies))
      .send({
        profile: { nickname, avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
        ageConfirmation: { band: 'UNDER_14', source: 'GUARDIAN_DECLARATION' },
        consentAcceptances: [{ policyKey: docs.body.policyKey, version: docs.body.version }],
      });
    expect(created.status).toBe(201);
    const grades = await agent()
      .get('/v1/grade-configs')
      .set('Origin', ORIGIN)
      .set('Cookie', signed.cookies.header());
    expect(grades.status).toBe(200);
    const g1 = grades.body.items.find(
      (item: { schoolSystemCode: string; gradeCode: string; stageCode: string }) =>
        item.schoolSystemCode === 'SIX_THREE' && item.stageCode === 'PRIMARY' && item.gradeCode === 'G1',
    );
    const set = await agent()
      .patch(`/v1/students/${created.body.profile.id}`)
      .set(writeHeaders(signed.cookies))
      .send({
        kind: 'EDUCATION',
        expectedVersion: created.body.profile.version,
        gradeConfigId: g1.id,
        termCode: 'FULL_YEAR',
        changeKind: 'SET',
      });
    const listed = await agent().get(`/v1/templates?studentId=${set.body.id}`).set('Cookie', signed.cookies.header());
    const templateId = listed.body.recommendedTemplateIds[0] as string;
    const preview = await agent()
      .post(`/v1/students/${set.body.id}/templates/${templateId}/preview`)
      .set(writeHeaders(signed.cookies))
      .send({});
    const imported = await agent()
      .post(`/v1/students/${set.body.id}/templates/${templateId}/import`)
      .set(writeHeaders(signed.cookies))
      .send({
        expectedStudentVersion: set.body.version,
        previewDigest: preview.body.previewDigest,
        templateVersion: preview.body.template.version,
        tasks: preview.body.tasks,
        coCreationAttested: true,
      });
    expect(imported.status).toBeLessThan(300);
    return { ...signed, student: set.body, planId: imported.body.id as string };
  }

  async function wakeJob(planId: string) {
    const current = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId } });
    await prisma.taskHorizonJob.update({
      where: { planId },
      data: {
        state: 'READY',
        stateReason: null,
        availableAt: new Date(0),
        requestedGeneration: current.requestedGeneration + 1n,
      },
    });
  }

  async function runWorkerOnce() {
    const ctx = await Test.createTestingModule({ imports: [HorizonWorkerModule] }).compile();
    const worker = ctx.get(HorizonWorkerService);
    expect(worker.capability).toBe('SYSTEM/HORIZON_WORKER_V1');
    const result = await worker.runOnce(20, 20_000);
    await ctx.close();
    return result;
  }

  it('creates a standing-job when a plan is created and GET does not generate', async () => {
    const ready = await readyStudent('作业孩子');
    const job = await prisma.taskHorizonJob.findUnique({ where: { planId: ready.planId } });
    expect(job?.state).toBe('READY');
    const before = await prisma.taskOccurrence.count({ where: { series: { planId: ready.planId } } });
    const listed = await agent()
      .get(`/v1/students/${ready.student.id}/tasks`)
      .set('Cookie', ready.cookies.header());
    expect(listed.status).toBe(200);
    const after = await prisma.taskOccurrence.count({ where: { series: { planId: ready.planId } } });
    expect(after).toBe(before);
  });

  it('fills missing occurrences without an HTTP horizon POST', async () => {
    const ready = await readyStudent('自动补齐');
    const deleted = await prisma.taskOccurrence.deleteMany({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
    });
    expect(deleted.count).toBeGreaterThan(0);
    const before = await prisma.taskOccurrence.count({ where: { series: { planId: ready.planId } } });
    await wakeJob(ready.planId);
    const ran = await runWorkerOnce();
    expect(ran.processed).toBeGreaterThan(0);
    const after = await prisma.taskOccurrence.count({ where: { series: { planId: ready.planId } } });
    const job = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    expect(job.lastOutcome).toBe('GENERATED');
    expect(after).toBeGreaterThan(before);
    const second = await runWorkerOnce();
    const again = await prisma.taskOccurrence.count({ where: { series: { planId: ready.planId } } });
    expect(again).toBe(after);
    expect(second.processed).toBeGreaterThanOrEqual(0);
  });

  it('does not treat logout as stopping a legal standing plan', async () => {
    const ready = await readyStudent('退出登录');
    await prisma.taskOccurrence.deleteMany({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
    });
    await agent().delete('/v1/auth/session').set(writeHeaders(ready.cookies)).send();
    await wakeJob(ready.planId);
    await runWorkerOnce();
    const remaining = await prisma.taskOccurrence.count({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
    });
    expect(remaining).toBeGreaterThan(0);
    const plan = await prisma.studyPlan.findUniqueOrThrow({ where: { id: ready.planId } });
    const session = await prisma.deviceSession.findUniqueOrThrow({ where: { id: plan.createdBySessionId! } });
    expect(session.revokedAt).toBeTruthy();
    expect(session.revocationReasonCode).toBe('LOGOUT');
  });

  it('blocks generation after consent withdraw and wakes after regrant', async () => {
    const ready = await readyStudent('同意阻断');
    await prisma.taskOccurrence.deleteMany({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
    });
    const consents = await agent()
      .get(`/v1/students/${ready.student.id}/consents`)
      .set('Cookie', ready.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const withdrawn = await agent()
      .post(`/v1/students/${ready.student.id}/consents/${current.id}/withdraw`)
      .set(writeHeaders(ready.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdrawn.status).toBeLessThan(300);
    const blocked = await prisma.taskHorizonJob.findUnique({ where: { planId: ready.planId } });
    expect(blocked?.state).toBe('BLOCKED');
    expect(blocked?.stateReason).toBe('CONSENT_REQUIRED');
    await runWorkerOnce();
    const afterBlock = await prisma.taskOccurrence.count({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
    });
    expect(afterBlock).toBe(0);
    const latest = await prisma.studentProfile.findUniqueOrThrow({ where: { id: ready.student.id } });
    const docs = await agent().get('/v1/consent-documents?ageBand=UNDER_14').set('Cookie', ready.cookies.header());
    const granted = await agent()
      .post(`/v1/students/${ready.student.id}/consents`)
      .set(writeHeaders(ready.cookies))
      .send({
        expectedStudentVersion: latest.version,
        acceptances: [{ policyKey: docs.body.policyKey, version: docs.body.version }],
      });
    expect(granted.status).toBeLessThan(300);
    await prisma.studentProfile.update({
      where: { id: ready.student.id },
      data: { status: 'ACTIVE' },
    });
    await wakeJob(ready.planId);
    await runWorkerOnce();
    const restored = await prisma.taskOccurrence.count({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
    });
    expect(restored).toBeGreaterThan(0);
  });

  it('rejects a different original key occupying the same series date', async () => {
    const ready = await readyStudent('日期冲突');
    const series = await prisma.taskSeries.findFirstOrThrow({ where: { planId: ready.planId } });
    const today = localDateInTimeZone(new Date(), 'Asia/Shanghai');
    const hole = addLocalDays(today, 3);
    await prisma.taskOccurrence.deleteMany({
      where: { seriesId: series.id, occurrenceKey: hole },
    });
    const occupant = await prisma.taskOccurrence.findFirst({
      where: { seriesId: series.id, occurrenceKey: { not: hole } },
    });
    if (occupant) {
      await prisma.taskOccurrence.update({
        where: { id: occupant.id },
        data: { scheduledLocalDate: hole },
      });
    }
    const horizon = await agent()
      .post(`/v1/students/${ready.student.id}/task-horizon`)
      .set(writeHeaders(ready.cookies))
      .send({});
    expect(horizon.status).toBe(409);
    expect(horizon.body.code).toBe('TASK_DATE_CONFLICT');
  });

  it('does not let an expired lease token finish after takeover', async () => {
    const ready = await readyStudent('旧租约');
    const jobs = new TaskHorizonJobRepository(prisma as never);
    await prisma.taskHorizonJob.update({
      where: { planId: ready.planId },
      data: {
        state: 'LEASED',
        availableAt: null,
        claimedGeneration: 1,
        leaseToken: '11111111-1111-1111-1111-111111111111',
        leaseOwner: 'old-worker',
        leaseStartedAt: new Date(Date.now() - 400_000),
        leaseExpiresAt: new Date(Date.now() - 1000),
        lastExecutorKey: 'HORIZON_WORKER_V1',
      },
    });
    await jobs.reapExpired();
    await expect(
      prisma.$transaction((tx) =>
        jobs.completeSuccess(tx, {
          planId: ready.planId,
          leaseToken: '11111111-1111-1111-1111-111111111111',
          claimedGeneration: 1n,
          timezone: 'Asia/Shanghai',
          successLocalDate: '2026-09-19',
          insertedCount: 1,
          restoredCount: 0,
        }),
      ),
    ).rejects.toThrow(/token CAS/);
  });

  it('exhausts eight technical attempts then requires explicit requeue', async () => {
    const ready = await readyStudent('重试耗尽');
    await prisma.taskHorizonJob.update({
      where: { planId: ready.planId },
      data: {
        state: 'LEASED',
        availableAt: null,
        requestedGeneration: 1,
        processedGeneration: 0,
        claimedGeneration: 1,
        attemptCount: 7,
        leaseToken: '22222222-2222-2222-2222-222222222222',
        leaseOwner: 'failing-worker',
        leaseStartedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        lastExecutorKey: 'HORIZON_WORKER_V1',
      },
    });
    const jobs = new TaskHorizonJobRepository(prisma as never);
    await jobs.recordTechnicalFailure(ready.planId, 'TEST_FAIL');
    const failed = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    expect(failed.state).toBe('FAILED');
    expect(failed.stateReason).toBe('RETRY_EXHAUSTED');
    const conflict = await jobs.requeueFailed(ready.planId, 'WRONG');
    expect(conflict).toBe('CONFLICT');
    const ok = await jobs.requeueFailed(ready.planId, HORIZON_REQUEUE_REASON);
    expect(ok).toBe('OK');
    const readyJob = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    expect(readyJob.state).toBe('READY');
    expect(readyJob.attemptCount).toBe(0);
  });

  it('proves worker and HTTP share the plan lock with a real wait', async () => {
    const ready = await readyStudent('锁等待');
    const holder = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
    const waiter = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
    const observer = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
    await holder.connect();
    await waiter.connect();
    await observer.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM study_plans WHERE id = $1 FOR UPDATE', [ready.planId]);
    const holderId = await backendPid(holder);
    const waitPromise = waiter.query('SELECT id FROM study_plans WHERE id = $1 FOR UPDATE', [ready.planId]);
    const overlap = await waitForWaiterOnHolder(observer, holderId, 'horizon plan lock');
    expect(overlap.holder_pid ?? holderId).toBe(holderId);
    await holder.query('ROLLBACK');
    await waitPromise;
    await waiter.query('ROLLBACK');
    await holder.end();
    await waiter.end();
    await observer.end();
  });

  it('runs a bounded independent worker process and exits', async () => {
    const ready = await readyStudent('进程验收');
    await prisma.taskOccurrence.deleteMany({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
    });
    await wakeJob(ready.planId);
    const child = spawn(
      'pnpm',
      ['exec', 'nest', 'start', '--entryFile', 'horizon-worker/main', '--', '--once', '--max-jobs=5', '--max-ms=20000'],
      {
        cwd: apiRoot,
        env: {
          ...process.env,
          HORIZON_WORKER_ENABLED: 'true',
          DATABASE_URL: connectionString,
        },
        windowsHide: true,
        shell: true,
      },
    );
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('worker process exceeded 45s'));
      }, 45_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
    expect(exitCode).toBe(0);
    const after = await prisma.taskOccurrence.count({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
    });
    expect(after).toBeGreaterThan(0);
  });

  it('does not refresh a human session heartbeat and two workers do not duplicate keys', async () => {
    const ready = await readyStudent('心跳与双工');
    const plan = await prisma.studyPlan.findUniqueOrThrow({ where: { id: ready.planId } });
    const beforeSeen = await prisma.deviceSession.findUniqueOrThrow({ where: { id: plan.createdBySessionId! } });
    await prisma.taskOccurrence.deleteMany({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
    });
    await wakeJob(ready.planId);
    const [left, right] = await Promise.all([runWorkerOnce(), runWorkerOnce()]);
    expect(left.processed + right.processed).toBeGreaterThan(0);
    const keys = await prisma.taskOccurrence.findMany({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
      select: { seriesId: true, occurrenceKey: true },
    });
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys.map((row) => `${row.seriesId}:${row.occurrenceKey}`)).size).toBe(keys.length);
    const afterSeen = await prisma.deviceSession.findUniqueOrThrow({ where: { id: plan.createdBySessionId! } });
    expect(afterSeen.lastSeenAt?.toISOString() ?? null).toBe(beforeSeen.lastSeenAt?.toISOString() ?? null);
    const created = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
    });
    const student = await prisma.studentProfile.findUniqueOrThrow({ where: { id: ready.student.id } });
    expect(created.gradeCodeSnapshot).toBe(student.gradeCode);
    expect(created.gradeConfigVersionId).toBe(student.gradeConfigVersionId);
  });

  it('keeps a mid-run generation wake after success and refuses writes after consent dies in a real lock wait', async () => {
    const ready = await readyStudent('执行中唤醒');
    const jobs = new TaskHorizonJobRepository(prisma as never);
    await prisma.taskHorizonJob.update({
      where: { planId: ready.planId },
      data: {
        state: 'LEASED',
        availableAt: null,
        requestedGeneration: 1,
        processedGeneration: 0,
        claimedGeneration: 1,
        leaseToken: '33333333-3333-3333-3333-333333333333',
        leaseOwner: 'mid-run',
        leaseStartedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        lastExecutorKey: 'HORIZON_WORKER_V1',
      },
    });
    await prisma.$transaction((tx) => jobs.signal(tx, [ready.planId]));
    await prisma.$transaction((tx) =>
      jobs.completeSuccess(tx, {
        planId: ready.planId,
        leaseToken: '33333333-3333-3333-3333-333333333333',
        claimedGeneration: 1n,
        timezone: 'Asia/Shanghai',
        successLocalDate: '2026-09-19',
        insertedCount: 1,
        restoredCount: 0,
      }),
    );
    const kept = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    expect(kept.state).toBe('READY');
    expect(kept.requestedGeneration).toBe(2n);
    expect(kept.processedGeneration).toBe(1n);
    expect(kept.availableAt && kept.availableAt.getTime()).toBeLessThan(Date.now() + 5_000);

    await prisma.taskOccurrence.deleteMany({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
    });
    await wakeJob(ready.planId);
    const consent = await prisma.consentRecord.findFirstOrThrow({
      where: { studentProfileId: ready.student.id, withdrawnAt: null, supersededAt: null },
    });
    const holder = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
    const observer = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
    await holder.connect();
    await observer.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM consent_records WHERE id = $1 FOR UPDATE', [consent.id]);
    const holderId = await backendPid(holder);
    const workerPromise = runWorkerOnce();
    const overlap = await waitForWaiterOnHolder(observer, holderId, 'worker waits on consent');
    expect(overlap.holder_pid ?? holderId).toBe(holderId);
    await holder.query(
      `UPDATE consent_records
          SET withdrawn_at = clock_timestamp(),
              withdrawn_by_account_id = $2,
              withdrawal_reason_code = 'GUARDIAN_REQUEST'
        WHERE id = $1`,
      [consent.id, consent.grantedByAccountId],
    );
    await holder.query('COMMIT');
    await workerPromise;
    const after = await prisma.taskOccurrence.count({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
    });
    expect(after).toBe(0);
    const blocked = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    expect(blocked.state).toBe('BLOCKED');
    expect(blocked.stateReason).toBe('CONSENT_REQUIRED');
    await holder.end();
    await observer.end();
  });
});
