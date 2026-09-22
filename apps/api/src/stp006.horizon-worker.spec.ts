import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { TaskHorizonCoreService } from './planning/task-horizon-core.service';
import {
  HORIZON_REQUEUE_REASON,
  addLocalDays,
  localDateInTimeZone,
  nextHorizonLocalReviewAt,
} from '@studysteps/domain';
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
const repoRoot = join(apiRoot, '..', '..');

type WorkerInternals = {
  executeClaimed(job: {
    planId: string;
    leaseToken: string;
    claimedGeneration: bigint;
    requestedGeneration: bigint;
    processedGeneration: bigint;
    leaseExpiresAt: Date;
  }): Promise<void>;
};

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

  let publicWorkerDistReady = false;

  async function ensurePublicWorkerDist() {
    const marker = join(apiRoot, 'dist/horizon-worker/main.js');
    if (publicWorkerDistReady && existsSync(marker)) {
      return;
    }
    let stderr = '';
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn('pnpm', ['exec', 'nest', 'build'], {
        cwd: apiRoot,
        env: process.env,
        windowsHide: true,
        shell: true,
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('exit', (exitCode) => resolve(exitCode ?? 1));
      child.on('error', reject);
    });
    expect({ code, stderr }).toEqual({ code: 0, stderr });
    expect(existsSync(marker)).toBe(true);
    publicWorkerDistReady = true;
  }

  function spawnPublicWorker(args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeoutMs = 45_000) {
    const child = spawn('pnpm', ['worker:horizon', '--', ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: connectionString,
        HORIZON_WORKER_ENABLED: 'true',
        ...extraEnv,
      },
      windowsHide: true,
      shell: true,
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    return new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`public worker exceeded ${timeoutMs}ms for ${args.join(' ')}`));
      }, timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stderr });
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async function parkOtherReadyJobs(keepPlanIds: string[]) {
    const jobs = new TaskHorizonJobRepository(prisma as never);
    while ((await jobs.reapExpired(20)) > 0) {
      // drain leftover expired leases so the next claim cannot pick them up
    }
    await prisma.taskHorizonJob.updateMany({
      where: {
        state: { in: ['READY', 'BLOCKED'] },
        planId: { notIn: keepPlanIds },
      },
      data: { availableAt: new Date('2099-01-01T00:00:00.000Z') },
    });
  }

  async function plantOversizedPlan(studentId: string) {
    const template = await prisma.taskOccurrence.findFirstOrThrow({
      where: { series: { plan: { studentProfileId: studentId } } },
    });
    const over = await prisma.studyPlan.create({
      data: {
        studentProfileId: studentId,
        status: 'ACTIVE',
        origin: 'STUDENT',
        importedContentJson: '[]',
        timezoneSnapshot: 'Asia/Shanghai',
      },
    });
    const overSeries = await prisma.taskSeries.create({
      data: {
        planId: over.id,
        name: template.nameSnapshot,
        subject: template.subjectSnapshot,
        completionStandard: template.completionStandardSnapshot,
        durationMinutes: template.durationMinutesSnapshot,
        stepsJson: template.stepsSnapshotJson,
        repeatKind: 'ONCE',
        startLocalDate: template.occurrenceKey,
        endLocalDate: template.occurrenceKey,
        effectiveFromLocalDate: template.occurrenceKey,
        effectiveToLocalDate: template.occurrenceKey,
        ongoing: false,
      },
    });
    const parent = await prisma.taskOccurrence.create({
      data: {
        seriesId: overSeries.id,
        occurrenceKey: template.occurrenceKey,
        originalLocalDate: template.occurrenceKey,
        scheduledLocalDate: template.occurrenceKey,
        timezoneSnapshot: template.timezoneSnapshot,
        status: 'CANCELLED',
        cancelReason: 'SPLIT',
        nameSnapshot: template.nameSnapshot,
        subjectSnapshot: template.subjectSnapshot,
        completionStandardSnapshot: template.completionStandardSnapshot,
        durationMinutesSnapshot: template.durationMinutesSnapshot,
        stepsSnapshotJson: template.stepsSnapshotJson,
        gradeConfigId: template.gradeConfigId,
        gradeConfigVersionId: template.gradeConfigVersionId,
        stageCodeSnapshot: template.stageCodeSnapshot,
        schoolSystemCodeSnapshot: template.schoolSystemCodeSnapshot,
        gradeCodeSnapshot: template.gradeCodeSnapshot,
        gradeLabelSnapshot: template.gradeLabelSnapshot,
        termCodeSnapshot: template.termCodeSnapshot,
        catalogEntryKeySnapshot: template.catalogEntryKeySnapshot,
      },
    });
    await prisma.$executeRaw`
      INSERT INTO task_occurrences (
        id, series_id, occurrence_key, original_local_date, scheduled_local_date, timezone_snapshot,
        status, name_snapshot, subject_snapshot, completion_standard_snapshot, duration_minutes_snapshot,
        steps_snapshot_json, grade_config_id, grade_config_version_id, stage_code_snapshot,
        school_system_code_snapshot, grade_code_snapshot, grade_label_snapshot, term_code_snapshot,
        catalog_entry_key_snapshot, source_occurrence_id, version, content_revision_no, schedule_revision_no,
        created_at, updated_at
      )
      SELECT gen_random_uuid(), ${overSeries.id}::uuid,
             to_char(DATE '2000-01-02' + g::int, 'YYYY-MM-DD'),
             to_char(DATE '2000-01-02' + g::int, 'YYYY-MM-DD'),
             to_char(DATE '2000-01-02' + g::int, 'YYYY-MM-DD'),
             ${template.timezoneSnapshot},
             'PLANNED',
             ${template.nameSnapshot},
             ${template.subjectSnapshot},
             ${template.completionStandardSnapshot},
             ${template.durationMinutesSnapshot},
             ${template.stepsSnapshotJson},
             ${template.gradeConfigId}::uuid,
             ${template.gradeConfigVersionId}::uuid,
             ${template.stageCodeSnapshot},
             ${template.schoolSystemCodeSnapshot},
             ${template.gradeCodeSnapshot},
             ${template.gradeLabelSnapshot},
             ${template.termCodeSnapshot},
             ${template.catalogEntryKeySnapshot},
             ${parent.id}::uuid,
             1, 1, 1, clock_timestamp(), clock_timestamp()
        FROM generate_series(0, 5000) AS g
    `;
    return over.id;
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
          now: new Date('2026-09-19T04:00:00.000Z'),
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
    await jobs.recordTechnicalFailure(
      ready.planId,
      'TEST_FAIL',
      '22222222-2222-2222-2222-222222222222',
      1n,
    );
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
        now: new Date('2026-09-19T04:00:00.000Z'),
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

  it('ignores a delayed failure after another worker takes the lease', async () => {
    const ready = await readyStudent('迟到失败');
    const tokenA = '44444444-4444-4444-4444-444444444444';
    await prisma.taskHorizonJob.update({
      where: { planId: ready.planId },
      data: {
        state: 'LEASED',
        availableAt: null,
        requestedGeneration: 2,
        processedGeneration: 0,
        claimedGeneration: 1,
        attemptCount: 0,
        leaseToken: tokenA,
        leaseOwner: 'worker-a',
        leaseStartedAt: new Date(Date.now() - 400_000),
        leaseExpiresAt: new Date(Date.now() - 1000),
        lastExecutorKey: 'HORIZON_WORKER_V1',
      },
    });
    const jobs = new TaskHorizonJobRepository(prisma as never);
    await jobs.reapExpired(20);
    await prisma.taskHorizonJob.update({
      where: { planId: ready.planId },
      data: { availableAt: new Date(0) },
    });
    const claimed = (await jobs.claimReady(20, 60_000, 'worker-b')).filter((row) => row.planId === ready.planId);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.leaseToken).not.toBe(tokenA);
    const holder = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
    const observer = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
    await holder.connect();
    await observer.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT plan_id FROM task_horizon_jobs WHERE plan_id = $1 FOR UPDATE', [ready.planId]);
    const holderId = await backendPid(holder);
    const late = jobs.recordTechnicalFailure(ready.planId, 'OLD_WORKER', tokenA, 1n);
    const overlap = await waitForWaiterOnHolder(observer, holderId, 'old failure waits on new lease');
    expect(overlap.holder_pid ?? holderId).toBe(holderId);
    await holder.query('ROLLBACK');
    await late;
    const after = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    expect(after.leaseToken).toBe(claimed[0]!.leaseToken);
    expect(after.state).toBe('LEASED');
    expect(after.attemptCount).toBe(0);
    await prisma.$transaction((tx) =>
      jobs.completeSuccess(tx, {
        planId: ready.planId,
        leaseToken: claimed[0]!.leaseToken,
        claimedGeneration: claimed[0]!.claimedGeneration,
        timezone: 'Asia/Shanghai',
        now: new Date('2026-09-21T15:50:00.000Z'),
        successLocalDate: '2026-09-21',
        insertedCount: 1,
        restoredCount: 0,
      }),
    );
    const done = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    expect(done.state).toBe('READY');
    expect(done.lastOutcome).toBe('GENERATED');
    await holder.end();
    await observer.end();
  });

  it('keeps FAILED through pause resume withdraw and only explicit requeue lifts it', async () => {
    const ready = await readyStudent('失败不复活');
    await prisma.taskHorizonJob.update({
      where: { planId: ready.planId },
      data: {
        state: 'FAILED',
        stateReason: 'RETRY_EXHAUSTED',
        availableAt: null,
        attemptCount: 8,
        leaseToken: null,
        leaseOwner: null,
        leaseStartedAt: null,
        leaseExpiresAt: null,
        claimedGeneration: null,
        lastOutcome: 'FAILED',
        lastErrorCode: 'TEST_FAIL',
      },
    });
    const plan = await prisma.studyPlan.findUniqueOrThrow({ where: { id: ready.planId } });
    const paused = await agent()
      .patch(`/v1/students/${ready.student.id}/plans/${ready.planId}`)
      .set(writeHeaders(ready.cookies))
      .send({ action: 'PAUSE', expectedVersion: plan.version });
    expect(paused.status).toBe(200);
    const afterPause = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    expect(afterPause.state).toBe('FAILED');
    expect(afterPause.stateReason).toBe('RETRY_EXHAUSTED');
    expect(afterPause.attemptCount).toBe(8);
    const resumed = await agent()
      .patch(`/v1/students/${ready.student.id}/plans/${ready.planId}`)
      .set(writeHeaders(ready.cookies))
      .send({ action: 'RESUME', expectedVersion: paused.body.version });
    expect(resumed.status).toBe(200);
    const afterResume = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    expect(afterResume.state).toBe('FAILED');
    expect(afterResume.attemptCount).toBe(8);

    const consent = await prisma.consentRecord.findFirstOrThrow({
      where: { studentProfileId: ready.student.id, withdrawnAt: null, supersededAt: null },
    });
    const withdrawn = await agent()
      .post(`/v1/students/${ready.student.id}/consents/${consent.id}/withdraw`)
      .set(writeHeaders(ready.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdrawn.status).toBeLessThan(300);
    const afterWithdraw = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    expect(afterWithdraw.state).toBe('FAILED');
    const docs = await agent()
      .get('/v1/consent-documents?ageBand=UNDER_14')
      .set('Origin', ORIGIN)
      .set('Cookie', ready.cookies.header());
    const latest = await agent().get(`/v1/students/${ready.student.id}`).set('Cookie', ready.cookies.header());
    const granted = await agent()
      .post(`/v1/students/${ready.student.id}/consents`)
      .set(writeHeaders(ready.cookies))
      .send({
        expectedStudentVersion: latest.body.version,
        acceptances: [{ policyKey: docs.body.policyKey, version: docs.body.version }],
      });
    expect(granted.status).toBeLessThan(300);
    const afterGrant = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    expect(afterGrant.state).toBe('FAILED');
    expect(afterGrant.attemptCount).toBe(8);
    await prisma.studentProfile.update({
      where: { id: ready.student.id },
      data: { status: 'ACTIVE' },
    });

    const jobs = new TaskHorizonJobRepository(prisma as never);
    expect(await jobs.requeueFailed(ready.planId, HORIZON_REQUEUE_REASON)).toBe('OK');
    const requeued = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    expect(requeued.state).toBe('READY');
    expect(requeued.attemptCount).toBe(0);
    await prisma.taskOccurrence.deleteMany({
      where: { series: { planId: ready.planId }, status: 'PLANNED' },
    });
    await wakeJob(ready.planId);
    const ran = await runWorkerOnce();
    expect(ran.processed).toBeGreaterThan(0);
    const generated = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    expect(generated.lastOutcome).toBe('GENERATED');
  });

  it('exits 3 for a missing requeue plan and keeps other CLI codes', async () => {
    async function runWorkerCli(args: string[]) {
      const child = spawn(
        'pnpm',
        ['exec', 'nest', 'start', '--entryFile', 'horizon-worker/main', '--', ...args],
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
      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`worker cli exceeded 45s for ${args.join(' ')}`));
        }, 45_000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code ?? 1);
        });
      });
    }
    expect(
      await runWorkerCli([
        '--requeue-failed=00000000-0000-4000-8000-000000000099',
        '--reason=OPERATOR_RETRY_AFTER_DIAGNOSIS',
      ]),
    ).toBe(3);
    expect(
      await runWorkerCli([
        '--requeue-failed=00000000-0000-4000-8000-000000000099',
        '--reason=WRONG',
      ]),
    ).toBe(2);
    const ready = await readyStudent('退出码冲突');
    expect(
      await runWorkerCli([
        `--requeue-failed=${ready.planId}`,
        '--reason=OPERATOR_RETRY_AFTER_DIAGNOSIS',
      ]),
    ).toBe(4);
  });

  it('schedules the next review from the locked database clock', async () => {
    const ready = await readyStudent('跨日时钟');
    const jobs = new TaskHorizonJobRepository(prisma as never);
    const lockedNow = new Date('2026-09-21T15:50:00.000Z');
    await prisma.taskHorizonJob.update({
      where: { planId: ready.planId },
      data: {
        state: 'LEASED',
        availableAt: null,
        requestedGeneration: 1,
        processedGeneration: 0,
        claimedGeneration: 1,
        leaseToken: '55555555-5555-5555-5555-555555555555',
        leaseOwner: 'clock',
        leaseStartedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        lastExecutorKey: 'HORIZON_WORKER_V1',
      },
    });
    await prisma.$transaction((tx) =>
      jobs.completeSuccess(tx, {
        planId: ready.planId,
        leaseToken: '55555555-5555-5555-5555-555555555555',
        claimedGeneration: 1n,
        timezone: 'Asia/Shanghai',
        now: lockedNow,
        successLocalDate: '2026-09-21',
        insertedCount: 1,
        restoredCount: 0,
      }),
    );
    const job = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: ready.planId } });
    const expected = nextHorizonLocalReviewAt(lockedNow, 'Asia/Shanghai', ready.planId);
    const appClock = nextHorizonLocalReviewAt(new Date(), 'Asia/Shanghai', ready.planId);
    expect(job.availableAt?.toISOString()).toBe(expected.toISOString());
    expect(localDateInTimeZone(job.availableAt!, 'Asia/Shanghai')).toBe('2026-09-22');
    expect(appClock.getTime()).not.toBe(expected.getTime());
  });

  it('loads out-of-window occupants and revisions at the database and bounds reaping', async () => {
    const ready = await readyStudent('有界加载');
    const series = await prisma.taskSeries.findFirstOrThrow({ where: { planId: ready.planId } });
    const today = localDateInTimeZone(new Date(), 'Asia/Shanghai');
    const occupantKey = '2018-01-01';
    await prisma.taskOccurrence.deleteMany({
      where: { seriesId: series.id, occurrenceKey: today },
    });
    const template = await prisma.taskOccurrence.findFirstOrThrow({ where: { seriesId: series.id } });
    await prisma.taskOccurrence.create({
      data: {
        seriesId: series.id,
        occurrenceKey: occupantKey,
        originalLocalDate: occupantKey,
        scheduledLocalDate: today,
        timezoneSnapshot: template.timezoneSnapshot,
        status: 'PLANNED',
        nameSnapshot: template.nameSnapshot,
        subjectSnapshot: template.subjectSnapshot,
        completionStandardSnapshot: template.completionStandardSnapshot,
        durationMinutesSnapshot: template.durationMinutesSnapshot,
        stepsSnapshotJson: template.stepsSnapshotJson,
        gradeConfigId: template.gradeConfigId,
        gradeConfigVersionId: template.gradeConfigVersionId,
        stageCodeSnapshot: template.stageCodeSnapshot,
        schoolSystemCodeSnapshot: template.schoolSystemCodeSnapshot,
        gradeCodeSnapshot: template.gradeCodeSnapshot,
        gradeLabelSnapshot: template.gradeLabelSnapshot,
        termCodeSnapshot: template.termCodeSnapshot,
        catalogEntryKeySnapshot: template.catalogEntryKeySnapshot,
        contentRevisionNo: template.contentRevisionNo,
        scheduleRevisionNo: template.scheduleRevisionNo,
      },
    });
    const windowRevisionFrom = addLocalDays(today, 1);
    const windowOcc = await prisma.taskOccurrence.findFirstOrThrow({
      where: { seriesId: series.id, occurrenceKey: windowRevisionFrom },
    });
    const cutoffAdj = await prisma.planAdjustment.create({
      data: {
        planId: ready.planId,
        seriesId: series.id,
        occurrenceId: (await prisma.taskOccurrence.findFirstOrThrow({
          where: { seriesId: series.id, occurrenceKey: occupantKey },
        })).id,
        reasonCode: 'SERIES_FUTURE_CONTENT_CHANGED',
        payloadJson: '{"name":"切点前名称"}',
      },
    });
    const windowAdj = await prisma.planAdjustment.create({
      data: {
        planId: ready.planId,
        seriesId: series.id,
        occurrenceId: windowOcc.id,
        reasonCode: 'SERIES_FUTURE_CONTENT_CHANGED',
        payloadJson: '{"name":"窗口内名称"}',
      },
    });
    await prisma.$transaction(async (tx) => {
      await tx.taskSeriesRevision.create({
        data: {
          taskSeriesId: series.id,
          revisionNo: 2,
          changeKind: 'CONTENT',
          effectiveFromOccurrenceKey: occupantKey,
          name: '切点前名称',
          subject: template.subjectSnapshot,
          completionStandard: template.completionStandardSnapshot,
          durationMinutes: template.durationMinutesSnapshot,
          stepsJson: template.stepsSnapshotJson,
          sourceAdjustmentId: cutoffAdj.id,
        },
      });
      await tx.taskSeriesRevision.create({
        data: {
          taskSeriesId: series.id,
          revisionNo: 3,
          changeKind: 'CONTENT',
          effectiveFromOccurrenceKey: windowRevisionFrom,
          name: '窗口内名称',
          subject: template.subjectSnapshot,
          completionStandard: template.completionStandardSnapshot,
          durationMinutes: template.durationMinutesSnapshot,
          stepsJson: template.stepsSnapshotJson,
          sourceAdjustmentId: windowAdj.id,
        },
      });
      await tx.taskSeries.update({
        where: { id: series.id },
        data: { version: 3 },
      });
    });
    const core = new TaskHorizonCoreService();
    const loaded = await prisma.$transaction((tx) =>
      core.loadPlanGraph(tx, ready.planId, new Date(), 'Asia/Shanghai'),
    );
    expect(loaded.failed).toBeUndefined();
    const graphSeries = loaded.plan!.series.find((item) => item.id === series.id);
    expect(graphSeries?.occurrences.some((row) => row.occurrenceKey === occupantKey && row.scheduledLocalDate === today)).toBe(true);
    expect(graphSeries?.revisions?.some((row) => row.revisionNo === 2 && row.name === '切点前名称')).toBe(true);
    expect(graphSeries?.revisions?.some((row) => row.revisionNo === 3 && row.name === '窗口内名称')).toBe(true);
    const studentRow = await prisma.studentProfile.findUniqueOrThrow({ where: { id: ready.student.id } });
    const result = await prisma.$transaction((tx) =>
      core.reconcilePlanLocked(tx, {
        student: {
          id: studentRow.id,
          timezone: studentRow.timezone,
          stageCode: studentRow.stageCode!,
          schoolSystemCode: studentRow.schoolSystemCode!,
          gradeCode: studentRow.gradeCode!,
          gradeLabel: studentRow.gradeLabel!,
          termCode: studentRow.termCode!,
          gradeConfigId: studentRow.gradeConfigId!,
          gradeConfigVersionId: studentRow.gradeConfigVersionId!,
        },
        plan: loaded.plan!,
        now: new Date(),
      }),
    );
    expect(result.blocked?.reason).toBe('DATE_OCCUPIED');

    const jobs = new TaskHorizonJobRepository(prisma as never);
    await jobs.reapExpired(20);
    const extraPlan = await prisma.studyPlan.create({
      data: {
        studentProfileId: ready.student.id,
        status: 'ACTIVE',
        origin: 'STUDENT',
        importedContentJson: '[]',
        timezoneSnapshot: 'Asia/Shanghai',
      },
    });
    const extraTwo = await prisma.studyPlan.create({
      data: {
        studentProfileId: ready.student.id,
        status: 'ACTIVE',
        origin: 'STUDENT',
        importedContentJson: '[]',
        timezoneSnapshot: 'Asia/Shanghai',
      },
    });
    for (const planId of [extraPlan.id, extraTwo.id]) {
      await prisma.taskHorizonJob.update({
        where: { planId },
        data: {
          state: 'LEASED',
          availableAt: null,
          claimedGeneration: 1,
          leaseToken: randomUUID(),
          leaseOwner: 'expired',
          leaseStartedAt: new Date(Date.now() - 400_000),
          leaseExpiresAt: new Date(Date.now() - 1000),
          lastExecutorKey: 'HORIZON_WORKER_V1',
        },
      });
    }
    expect(await jobs.reapExpired(1)).toBe(1);
    const leftover = await prisma.taskHorizonJob.count({
      where: { planId: { in: [extraPlan.id, extraTwo.id] }, state: 'LEASED' },
    });
    expect(leftover).toBe(1);

    const over = await prisma.studyPlan.create({
      data: {
        studentProfileId: ready.student.id,
        status: 'ACTIVE',
        origin: 'STUDENT',
        importedContentJson: '[]',
        timezoneSnapshot: 'Asia/Shanghai',
      },
    });
    const overSeries = await prisma.taskSeries.create({
      data: {
        planId: over.id,
        name: series.name,
        subject: series.subject,
        completionStandard: series.completionStandard,
        durationMinutes: series.durationMinutes,
        stepsJson: series.stepsJson,
        repeatKind: 'ONCE',
        startLocalDate: occupantKey,
        endLocalDate: occupantKey,
        effectiveFromLocalDate: occupantKey,
        effectiveToLocalDate: occupantKey,
        ongoing: false,
      },
    });
    const parent = await prisma.taskOccurrence.create({
      data: {
        seriesId: overSeries.id,
        occurrenceKey: occupantKey,
        originalLocalDate: occupantKey,
        scheduledLocalDate: occupantKey,
        timezoneSnapshot: template.timezoneSnapshot,
        status: 'CANCELLED',
        cancelReason: 'SPLIT',
        nameSnapshot: template.nameSnapshot,
        subjectSnapshot: template.subjectSnapshot,
        completionStandardSnapshot: template.completionStandardSnapshot,
        durationMinutesSnapshot: template.durationMinutesSnapshot,
        stepsSnapshotJson: template.stepsSnapshotJson,
        gradeConfigId: template.gradeConfigId,
        gradeConfigVersionId: template.gradeConfigVersionId,
        stageCodeSnapshot: template.stageCodeSnapshot,
        schoolSystemCodeSnapshot: template.schoolSystemCodeSnapshot,
        gradeCodeSnapshot: template.gradeCodeSnapshot,
        gradeLabelSnapshot: template.gradeLabelSnapshot,
        termCodeSnapshot: template.termCodeSnapshot,
        catalogEntryKeySnapshot: template.catalogEntryKeySnapshot,
      },
    });
    await prisma.$executeRaw`
      INSERT INTO task_occurrences (
        id, series_id, occurrence_key, original_local_date, scheduled_local_date, timezone_snapshot,
        status, name_snapshot, subject_snapshot, completion_standard_snapshot, duration_minutes_snapshot,
        steps_snapshot_json, grade_config_id, grade_config_version_id, stage_code_snapshot,
        school_system_code_snapshot, grade_code_snapshot, grade_label_snapshot, term_code_snapshot,
        catalog_entry_key_snapshot, source_occurrence_id, version, content_revision_no, schedule_revision_no,
        created_at, updated_at
      )
      SELECT gen_random_uuid(), ${overSeries.id}::uuid,
             to_char(DATE '2000-01-02' + g::int, 'YYYY-MM-DD'),
             to_char(DATE '2000-01-02' + g::int, 'YYYY-MM-DD'),
             to_char(DATE '2000-01-02' + g::int, 'YYYY-MM-DD'),
             ${template.timezoneSnapshot},
             'PLANNED',
             ${template.nameSnapshot},
             ${template.subjectSnapshot},
             ${template.completionStandardSnapshot},
             ${template.durationMinutesSnapshot},
             ${template.stepsSnapshotJson},
             ${template.gradeConfigId}::uuid,
             ${template.gradeConfigVersionId}::uuid,
             ${template.stageCodeSnapshot},
             ${template.schoolSystemCodeSnapshot},
             ${template.gradeCodeSnapshot},
             ${template.gradeLabelSnapshot},
             ${template.termCodeSnapshot},
             ${template.catalogEntryKeySnapshot},
             ${parent.id}::uuid,
             1, 1, 1, clock_timestamp(), clock_timestamp()
        FROM generate_series(0, 5000) AS g
    `;
    const overLoaded = await prisma.$transaction((tx) =>
      core.loadPlanGraph(tx, over.id, new Date(), 'Asia/Shanghai'),
    );
    expect(overLoaded.failed?.reason).toBe('SCOPE_LIMIT');
  });

  it('exits 2 from the public command when worker configuration is invalid', async () => {
    await ensurePublicWorkerDist();
    const invalid = await spawnPublicWorker(['--status'], { HORIZON_WORKER_LEASE_MS: '1' });
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toMatch(/HORIZON_WORKER_(RENEW_MS|LEASE_MS)/);
    expect(invalid.stderr).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(invalid.stderr).not.toMatch(/DATABASE_URL=/);
    const missing = await spawnPublicWorker([
      '--requeue-failed=00000000-0000-4000-8000-000000000099',
      '--reason=OPERATOR_RETRY_AFTER_DIAGNOSIS',
    ]);
    expect(missing.code).toBe(3);
    const badReason = await spawnPublicWorker([
      '--requeue-failed=00000000-0000-4000-8000-000000000099',
      '--reason=WRONG',
    ]);
    expect(badReason.code).toBe(2);
    const ready = await readyStudent('公开退出码冲突');
    const conflict = await spawnPublicWorker([
      `--requeue-failed=${ready.planId}`,
      '--reason=OPERATOR_RETRY_AFTER_DIAGNOSIS',
    ]);
    expect(conflict.code).toBe(4);
  }, 90_000);

  it('does not claim more jobs after the monotonic budget even if the wall clock rewinds', async () => {
    const ready = await readyStudent('单调预算');
    const extras = [];
    for (let index = 0; index < 2; index += 1) {
      extras.push(
        await prisma.studyPlan.create({
          data: {
            studentProfileId: ready.student.id,
            status: 'ACTIVE',
            origin: 'STUDENT',
            importedContentJson: '[]',
            timezoneSnapshot: 'Asia/Shanghai',
          },
        }),
      );
    }
    const planIds = [ready.planId, extras[0]!.id, extras[1]!.id];
    await parkOtherReadyJobs(planIds);
    for (const planId of planIds) {
      await wakeJob(planId);
    }
    const previousConcurrency = process.env.HORIZON_WORKER_CONCURRENCY;
    const previousCycle = process.env.HORIZON_WORKER_MAX_JOBS_PER_CYCLE;
    process.env.HORIZON_WORKER_CONCURRENCY = '1';
    process.env.HORIZON_WORKER_MAX_JOBS_PER_CYCLE = '1';
    const wallNow = Date.now.bind(Date);
    let rewound = wallNow();
    Date.now = () => {
      rewound -= 10_000;
      return rewound;
    };
    const claim = vi.spyOn(TaskHorizonJobRepository.prototype, 'claimReady');
    const ctx = await Test.createTestingModule({ imports: [HorizonWorkerModule] }).compile();
    try {
      const worker = ctx.get(HorizonWorkerService);
      expect(worker.config.concurrency).toBe(1);
      expect(worker.config.maxJobsPerCycle).toBe(1);
      const result = await worker.runOnce(10, 1);
      expect(result.processed).toBe(1);
      expect(claim.mock.calls).toHaveLength(1);
      const finished = await prisma.taskHorizonJob.count({
        where: { planId: { in: planIds }, lastOutcome: { not: null } },
      });
      expect(finished).toBe(1);
      const leftover = await prisma.taskHorizonJob.count({
        where: { planId: { in: planIds }, lastOutcome: null },
      });
      expect(leftover).toBe(2);
    } finally {
      Date.now = wallNow;
      claim.mockRestore();
      await ctx.close();
      if (previousConcurrency === undefined) {
        delete process.env.HORIZON_WORKER_CONCURRENCY;
      } else {
        process.env.HORIZON_WORKER_CONCURRENCY = previousConcurrency;
      }
      if (previousCycle === undefined) {
        delete process.env.HORIZON_WORKER_MAX_JOBS_PER_CYCLE;
      } else {
        process.env.HORIZON_WORKER_MAX_JOBS_PER_CYCLE = previousCycle;
      }
    }
  });

  it('fails oversized plans as SCOPE_LIMIT through the public worker and keeps a later lease', async () => {
    const ready = await readyStudent('公开超限');
    const overId = await plantOversizedPlan(ready.student.id);
    const beforeOcc = await prisma.taskOccurrence.count({ where: { series: { planId: overId } } });
    expect(beforeOcc).toBe(5002);
    const beforeAdj = await prisma.planAdjustment.count({ where: { planId: overId } });
    const beforeJob = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: overId } });
    expect(beforeJob.attemptCount).toBe(0);
    await parkOtherReadyJobs([overId]);
    await wakeJob(overId);
    await ensurePublicWorkerDist();
    const oversized = await spawnPublicWorker(['--once', '--max-jobs=5', '--max-ms=60000'], {}, 90_000);
    expect(oversized.code).toBe(0);
    expect(oversized.stderr).not.toMatch(/postgres(?:ql)?:\/\//i);
    const failed = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: overId } });
    expect(failed.state).toBe('FAILED');
    expect(failed.stateReason).toBe('SCOPE_LIMIT');
    expect(failed.lastOutcome).toBe('FAILED');
    expect(failed.lastErrorCode).toBe('SCOPE_LIMIT');
    expect(failed.attemptCount).toBe(0);
    expect(await prisma.taskOccurrence.count({ where: { series: { planId: overId } } })).toBe(beforeOcc);
    expect(await prisma.planAdjustment.count({ where: { planId: overId } })).toBe(beforeAdj);

    const lateReady = await readyStudent('超限迟到');
    const lateId = await plantOversizedPlan(lateReady.student.id);
    const tokenA = '66666666-6666-6666-6666-666666666666';
    await prisma.taskHorizonJob.update({
      where: { planId: lateId },
      data: {
        state: 'LEASED',
        availableAt: null,
        requestedGeneration: 2,
        processedGeneration: 0,
        claimedGeneration: 1,
        attemptCount: 0,
        leaseToken: tokenA,
        leaseOwner: 'worker-a',
        leaseStartedAt: new Date(Date.now() - 400_000),
        leaseExpiresAt: new Date(Date.now() - 1000),
        lastExecutorKey: 'HORIZON_WORKER_V1',
      },
    });
    const jobs = new TaskHorizonJobRepository(prisma as never);
    await jobs.reapExpired(20);
    await prisma.taskHorizonJob.update({
      where: { planId: lateId },
      data: { availableAt: new Date(0) },
    });
    const claimed = (await jobs.claimReady(20, 60_000, 'worker-b')).filter((row) => row.planId === lateId);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.leaseToken).not.toBe(tokenA);
    const holder = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
    const observer = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
    await holder.connect();
    await observer.connect();
    const ctx = await Test.createTestingModule({ imports: [HorizonWorkerModule] }).compile();
    const worker = ctx.get(HorizonWorkerService);
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT plan_id FROM task_horizon_jobs WHERE plan_id = $1 FOR UPDATE', [lateId]);
      const holderId = await backendPid(holder);
      const late = (worker as unknown as WorkerInternals).executeClaimed({
        planId: lateId,
        leaseToken: tokenA,
        claimedGeneration: 1n,
        requestedGeneration: 2n,
        processedGeneration: 0n,
        leaseExpiresAt: new Date(Date.now() - 1000),
      });
      const overlap = await waitForWaiterOnHolder(observer, holderId, 'old scope-limit waits on new lease');
      expect(overlap.holder_pid ?? holderId).toBe(holderId);
      await holder.query('ROLLBACK');
      await late;
      const after = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: lateId } });
      expect(after.leaseToken).toBe(claimed[0]!.leaseToken);
      expect(after.state).toBe('LEASED');
      expect(after.attemptCount).toBe(0);
      await (worker as unknown as WorkerInternals).executeClaimed(claimed[0]!);
      const done = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: lateId } });
      expect(done.state).toBe('FAILED');
      expect(done.stateReason).toBe('SCOPE_LIMIT');
      expect(done.attemptCount).toBe(0);
    } finally {
      await ctx.close();
      await holder.end();
      await observer.end();
    }

    const normal = await readyStudent('公开正常生成');
    await prisma.taskOccurrence.deleteMany({
      where: { series: { planId: normal.planId }, status: 'PLANNED' },
    });
    await parkOtherReadyJobs([normal.planId]);
    await wakeJob(normal.planId);
    const generated = await spawnPublicWorker(['--once', '--max-jobs=5', '--max-ms=20000']);
    expect(generated.code).toBe(0);
    const afterNormal = await prisma.taskHorizonJob.findUniqueOrThrow({ where: { planId: normal.planId } });
    expect(afterNormal.lastOutcome).toBe('GENERATED');
    expect(
      await prisma.taskOccurrence.count({
        where: { series: { planId: normal.planId }, status: 'PLANNED' },
      }),
    ).toBeGreaterThan(0);
  }, 180_000);
});
