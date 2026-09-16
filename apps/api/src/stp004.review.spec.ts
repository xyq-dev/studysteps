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
import { StudentsService } from './students/students.service';
import { PolicyPublishService } from './students/policy-publish.service';
import { sha256Hex } from './common/crypto';
import { hasIsolatedPostgres, loadStp004Env } from './test/load-stp004-env';

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

describe.skipIf(!hasIsolatedPostgres)('STP 004 Codex review counterexamples 1-8', () => {
  let app: INestApplication;
  let inbox: TestAuthDelivery;
  let students: StudentsService;
  let publisher: PolicyPublishService;
  const prisma = new PrismaClient({ datasourceUrl: connectionString });

  beforeAll(async () => {
    loadStp004Env();
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new HttpErrorFilter());
    await app.init();
    inbox = app.get(TestAuthDelivery);
    students = app.get(StudentsService);
    publisher = app.get(PolicyPublishService);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  function agent() {
    return request(app.getHttpServer());
  }

  function freshPhone() {
    return `13800138${String(200 + Math.floor(Math.random() * 80)).padStart(3, '0')}`;
  }

  function writeHeaders(cookies: CookieJar, idempotencyKey = randomUUID()) {
    return {
      Origin: ORIGIN,
      Cookie: cookies.header(),
      'X-CSRF-Token': cookies.get('stp_csrf') ?? '',
      'Idempotency-Key': idempotencyKey,
    };
  }

  async function signIn(phone = freshPhone(), installationId = randomUUID()) {
    const cookies = new CookieJar();
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
    expect(delivered).toMatch(/^\d{6}$/);
    const sessionRes = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: codeRes.body.challengeId,
        code: delivered,
        device: { installationId, label: 'review' },
      });
    expect(sessionRes.status).toBe(201);
    cookies.apply(sessionRes);
    return { cookies, installationId, phone };
  }

  async function createStudent(cookies: CookieJar, nickname: string, key = randomUUID()) {
    const docs = await agent().get('/v1/consent-documents?ageBand=UNDER_14').set('Cookie', cookies.header());
    const created = await agent()
      .post('/v1/students')
      .set(writeHeaders(cookies, key))
      .send({
        profile: { nickname, avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
        ageConfirmation: { band: 'UNDER_14', source: 'GUARDIAN_DECLARATION' },
        consentAcceptances: [{ policyKey: docs.body.policyKey, version: docs.body.version }],
      });
    if (created.status !== 201) {
      throw new Error(`create student ${created.status} ${JSON.stringify(created.body)}`);
    }
    return {
      studentId: created.body.profile.id as string,
      version: created.body.profile.version as number,
      policyKey: docs.body.policyKey as string,
      policyVersion: docs.body.version as string,
      key,
    };
  }

  async function consumePairing(cookies: CookieJar, studentId: string, label: string) {
    const issued = await agent().post(`/v1/students/${studentId}/pairings`).set(writeHeaders(cookies)).send({});
    expect(issued.status).toBe(201);
    const installationId = randomUUID();
    const studentCookies = new CookieJar();
    const consumed = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: issued.body.pairingId,
        code: issued.body.code,
        device: { installationId, label },
      });
    expect(consumed.status).toBe(201);
    studentCookies.apply(consumed);
    return { studentCookies, installationId };
  }

  async function sessionByCookie(cookies: CookieJar) {
    return prisma.deviceSession.findUniqueOrThrow({
      where: { credentialDigest: sha256Hex(cookies.get('stp_session') ?? '') },
    });
  }

  it('1 withdraw of current required consent restricts even when an old-band consent remains', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '跨段撤回');
    const latest = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', auth.cookies.header());
    const patched = await agent()
      .patch(`/v1/students/${student.studentId}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'AGE',
        expectedVersion: latest.body.version,
        band: 'AGE_14_TO_17',
        source: 'GUARDIAN_DECLARATION',
      });
    expect(patched.body.status).toBe('RESTRICTED');
    const minorDocs = await agent()
      .get('/v1/consent-documents?ageBand=AGE_14_TO_17')
      .set('Cookie', auth.cookies.header());
    const granted = await agent()
      .post(`/v1/students/${student.studentId}/consents`)
      .set(writeHeaders(auth.cookies))
      .send({
        expectedStudentVersion: patched.body.version,
        acceptances: [{ policyKey: minorDocs.body.policyKey, version: minorDocs.body.version }],
      });
    expect(granted.status).toBeLessThan(300);
    expect(granted.body.status).toBe('ONBOARDING');
    const second = await consumePairing(auth.cookies, student.studentId, 'review-1-new');
    const consents = await agent()
      .get(`/v1/students/${student.studentId}/consents`)
      .set('Cookie', auth.cookies.header());
    const minor = consents.body.items.find(
      (item: { current: boolean; policyKey: string }) =>
        item.current && item.policyKey === 'TEST_MINOR_CORE_SERVICE',
    );
    expect(minor).toBeDefined();
    const childStillPresent = consents.body.items.some(
      (item: { policyKey: string; withdrawnAt: string | null }) =>
        item.policyKey === 'TEST_CHILD_CORE_SERVICE' && item.withdrawnAt === null,
    );
    expect(childStillPresent).toBe(true);
    const withdrawn = await agent()
      .post(`/v1/students/${student.studentId}/consents/${minor.id}/withdraw`)
      .set(writeHeaders(auth.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdrawn.status).toBeLessThan(300);
    expect(withdrawn.body.status).toBe('RESTRICTED');
    const stale = await agent()
      .get(`/v1/students/${student.studentId}`)
      .set('Cookie', second.studentCookies.header());
    expect(stale.status).toBe(401);
    const remaining = await prisma.consentRecord.count({
      where: { studentProfileId: student.studentId, withdrawnAt: null, supersededAt: null },
    });
    expect(remaining).toBeGreaterThan(0);
  });

  it('2 student session is 401 after policy publish without a new grant', async () => {
    const baseline = await prisma.consentPolicy.findUniqueOrThrow({
      where: { policyKey_locale: { policyKey: 'TEST_CHILD_CORE_SERVICE', locale: 'zh-CN' } },
    });
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '政策升级');
    const consumed = await consumePairing(auth.cookies, student.studentId, 'review-2');
    const row = await sessionByCookie(consumed.studentCookies);
    const stale = new Date(Date.now() - 90_000);
    await prisma.deviceSession.update({ where: { id: row.id }, data: { lastSeenAt: stale } });
    try {
      await publisher.publishNext(
        'TEST_CHILD_CORE_SERVICE',
        `review-${randomUUID().slice(0, 8)}`,
        '审查用政策升级正文（非正式）',
      );
      const denied = await agent()
        .get(`/v1/students/${student.studentId}`)
        .set('Cookie', consumed.studentCookies.header());
      expect(denied.status).toBe(401);
      expect(denied.body.code).toBe('AUTH_SESSION_INVALID');
      const after = await prisma.deviceSession.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.lastSeenAt!.getTime()).toBe(stale.getTime());
      const guardian = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', auth.cookies.header());
      expect(guardian.status).toBeLessThan(300);
    } finally {
      await prisma.consentPolicy.update({
        where: { id: baseline.id },
        data: { currentDocumentVersionId: baseline.currentDocumentVersionId },
      });
    }
  });

  it('4 leftover session with stale authVersion fails; a new session after bump works', async () => {
    const first = await signIn();
    const oldRow = await sessionByCookie(first.cookies);
    await prisma.account.update({
      where: { id: oldRow.accountId! },
      data: { authVersion: { increment: 1 } },
    });
    const denied = await agent().get('/v1/students').set('Cookie', first.cookies.header());
    expect(denied.status).toBe(401);
    const second = await signIn(first.phone, randomUUID());
    const created = await createStudent(second.cookies, '新版本会话');
    const mine = await agent().get(`/v1/students/${created.studentId}`).set('Cookie', second.cookies.header());
    expect(mine.status).toBeLessThan(300);
    const issued = await sessionByCookie(second.cookies);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: issued.accountId! } });
    expect(issued.accountAuthVersionAtIssue).toBe(account.authVersion);
    expect(issued.accountAuthVersionAtIssue).toBeGreaterThan(1);
  });

  it('5 replaying create after GuardianLink revoke does not leak the profile', async () => {
    const auth = await signIn();
    const key = randomUUID();
    const student = await createStudent(auth.cookies, '重放泄露', key);
    const session = await sessionByCookie(auth.cookies);
    await students.revokeGuardianLink(session.accountId!, student.studentId, 'TEST_REVOKE');
    const replayed = await agent()
      .post('/v1/students')
      .set(writeHeaders(auth.cookies, key))
      .send({
        profile: { nickname: '重放泄露', avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
        ageConfirmation: { band: 'UNDER_14', source: 'GUARDIAN_DECLARATION' },
        consentAcceptances: [{ policyKey: student.policyKey, version: student.policyVersion }],
      });
    expect(replayed.status).toBe(404);
    expect(replayed.body.code).toBe('RESOURCE_NOT_FOUND');
    const visible = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', auth.cookies.header());
    expect(visible.status).toBe(404);
  });

  it('6 invalid CSRF, authVersion failure, idle and revoked requests do not bump lastSeenAt', async () => {
    const auth = await signIn();
    await createStudent(auth.cookies, '心跳副作用');
    const row = await sessionByCookie(auth.cookies);
    const stale = new Date(Date.now() - 90_000);
    await prisma.deviceSession.update({
      where: { id: row.id },
      data: { lastSeenAt: stale, version: row.version },
    });
    const missingCsrf = await agent()
      .post('/v1/students')
      .set('Origin', ORIGIN)
      .set('Cookie', auth.cookies.header())
      .send({});
    expect(missingCsrf.status).toBe(400);
    const afterCsrf = await prisma.deviceSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterCsrf.lastSeenAt!.getTime()).toBe(stale.getTime());
    expect(afterCsrf.version).toBe(row.version);

    await prisma.account.update({
      where: { id: row.accountId! },
      data: { authVersion: { increment: 1 } },
    });
    const versionDenied = await agent().get('/v1/students').set('Cookie', auth.cookies.header());
    expect(versionDenied.status).toBe(401);
    const afterVersion = await prisma.deviceSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterVersion.lastSeenAt!.getTime()).toBe(stale.getTime());

    const idleAuth = await signIn();
    const idleRow = await sessionByCookie(idleAuth.cookies);
    const idleLastSeen = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await prisma.deviceSession.update({
      where: { id: idleRow.id },
      data: { lastSeenAt: idleLastSeen },
    });
    const idleDenied = await agent().get('/v1/students').set('Cookie', idleAuth.cookies.header());
    expect(idleDenied.status).toBe(401);
    const idleAfter = await prisma.deviceSession.findUniqueOrThrow({ where: { id: idleRow.id } });
    expect(idleAfter.lastSeenAt!.getTime()).toBe(idleLastSeen.getTime());

    const revokedAuth = await signIn();
    const revokedRow = await sessionByCookie(revokedAuth.cookies);
    const revokedStale = new Date(Date.now() - 90_000);
    await prisma.deviceSession.update({
      where: { id: revokedRow.id },
      data: { lastSeenAt: revokedStale, revokedAt: new Date(), revocationReasonCode: 'TEST' },
    });
    const revokedDenied = await agent().get('/v1/students').set('Cookie', revokedAuth.cookies.header());
    expect(revokedDenied.status).toBe(401);
    const revokedAfter = await prisma.deviceSession.findUniqueOrThrow({ where: { id: revokedRow.id } });
    expect(revokedAfter.lastSeenAt!.getTime()).toBe(revokedStale.getTime());
  });

  it('7 student session cannot read consent history or device metadata', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '学生越权读');
    const consumed = await consumePairing(auth.cookies, student.studentId, 'review-7');
    const self = await agent()
      .get(`/v1/students/${student.studentId}`)
      .set('Cookie', consumed.studentCookies.header());
    expect(self.status).toBeLessThan(300);
    const consents = await agent()
      .get(`/v1/students/${student.studentId}/consents`)
      .set('Cookie', consumed.studentCookies.header());
    expect(consents.status).toBe(403);
    expect(consents.body.code).toBe('SESSION_SCOPE_FORBIDDEN');
    const devices = await agent()
      .get(`/v1/students/${student.studentId}/device-sessions`)
      .set('Cookie', consumed.studentCookies.header());
    expect(devices.status).toBe(403);
    expect(devices.body.code).toBe('SESSION_SCOPE_FORBIDDEN');
  });

  it('DEL five-state list/404/401 and failures do not heartbeat', async () => {
    const auth = await signIn();
    const onboarding = await createStudent(auth.cookies, '五态在档');
    const active = await createStudent(auth.cookies, '五态活跃');
    const pending = await createStudent(auth.cookies, '五态待删');
    const deleted = await createStudent(auth.cookies, '五态已删');
    const restricted = await createStudent(auth.cookies, '五态受限');
    const pendingStudent = await consumePairing(auth.cookies, pending.studentId, 'del-pending');
    const restrictedStudent = await consumePairing(auth.cookies, restricted.studentId, 'del-restricted');
    await prisma.studentProfile.update({ where: { id: active.studentId }, data: { status: 'ACTIVE' } });
    await prisma.studentProfile.update({ where: { id: pending.studentId }, data: { status: 'DELETION_PENDING' } });
    await prisma.studentProfile.update({ where: { id: deleted.studentId }, data: { status: 'DELETED' } });
    await prisma.studentProfile.update({
      where: { id: restricted.studentId },
      data: { status: 'RESTRICTED', restrictedAt: new Date() },
    });
    const pendingRow = await sessionByCookie(pendingStudent.studentCookies);

    const listed = await agent().get('/v1/students').set('Cookie', auth.cookies.header());
    expect(listed.status).toBe(200);
    const ids = listed.body.items.map((item: { id: string; status: string }) => item.id);
    expect(ids).toEqual(expect.arrayContaining([onboarding.studentId, active.studentId, restricted.studentId]));
    expect(ids).not.toContain(pending.studentId);
    expect(ids).not.toContain(deleted.studentId);
    expect(listed.body.items.find((item: { id: string }) => item.id === active.studentId).status).toBe('ACTIVE');

    const guardianRestricted = await agent()
      .get(`/v1/students/${restricted.studentId}`)
      .set('Cookie', auth.cookies.header());
    expect(guardianRestricted.status).toBeLessThan(300);
    expect(guardianRestricted.body.status).toBe('RESTRICTED');

    const stale = new Date(Date.now() - 90_000);
    const listedGuardian = await sessionByCookie(auth.cookies);
    await prisma.deviceSession.update({
      where: { id: listedGuardian.id },
      data: { lastSeenAt: stale, version: listedGuardian.version },
    });
    await prisma.deviceSession.update({
      where: { id: pendingRow.id },
      data: { lastSeenAt: stale, version: pendingRow.version },
    });

    const pendingGet = await agent()
      .get(`/v1/students/${pending.studentId}`)
      .set('Cookie', auth.cookies.header());
    const missingGet = await agent()
      .get(`/v1/students/${randomUUID()}`)
      .set('Cookie', auth.cookies.header());
    expect(pendingGet.status).toBe(404);
    expect(pendingGet.body).toEqual(missingGet.body);
    const deletedGet = await agent()
      .get(`/v1/students/${deleted.studentId}`)
      .set('Cookie', auth.cookies.header());
    expect(deletedGet.status).toBe(404);
    expect(deletedGet.body.code).toBe(missingGet.body.code);

    const studentPending = await agent()
      .get(`/v1/students/${pending.studentId}`)
      .set('Cookie', pendingStudent.studentCookies.header());
    expect(studentPending.status).toBe(401);
    const studentRestricted = await agent()
      .get(`/v1/students/${restricted.studentId}`)
      .set('Cookie', restrictedStudent.studentCookies.header());
    expect(studentRestricted.status).toBe(401);
    const pairingDenied = await agent()
      .post(`/v1/students/${restricted.studentId}/pairings`)
      .set(writeHeaders(auth.cookies))
      .send({});
    expect(pairingDenied.status).toBe(403);

    const afterGuardian = await prisma.deviceSession.findUniqueOrThrow({ where: { id: listedGuardian.id } });
    expect(afterGuardian.lastSeenAt!.getTime()).toBe(stale.getTime());
    expect(afterGuardian.version).toBe(listedGuardian.version);
    const afterPending = await prisma.deviceSession.findUniqueOrThrow({ where: { id: pendingRow.id } });
    expect(afterPending.lastSeenAt!.getTime()).toBe(stale.getTime());
    expect(afterPending.version).toBe(pendingRow.version);
  });

  it('HB-1 success heartbeats inside the authorization tx; 400/401/403/404/409/422/429 do not', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '心跳');
    const row = await sessionByCookie(auth.cookies);
    const stale = new Date(Date.now() - 90_000);
    await prisma.deviceSession.update({
      where: { id: row.id },
      data: { lastSeenAt: stale, version: row.version },
    });
    const consumed = await consumePairing(auth.cookies, student.studentId, 'hb1-student');
    const ok = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', auth.cookies.header());
    expect(ok.status).toBeLessThan(300);
    const afterOk = await prisma.deviceSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterOk.lastSeenAt!.getTime()).toBeGreaterThan(stale.getTime());

    await prisma.deviceSession.update({
      where: { id: row.id },
      data: { lastSeenAt: stale, version: afterOk.version },
    });
    const bad400 = await agent()
      .patch(`/v1/students/${student.studentId}`)
      .set(writeHeaders(auth.cookies))
      .send({ kind: 'BASIC' });
    expect(bad400.status).toBe(400);
    const bad401 = await agent().get('/v1/students').set('Cookie', 'stp_session=missing');
    expect(bad401.status).toBe(401);
    const bad403 = await agent()
      .get(`/v1/students/${student.studentId}/consents`)
      .set('Cookie', consumed.studentCookies.header());
    expect(bad403.status).toBe(403);
    const bad404 = await agent().get(`/v1/students/${randomUUID()}`).set('Cookie', auth.cookies.header());
    expect(bad404.status).toBe(404);
    const bad409 = await agent()
      .patch(`/v1/students/${student.studentId}`)
      .set(writeHeaders(auth.cookies))
      .send({ kind: 'BASIC', expectedVersion: 999, nickname: '冲突' });
    expect(bad409.status).toBe(409);
    const adult = await agent()
      .patch(`/v1/students/${student.studentId}`)
      .set(writeHeaders(auth.cookies))
      .send({
        kind: 'AGE',
        expectedVersion: (await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.studentId } })).version,
        band: 'AGE_18_PLUS',
        source: 'GUARDIAN_DECLARATION',
      });
    expect(adult.status).toBe(422);
    const limited = await agent().post(`/v1/students/${student.studentId}/pairings`).set(writeHeaders(auth.cookies)).send({});
    expect(limited.status).toBe(429);
    const afterFail = await prisma.deviceSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterFail.lastSeenAt!.getTime()).toBe(stale.getTime());
    expect(afterFail.version).toBe(afterOk.version);
  });

  it('step-up code send requires CSRF and heartbeats; missing CSRF does not touch lastSeen', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '发码心跳');
    const consumed = await consumePairing(auth.cookies, student.studentId, 'hb-step-code');
    const row = await sessionByCookie(consumed.studentCookies);
    const stale = new Date(Date.now() - 90_000);
    await prisma.deviceSession.update({
      where: { id: row.id },
      data: { lastSeenAt: stale, version: row.version },
    });
    const denied = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .set('Cookie', consumed.studentCookies.header())
      .send({ purpose: 'GUARDIAN_STEP_UP', device: { installationId: consumed.installationId } });
    expect(denied.status).toBe(400);
    const afterDenied = await prisma.deviceSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterDenied.lastSeenAt!.getTime()).toBe(stale.getTime());
    expect(afterDenied.version).toBe(row.version);
    const sent = await agent()
      .post('/v1/auth/code')
      .set(writeHeaders(consumed.studentCookies))
      .send({ purpose: 'GUARDIAN_STEP_UP', device: { installationId: consumed.installationId } });
    expect(sent.status).toBeLessThan(300);
    const afterOk = await prisma.deviceSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterOk.lastSeenAt!.getTime()).toBeGreaterThan(stale.getTime());
  });

  it('first SIGN_IN challenge starts without identity and consume backfills lookup alias', async () => {
    const phone = freshPhone();
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
    const before = await prisma.authChallenge.findUniqueOrThrow({ where: { id: codeRes.body.challengeId } });
    expect(before.accountId).toBeNull();
    expect(before.authIdentityId).toBeNull();
    const delivered = inbox.read(`+86${phone.replace(/^\+86/, '')}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    const sessionRes = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: codeRes.body.challengeId,
        code: delivered,
        device: { installationId, label: 'first-login' },
      });
    expect(sessionRes.status).toBe(201);
    const after = await prisma.authChallenge.findUniqueOrThrow({ where: { id: codeRes.body.challengeId } });
    expect(after.accountId).toBeTruthy();
    expect(after.authIdentityId).toBeTruthy();
    const alias = await prisma.authIdentityLookup.findFirstOrThrow({
      where: { authIdentityId: after.authIdentityId! },
    });
    expect(after.destinationLookupKeyVersion).toBe(alias.lookupKeyVersion);
    expect(after.destinationLookupDigest).toBe(alias.subjectLookupDigest);
  });
});
