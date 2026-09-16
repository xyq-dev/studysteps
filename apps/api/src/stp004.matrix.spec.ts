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
import { sha256Hex } from './common/crypto';
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

  clone(): CookieJar {
    const copy = new CookieJar();
    for (const [key, value] of this.values) {
      copy.values.set(key, value);
    }
    return copy;
  }
}

describe.skipIf(shouldSkipStp004Isolation())('STP 004 in-phase acceptance matrix', () => {
  let app: INestApplication;
  let inbox: TestAuthDelivery;
  let students: StudentsService;
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
    students = app.get(StudentsService);
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
        device: { installationId, label: 'matrix' },
      });
    expect(sessionRes.status).toBe(201);
    cookies.apply(sessionRes);
    return { cookies, installationId, phone, challengeId: codeRes.body.challengeId as string, code: delivered };
  }

  async function createStudent(
    cookies: CookieJar,
    nickname: string,
    extra: Record<string, unknown> = {},
    education?: {
      stageCode: string;
      schoolSystemCode: string;
      gradeCode: string;
      gradeLabel: string;
      termCode: string;
    },
  ) {
    const docs = await agent().get('/v1/consent-documents?ageBand=UNDER_14').set('Cookie', cookies.header());
    const created = await agent()
      .post('/v1/students')
      .set(writeHeaders(cookies))
      .send({
        ...extra,
        profile: { nickname, avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
        ageConfirmation: { band: 'UNDER_14', source: 'GUARDIAN_DECLARATION' },
        education,
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
    };
  }

  async function enterStudent(cookies: CookieJar, studentId: string) {
    const entered = await agent()
      .post('/v1/auth/session')
      .set(writeHeaders(cookies))
      .send({ grantType: 'STUDENT_MODE', studentId });
    expect(entered.status).toBe(201);
    cookies.apply(entered);
    return cookies;
  }

  async function issuePairing(cookies: CookieJar, studentId: string, key = randomUUID()) {
    const issued = await agent().post(`/v1/students/${studentId}/pairings`).set(writeHeaders(cookies, key)).send({});
    expect(issued.status).toBe(201);
    return issued.body as { pairingId: string; code: string; secretState: string };
  }

  it('AGE-1 age-band change without new consent restricts and revokes student access', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '跨段', {}, {
      stageCode: 'primary',
      schoolSystemCode: 'liusan',
      gradeCode: 'g3',
      gradeLabel: '三年级',
      termCode: '2026-1',
    });
    const firstPairing = await issuePairing(auth.cookies, student.studentId);
    const consumed = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: firstPairing.pairingId,
        code: firstPairing.code,
        device: { installationId: randomUUID(), label: 'age1-student' },
      });
    expect(consumed.status).toBe(201);
    const studentCookies = new CookieJar();
    studentCookies.apply(consumed);
    await prisma.devicePairing.update({
      where: { id: firstPairing.pairingId },
      data: { createdAt: new Date(Date.now() - 31_000) },
    });
    const pairing = await issuePairing(auth.cookies, student.studentId);
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
    expect(patched.status).toBeLessThan(300);
    expect(patched.body.status).toBe('RESTRICTED');
    expect(patched.body.ageBand).toBe('AGE_14_TO_17');
    expect(patched.body.education.gradeCode).toBe('g3');
    expect(patched.body.education.gradeLabel).toBe('三年级');
    const stale = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', studentCookies.header());
    expect(stale.status).toBe(401);
    const blocked = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: pairing.pairingId,
        code: pairing.code,
        device: { installationId: randomUUID(), label: 'age1' },
      });
    expect(blocked.status).toBe(401);
    expect(blocked.body.code).toBe('PAIRING_INVALID');
    const stored = await prisma.devicePairing.findUniqueOrThrow({ where: { id: pairing.pairingId } });
    expect(stored.revokedAt).toBeTruthy();
  });

  it('T10-2 student session cannot read a sibling archive', async () => {
    const auth = await signIn();
    const first = await createStudent(auth.cookies, '孩子甲');
    const second = await createStudent(auth.cookies, '孩子乙');
    await enterStudent(auth.cookies, first.studentId);
    const hidden = await agent().get(`/v1/students/${second.studentId}`).set('Cookie', auth.cookies.header());
    const missing = await agent().get(`/v1/students/${randomUUID()}`).set('Cookie', auth.cookies.header());
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
  });

  async function sessionByCookie(cookies: CookieJar) {
    return prisma.deviceSession.findUniqueOrThrow({
      where: { credentialDigest: sha256Hex(cookies.get('stp_session') ?? '') },
    });
  }

  it('T10-3 forged accountId or studentId in body does not change the server subject', async () => {
    const auth = await signIn();
    const other = await signIn();
    const authSession = await sessionByCookie(auth.cookies);
    const otherSession = await sessionByCookie(other.cookies);
    const created = await createStudent(auth.cookies, '主体不受伪造', {
      accountId: otherSession.accountId,
      studentId: randomUUID(),
    });
    const owned = await prisma.studentProfile.findUniqueOrThrow({ where: { id: created.studentId } });
    expect(owned.createdByAccountId).toBe(authSession.accountId);
    expect(owned.createdByAccountId).not.toBe(otherSession.accountId);
    const mine = await agent().get(`/v1/students/${created.studentId}`).set('Cookie', auth.cookies.header());
    expect(mine.status).toBeLessThan(300);
    const otherView = await agent().get(`/v1/students/${created.studentId}`).set('Cookie', other.cookies.header());
    expect(otherView.status).toBe(404);
    const foreignLink = await prisma.guardianLink.findFirst({
      where: { accountId: otherSession.accountId!, studentProfileId: created.studentId },
    });
    expect(foreignLink).toBeNull();
  });

  it('T10-4 cross-archive consent, pairing and device subresources are 404', async () => {
    const auth = await signIn();
    const first = await createStudent(auth.cookies, '资源甲');
    const second = await createStudent(auth.cookies, '资源乙');
    const consents = await agent().get(`/v1/students/${first.studentId}/consents`).set('Cookie', auth.cookies.header());
    const consentId = consents.body.items[0].id as string;
    const pairing = await issuePairing(auth.cookies, first.studentId);
    const consumed = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: pairing.pairingId,
        code: pairing.code,
        device: { installationId: randomUUID(), label: 't10-4' },
      });
    expect(consumed.status).toBe(201);
    const devices = await agent()
      .get(`/v1/students/${first.studentId}/device-sessions`)
      .set('Cookie', auth.cookies.header());
    const deviceId = devices.body.items.find((item: { scope: string }) => item.scope === 'STUDENT').id as string;
    const missing = randomUUID();
    const withdraw = await agent()
      .post(`/v1/students/${second.studentId}/consents/${consentId}/withdraw`)
      .set(writeHeaders(auth.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    const withdrawMissing = await agent()
      .post(`/v1/students/${second.studentId}/consents/${missing}/withdraw`)
      .set(writeHeaders(auth.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdraw.status).toBe(404);
    expect(withdrawMissing.status).toBe(404);
    expect(withdraw.body.code).toBe(withdrawMissing.body.code);
    const revokePairing = await agent()
      .post(`/v1/students/${second.studentId}/pairings/${pairing.pairingId}/revoke`)
      .set(writeHeaders(auth.cookies))
      .send({});
    const revokePairingMissing = await agent()
      .post(`/v1/students/${second.studentId}/pairings/${missing}/revoke`)
      .set(writeHeaders(auth.cookies))
      .send({});
    expect(revokePairing.status).toBe(404);
    expect(revokePairingMissing.status).toBe(404);
    expect(revokePairing.body.code).toBe(revokePairingMissing.body.code);
    const revokeDevice = await agent()
      .post(`/v1/students/${second.studentId}/device-sessions/${deviceId}/revoke`)
      .set(writeHeaders(auth.cookies))
      .send({ reasonCode: 'LOST_DEVICE' });
    const revokeDeviceMissing = await agent()
      .post(`/v1/students/${second.studentId}/device-sessions/${missing}/revoke`)
      .set(writeHeaders(auth.cookies))
      .send({ reasonCode: 'LOST_DEVICE' });
    expect(revokeDevice.status).toBe(404);
    expect(revokeDeviceMissing.status).toBe(404);
    expect(revokeDevice.body.code).toBe(revokeDeviceMissing.body.code);
  });

  it('T11-2 revokeGuardianLink invalidates only that student', async () => {
    const auth = await signIn();
    const first = await createStudent(auth.cookies, '撤销甲');
    const second = await createStudent(auth.cookies, '保留乙');
    const firstPairing = await issuePairing(auth.cookies, first.studentId);
    const firstConsumed = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: firstPairing.pairingId,
        code: firstPairing.code,
        device: { installationId: randomUUID(), label: 't11-2-a' },
      });
    expect(firstConsumed.status).toBe(201);
    const firstStudent = new CookieJar();
    firstStudent.apply(firstConsumed);
    const secondPairing = await issuePairing(auth.cookies, second.studentId);
    const secondConsumed = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: secondPairing.pairingId,
        code: secondPairing.code,
        device: { installationId: randomUUID(), label: 't11-2-b' },
      });
    expect(secondConsumed.status).toBe(201);
    const secondStudent = new CookieJar();
    secondStudent.apply(secondConsumed);
    await prisma.devicePairing.update({
      where: { id: firstPairing.pairingId },
      data: { createdAt: new Date(Date.now() - 31_000) },
    });
    const pairing = await issuePairing(auth.cookies, first.studentId);
    const guardian = await sessionByCookie(auth.cookies);
    await students.revokeGuardianLink(guardian.accountId!, first.studentId, 'TEST_LINK_REVOKE');
    const firstGone = await agent().get(`/v1/students/${first.studentId}`).set('Cookie', auth.cookies.header());
    const firstMissing = await agent().get(`/v1/students/${randomUUID()}`).set('Cookie', auth.cookies.header());
    expect(firstGone.status).toBe(404);
    expect(firstGone.body.code).toBe(firstMissing.body.code);
    const firstStudentStale = await agent().get(`/v1/students/${first.studentId}`).set('Cookie', firstStudent.header());
    expect(firstStudentStale.status).toBe(401);
    const secondOk = await agent().get(`/v1/students/${second.studentId}`).set('Cookie', auth.cookies.header());
    expect(secondOk.status).toBeLessThan(300);
    expect(secondOk.body.nickname).toBe('保留乙');
    const secondStudentOk = await agent().get(`/v1/students/${second.studentId}`).set('Cookie', secondStudent.header());
    expect(secondStudentOk.status).toBeLessThan(300);
    const consumed = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: pairing.pairingId,
        code: pairing.code,
        device: { installationId: randomUUID(), label: 't11-2' },
      });
    expect(consumed.status).toBe(401);
    expect(consumed.body.code).toBe('PAIRING_INVALID');
  });

  it('T11-4 re-grant does not revive the old student session', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '重授');
    const issued = await issuePairing(auth.cookies, student.studentId);
    const consumed = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: issued.pairingId,
        code: issued.code,
        device: { installationId: randomUUID(), label: 't11-4-old' },
      });
    expect(consumed.status).toBe(201);
    const oldStudent = new CookieJar();
    oldStudent.apply(consumed);
    const consents = await agent().get(`/v1/students/${student.studentId}/consents`).set('Cookie', auth.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const withdrawn = await agent()
      .post(`/v1/students/${student.studentId}/consents/${current.id}/withdraw`)
      .set(writeHeaders(auth.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdrawn.body.status).toBe('RESTRICTED');
    const latest = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', auth.cookies.header());
    const granted = await agent()
      .post(`/v1/students/${student.studentId}/consents`)
      .set(writeHeaders(auth.cookies))
      .send({
        expectedStudentVersion: latest.body.version,
        acceptances: [{ policyKey: student.policyKey, version: student.policyVersion }],
      });
    expect(granted.status).toBeLessThan(300);
    expect(granted.body.status).toBe('ONBOARDING');
    const stale = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', oldStudent.header());
    expect(stale.status).toBe(401);
    const renewed = auth.cookies.clone();
    await enterStudent(renewed, student.studentId);
    const fresh = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', renewed.header());
    expect(fresh.status).toBeLessThan(300);
  });

  it('AUTH-1 wrong, expired, replayed, cross-device and cross-purpose challenges fail with the same shape', async () => {
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
    const delivered = inbox.read(`+86${phone.replace(/^\+86/, '')}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    const sessionsBefore = await prisma.deviceSession.count();
    const wrong = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: codeRes.body.challengeId,
        code: delivered === '000000' ? '000001' : '000000',
        device: { installationId },
      });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('AUTH_GRANT_INVALID');
    await prisma.authChallenge.update({
      where: { id: codeRes.body.challengeId },
      data: { expiresAt: new Date() },
    });
    const expired = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: codeRes.body.challengeId,
        code: delivered,
        device: { installationId },
      });
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('AUTH_GRANT_INVALID');
    const retry = await signIn(freshPhone(), randomUUID());
    const replay = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: retry.challengeId,
        code: retry.code,
        device: { installationId: retry.installationId },
      });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('AUTH_GRANT_INVALID');
    const fresh = freshPhone();
    const deviceA = randomUUID();
    const issued = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .send({
        purpose: 'SIGN_IN',
        identity: { kind: 'PHONE', value: fresh },
        device: { installationId: deviceA },
      });
    const otp = inbox.read(`+86${fresh.replace(/^\+86/, '')}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    const crossDevice = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: issued.body.challengeId,
        code: otp,
        device: { installationId: randomUUID() },
      });
    expect(crossDevice.status).toBe(401);
    expect(crossDevice.body.code).toBe('AUTH_GRANT_INVALID');
    const studentAuth = await signIn();
    const student = await createStudent(studentAuth.cookies, '跨用途');
    await enterStudent(studentAuth.cookies, student.studentId);
    const signInChallenge = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .send({
        purpose: 'SIGN_IN',
        identity: { kind: 'PHONE', value: freshPhone() },
        device: { installationId: studentAuth.installationId },
      });
    const crossPurpose = await agent()
      .post('/v1/auth/session')
      .set(writeHeaders(studentAuth.cookies))
      .send({
        grantType: 'GUARDIAN_STEP_UP',
        challengeId: signInChallenge.body.challengeId,
        code: '123456',
        device: { installationId: studentAuth.installationId },
      });
    expect(crossPurpose.status).toBe(401);
    expect(crossPurpose.body.code).toBe('AUTH_GRANT_INVALID');
    const failedChallenge = await prisma.authChallenge.findUniqueOrThrow({
      where: { id: codeRes.body.challengeId },
    });
    expect(failedChallenge.consumedAt).toBeNull();
    const replayed = await prisma.authChallenge.findUniqueOrThrow({ where: { id: retry.challengeId } });
    expect(replayed.consumedAt).toBeTruthy();
    const afterFailures = await prisma.deviceSession.count();
    expect(afterFailures).toBe(sessionsBefore + 3);
  });

  it('AUTH-5 rejects step-up that splices another account session or device', async () => {
    const first = await signIn();
    const student = await createStudent(first.cookies, '二次验证甲');
    await enterStudent(first.cookies, student.studentId);
    const step = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .send({ purpose: 'GUARDIAN_STEP_UP', device: { installationId: first.installationId } });
    const code = inbox.read(`+86${first.phone.replace(/^\+86/, '')}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    const second = await signIn();
    const otherStudent = await createStudent(second.cookies, '二次验证乙');
    await enterStudent(second.cookies, otherStudent.studentId);
    const splicedSession = await agent()
      .post('/v1/auth/session')
      .set(writeHeaders(second.cookies))
      .send({
        grantType: 'GUARDIAN_STEP_UP',
        challengeId: step.body.challengeId,
        code,
        device: { installationId: first.installationId },
      });
    expect(splicedSession.status).toBe(401);
    expect(splicedSession.body.code).toBe('AUTH_GRANT_INVALID');
    const splicedDevice = await agent()
      .post('/v1/auth/session')
      .set(writeHeaders(first.cookies))
      .send({
        grantType: 'GUARDIAN_STEP_UP',
        challengeId: step.body.challengeId,
        code,
        device: { installationId: second.installationId },
      });
    expect(splicedDevice.status).toBe(401);
    expect(splicedDevice.body.code).toBe('AUTH_GRANT_INVALID');
    const challenge = await prisma.authChallenge.findUniqueOrThrow({ where: { id: step.body.challengeId } });
    expect(challenge.consumedAt).toBeNull();
    const legit = await agent()
      .post('/v1/auth/session')
      .set(writeHeaders(first.cookies))
      .send({
        grantType: 'GUARDIAN_STEP_UP',
        challengeId: step.body.challengeId,
        code,
        device: { installationId: first.installationId },
      });
    expect(legit.status).toBe(201);
  });

  it('PAIR-1 wrong code, lockout and expiry all return PAIRING_INVALID', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '配对边界');
    const pairing = await issuePairing(auth.cookies, student.studentId);
    const wrongShape = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: pairing.pairingId,
        code: 'AAAA-BBBB',
        device: { installationId: randomUUID(), label: 'wrong' },
      });
    const missing = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: randomUUID(),
        code: pairing.code,
        device: { installationId: randomUUID(), label: 'missing' },
      });
    expect(wrongShape.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrongShape.body.code).toBe('PAIRING_INVALID');
    expect(wrongShape.body.code).toBe(missing.body.code);
    for (let i = 0; i < 4; i += 1) {
      const again = await agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'PAIRING_CODE',
          pairingId: pairing.pairingId,
          code: 'CCCC-DDDD',
          device: { installationId: randomUUID(), label: `fail-${i}` },
        });
      expect(again.body.code).toBe('PAIRING_INVALID');
    }
    const locked = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: pairing.pairingId,
        code: pairing.code,
        device: { installationId: randomUUID(), label: 'locked' },
      });
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('PAIRING_INVALID');
    const row = await prisma.devicePairing.findUniqueOrThrow({ where: { id: pairing.pairingId } });
    expect(row.lockedAt).toBeTruthy();
    expect(row.consumedAt).toBeNull();

    const second = await createStudent(auth.cookies, '配对过期');
    const expiring = await issuePairing(auth.cookies, second.studentId);
    await prisma.devicePairing.update({
      where: { id: expiring.pairingId },
      data: { expiresAt: new Date() },
    });
    const expired = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: expiring.pairingId,
        code: expiring.code,
        device: { installationId: randomUUID(), label: 'expired' },
      });
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('PAIRING_INVALID');
    expect(expired.body).toMatchObject({ code: wrongShape.body.code });
  });

  it('PAIR-3 revoked link, profile restriction or consent blocks consume inside the time window', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '先撤销');
    const pairing = await issuePairing(auth.cookies, student.studentId);
    const consents = await agent().get(`/v1/students/${student.studentId}/consents`).set('Cookie', auth.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    await agent()
      .post(`/v1/students/${student.studentId}/consents/${current.id}/withdraw`)
      .set(writeHeaders(auth.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    const afterWithdraw = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: pairing.pairingId,
        code: pairing.code,
        device: { installationId: randomUUID(), label: 'after-withdraw' },
      });
    expect(afterWithdraw.status).toBe(401);
    expect(afterWithdraw.body.code).toBe('PAIRING_INVALID');

    const other = await createStudent(auth.cookies, '先撤关系');
    const otherPairing = await issuePairing(auth.cookies, other.studentId);
    const guardian = await sessionByCookie(auth.cookies);
    await students.revokeGuardianLink(guardian.accountId!, other.studentId, 'PAIR3');
    const afterLink = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: otherPairing.pairingId,
        code: otherPairing.code,
        device: { installationId: randomUUID(), label: 'after-link' },
      });
    expect(afterLink.status).toBe(401);
    expect(afterLink.body.code).toBe('PAIRING_INVALID');
  });

  it('IDEM-2 pairing replay returns NOT_REPLAYABLE and a new key revokes the old code', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '幂等配对');
    const key = randomUUID();
    const first = await issuePairing(auth.cookies, student.studentId, key);
    expect(first.secretState).toBe('ISSUED');
    const replay = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(auth.cookies, key))
      .send({});
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.secretState).toBe('NOT_REPLAYABLE');
    expect(replay.body.pairingId).toBe(first.pairingId);
    expect(replay.body.code).toBeUndefined();
    await prisma.devicePairing.update({
      where: { id: first.pairingId },
      data: { createdAt: new Date(Date.now() - 31_000) },
    });
    const second = await issuePairing(auth.cookies, student.studentId, randomUUID());
    expect(second.pairingId).not.toBe(first.pairingId);
    const old = await prisma.devicePairing.findUniqueOrThrow({ where: { id: first.pairingId } });
    expect(old.revokedAt).toBeTruthy();
    const consumedOld = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: first.pairingId,
        code: first.code,
        device: { installationId: randomUUID(), label: 'old-secret' },
      });
    expect(consumedOld.status).toBe(401);
  });

  it('TIME-1 treats now >= expiresAt as expired for challenge, pairing and session', async () => {
    const auth = await signIn();
    const sessionRow = await sessionByCookie(auth.cookies);
    const shortToken = randomUUID();
    await prisma.deviceSession.create({
      data: {
        scope: 'GUARDIAN',
        accountId: sessionRow.accountId!,
        origin: ORIGIN,
        credentialDigest: sha256Hex(shortToken),
        csrfDigest: sha256Hex('csrf'),
        accountAuthVersionAtIssue: sessionRow.accountAuthVersionAtIssue,
        deviceInstallationDigest: sessionRow.deviceInstallationDigest,
        authenticatedAt: new Date(Date.now() - 2000),
        lastSeenAt: new Date(Date.now() - 2000),
        stepUpVerifiedAt: new Date(Date.now() - 2000),
        createdAt: new Date(Date.now() - 2000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const expiredSession = await agent().get('/v1/students').set('Cookie', `stp_session=${shortToken}`);
    expect(expiredSession.status).toBe(401);
    expect(expiredSession.body.code).toBe('AUTH_SESSION_INVALID');

    const fresh = await signIn();
    const student = await createStudent(fresh.cookies, '到期配对');
    const pairing = await issuePairing(fresh.cookies, student.studentId);
    await prisma.devicePairing.update({
      where: { id: pairing.pairingId },
      data: { expiresAt: new Date() },
    });
    const expiredPairing = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: pairing.pairingId,
        code: pairing.code,
        device: { installationId: randomUUID(), label: 'time1' },
      });
    expect(expiredPairing.status).toBe(401);
    expect(expiredPairing.body.code).toBe('PAIRING_INVALID');

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
    const delivered = inbox.read(`+86${phone.replace(/^\+86/, '')}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    await prisma.authChallenge.update({
      where: { id: codeRes.body.challengeId },
      data: { expiresAt: new Date() },
    });
    const expiredChallenge = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: codeRes.body.challengeId,
        code: delivered,
        device: { installationId },
      });
    expect(expiredChallenge.status).toBe(401);
    expect(expiredChallenge.body.code).toBe('AUTH_GRANT_INVALID');
  });

  it('WD-1 withdraw omits expectedStudentVersion and ignores a forged version field', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '撤回无版本');
    const consents = await agent().get(`/v1/students/${student.studentId}/consents`).set('Cookie', auth.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const withdrawn = await agent()
      .post(`/v1/students/${student.studentId}/consents/${current.id}/withdraw`)
      .set(writeHeaders(auth.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST', expectedStudentVersion: 999, withdrawnByAccountId: randomUUID() });
    expect(withdrawn.status).toBeLessThan(300);
    expect(withdrawn.body.status).toBe('RESTRICTED');
    const stored = await prisma.consentRecord.findUniqueOrThrow({ where: { id: current.id } });
    expect(stored.withdrawnByAccountId).not.toBeNull();
    const guardian = await sessionByCookie(auth.cookies);
    expect(stored.withdrawnByAccountId).toBe(guardian.accountId);
    expect(stored.withdrawalReasonCode).toBe('GUARDIAN_REQUEST');
  });

  it('WD-2 replaying withdraw C1 after grant C2 keeps C2 and the new session', async () => {
    const auth = await signIn();
    const student = await createStudent(auth.cookies, '旧撤回重放');
    const issued = await issuePairing(auth.cookies, student.studentId);
    const consumed = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: issued.pairingId,
        code: issued.code,
        device: { installationId: randomUUID(), label: 'wd2-old' },
      });
    expect(consumed.status).toBe(201);
    const oldStudent = new CookieJar();
    oldStudent.apply(consumed);
    const consents = await agent().get(`/v1/students/${student.studentId}/consents`).set('Cookie', auth.cookies.header());
    const c1 = consents.body.items.find((item: { current: boolean }) => item.current);
    const withdrawn = await agent()
      .post(`/v1/students/${student.studentId}/consents/${c1.id}/withdraw`)
      .set(writeHeaders(auth.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdrawn.body.status).toBe('RESTRICTED');
    const latest = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', auth.cookies.header());
    const granted = await agent()
      .post(`/v1/students/${student.studentId}/consents`)
      .set(writeHeaders(auth.cookies))
      .send({
        expectedStudentVersion: latest.body.version,
        acceptances: [{ policyKey: student.policyKey, version: student.policyVersion }],
      });
    expect(granted.status).toBeLessThan(300);
    expect(granted.body.status).toBe('ONBOARDING');
    const afterGrant = await agent().get(`/v1/students/${student.studentId}/consents`).set('Cookie', auth.cookies.header());
    const c2 = afterGrant.body.items.find((item: { current: boolean }) => item.current);
    expect(c2.id).not.toBe(c1.id);
    await prisma.devicePairing.update({
      where: { id: issued.pairingId },
      data: { createdAt: new Date(Date.now() - 31_000) },
    });
    const renewedPairing = await issuePairing(auth.cookies, student.studentId);
    const renewed = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: renewedPairing.pairingId,
        code: renewedPairing.code,
        device: { installationId: randomUUID(), label: 'wd2-new' },
      });
    expect(renewed.status).toBe(201);
    const newStudent = new CookieJar();
    newStudent.apply(renewed);
    const replay = await agent()
      .post(`/v1/students/${student.studentId}/consents/${c1.id}/withdraw`)
      .set(writeHeaders(auth.cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.status).toBe('ONBOARDING');
    const stillCurrent = await prisma.consentRecord.findUniqueOrThrow({ where: { id: c2.id } });
    expect(stillCurrent.withdrawnAt).toBeNull();
    expect(stillCurrent.supersededAt).toBeNull();
    const stale = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', oldStudent.header());
    expect(stale.status).toBe(401);
    const fresh = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', newStudent.header());
    expect(fresh.status).toBeLessThan(300);
    expect(fresh.body.status).toBe('ONBOARDING');
  });

  it('FAIL-1 failed OTP attempts persist, lock, and stay locked after expiry', async () => {
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
    const delivered = inbox.read(`+86${phone.replace(/^\+86/, '')}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    const wrongCode = delivered === '000000' ? '000001' : '000000';
    for (let i = 1; i <= 5; i += 1) {
      const failed = await agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'VERIFICATION_CODE',
          challengeId: codeRes.body.challengeId,
          code: wrongCode,
          device: { installationId },
        });
      expect(failed.status).toBe(401);
      expect(failed.body.code).toBe('AUTH_GRANT_INVALID');
      const row = await prisma.authChallenge.findUniqueOrThrow({ where: { id: codeRes.body.challengeId } });
      expect(row.attemptCount).toBe(i);
      expect(row.consumedAt).toBeNull();
      if (i < 5) {
        expect(row.lockedAt).toBeNull();
      } else {
        expect(row.lockedAt).toBeTruthy();
      }
    }
    const lockedCorrect = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: codeRes.body.challengeId,
        code: delivered,
        device: { installationId },
      });
    expect(lockedCorrect.status).toBe(401);
    expect(lockedCorrect.body.code).toBe('AUTH_GRANT_INVALID');
    await prisma.authChallenge.update({
      where: { id: codeRes.body.challengeId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const afterExpiry = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: codeRes.body.challengeId,
        code: delivered,
        device: { installationId },
      });
    expect(afterExpiry.status).toBe(401);
    const locked = await prisma.authChallenge.findUniqueOrThrow({ where: { id: codeRes.body.challengeId } });
    expect(locked.lockedAt).toBeTruthy();
    expect(locked.consumedAt).toBeNull();
    expect(locked.attemptCount).toBe(5);
  });

  it('RATE-1 same identity and device cannot request another OTP inside 60s', async () => {
    const phone = freshPhone();
    const installationId = randomUUID();
    const first = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .send({
        purpose: 'SIGN_IN',
        identity: { kind: 'PHONE', value: phone },
        device: { installationId },
      });
    expect(first.status).toBeLessThan(300);
    const second = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .send({
        purpose: 'SIGN_IN',
        identity: { kind: 'PHONE', value: phone },
        device: { installationId },
      });
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('RATE_LIMITED');
    const challenges = await prisma.authChallenge.count({
      where: { deviceInstallationDigest: sha256Hex(installationId) },
    });
    expect(challenges).toBe(1);
  });

  it('TIME-2 idle and absolute session bounds reject without resurrecting lastSeenAt', async () => {
    const idleAuth = await signIn();
    const idleRow = await sessionByCookie(idleAuth.cookies);
    const idleLastSeen = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await prisma.deviceSession.update({
      where: { id: idleRow.id },
      data: { lastSeenAt: idleLastSeen },
    });
    const idleDenied = await agent().get('/v1/students').set('Cookie', idleAuth.cookies.header());
    expect(idleDenied.status).toBe(401);
    expect(idleDenied.body.code).toBe('AUTH_SESSION_INVALID');
    const idleAfter = await prisma.deviceSession.findUniqueOrThrow({ where: { id: idleRow.id } });
    expect(idleAfter.lastSeenAt!.getTime()).toBeLessThan(Date.now() - 2 * 60 * 60 * 1000);

    const absAuth = await signIn();
    const absRow = await sessionByCookie(absAuth.cookies);
    const absLastSeen = new Date(Date.now() - 30_000);
    const absToken = randomUUID();
    await prisma.deviceSession.create({
      data: {
        scope: 'GUARDIAN',
        accountId: absRow.accountId!,
        origin: ORIGIN,
        credentialDigest: sha256Hex(absToken),
        csrfDigest: sha256Hex('csrf'),
        accountAuthVersionAtIssue: absRow.accountAuthVersionAtIssue,
        deviceInstallationDigest: absRow.deviceInstallationDigest,
        authenticatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        lastSeenAt: absLastSeen,
        stepUpVerifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
      },
    });
    const absDenied = await agent().get('/v1/students').set('Cookie', `stp_session=${absToken}`);
    expect(absDenied.status).toBe(401);
    expect(absDenied.body.code).toBe('AUTH_SESSION_INVALID');
    const absAfter = await prisma.deviceSession.findFirstOrThrow({
      where: { credentialDigest: sha256Hex(absToken) },
    });
    expect(absAfter.lastSeenAt!.getTime()).toBe(absLastSeen.getTime());

    const touchAuth = await signIn();
    const touchRow = await sessionByCookie(touchAuth.cookies);
    const recent = new Date(Date.now() - 10_000);
    await prisma.deviceSession.update({
      where: { id: touchRow.id },
      data: { lastSeenAt: recent, version: touchRow.version },
    });
    const skipped = await agent().get('/v1/students').set('Cookie', touchAuth.cookies.header());
    expect(skipped.status).toBeLessThan(300);
    const notTouched = await prisma.deviceSession.findUniqueOrThrow({ where: { id: touchRow.id } });
    expect(notTouched.lastSeenAt!.getTime()).toBe(recent.getTime());
    expect(notTouched.version).toBe(touchRow.version);

    const stale = new Date(Date.now() - 90_000);
    await prisma.deviceSession.update({
      where: { id: touchRow.id },
      data: { lastSeenAt: stale, version: notTouched.version },
    });
    const ok = await agent().get('/v1/students').set('Cookie', touchAuth.cookies.header());
    expect(ok.status).toBeLessThan(300);
    const touched = await prisma.deviceSession.findUniqueOrThrow({ where: { id: touchRow.id } });
    expect(touched.lastSeenAt!.getTime()).toBeGreaterThan(stale.getTime());
    expect(touched.version).toBe(notTouched.version + 1);
  });
});
