import { hasIsolatedPostgres, loadStp004Env } from './test/load-stp004-env';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { HttpErrorFilter } from './common/http-exception.filter';
import { TestAuthDelivery } from './auth/test-delivery.adapter';

const ORIGIN = 'http://127.0.0.1:5173';

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

describe.skipIf(!hasIsolatedPostgres)('STP 004 HTTP / cookie / CSRF', () => {
  let app: INestApplication;
  let inbox: TestAuthDelivery;

  beforeAll(async () => {
    loadStp004Env();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new HttpErrorFilter());
    await app.init();
    inbox = app.get(TestAuthDelivery);
  });

  afterAll(async () => {
    await app.close();
  });

  function agent() {
    return request(app.getHttpServer());
  }

  async function signIn(phone = '13800138002', installationId = randomUUID()) {
    const cookies = new CookieJar();
    const codeRes = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .send({
        purpose: 'SIGN_IN',
        identity: { kind: 'PHONE', value: phone },
        device: { installationId },
      });
    if (codeRes.status >= 300) {
      throw new Error(`auth/code ${codeRes.status} ${JSON.stringify(codeRes.body)}`);
    }
    const delivered = inbox.read(`+86${phone.replace(/^\+86/, '')}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    expect(delivered).toMatch(/^\d{6}$/);
    const sessionRes = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'VERIFICATION_CODE',
        challengeId: codeRes.body.challengeId,
        code: delivered,
        device: { installationId, label: 'http-test' },
      });
    expect(sessionRes.body.session.scope).toBe('GUARDIAN');
    cookies.apply(sessionRes);
    return { cookies, installationId, phone };
  }

  it('AUTH-4 rejects missing CSRF, wrong origin, and unbound CSRF', async () => {
    const { cookies } = await signIn();
    const missing = await agent().post('/v1/students').set('Origin', ORIGIN).set('Cookie', cookies.header()).send({});
    expect(missing.status).toBe(400);
    const origin = await agent()
      .post('/v1/students')
      .set('Origin', 'http://127.0.0.1:5174')
      .set('Cookie', cookies.header())
      .set('X-CSRF-Token', cookies.get('stp_csrf') ?? '')
      .send({});
    expect(origin.status).toBe(400);
    const unbound = await agent()
      .post('/v1/students')
      .set('Origin', ORIGIN)
      .set('Cookie', `${cookies.header()}; stp_csrf=forged`)
      .set('X-CSRF-Token', 'forged')
      .set('Idempotency-Key', randomUUID())
      .send({
        profile: { nickname: 'x', avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
        ageConfirmation: { band: 'UNDER_14', source: 'GUARDIAN_DECLARATION' },
        consentAcceptances: [{ policyKey: 'TEST_CHILD_CORE_SERVICE', version: 'test-v1' }],
      });
    expect(unbound.status).toBe(400);
  });

  it('logout requires CSRF; unauthenticated SIGN_IN does not', async () => {
    const { cookies } = await signIn('13800138004');
    const denied = await agent()
      .delete('/v1/auth/session')
      .set('Origin', ORIGIN)
      .set('Cookie', cookies.header());
    expect(denied.status).toBe(400);
    const still = await agent().get('/v1/auth/session').set('Cookie', cookies.header());
    expect(still.status).toBeLessThan(300);
    const out = await agent()
      .delete('/v1/auth/session')
      .set('Origin', ORIGIN)
      .set('Cookie', cookies.header())
      .set('X-CSRF-Token', cookies.get('stp_csrf') ?? '');
    expect(out.status).toBe(204);
    const gone = await agent().get('/v1/auth/session').set('Cookie', cookies.header());
    expect(gone.status).toBe(401);
    const anon = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .send({
        purpose: 'SIGN_IN',
        identity: { kind: 'PHONE', value: '13800138000' },
        device: { installationId: randomUUID() },
      });
    expect(anon.status).toBeLessThan(300);
  });

  it('T01 / T02-B / IDEM-1 / T10 / AUTH-2 / PAIR / T11 core HTTP flow', async () => {
    const first = await signIn('13800138002');
    const unconfirmed = await agent()
      .post('/v1/students')
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .set('Idempotency-Key', randomUUID())
      .send({
        profile: { nickname: '未确认', avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
        ageConfirmation: { band: 'UNCONFIRMED', source: 'GUARDIAN_DECLARATION' },
        consentAcceptances: [{ policyKey: 'TEST_CHILD_CORE_SERVICE', version: 'test-v1' }],
      });
    expect(unconfirmed.status).toBe(400);

    const missingConsent = await agent()
      .post('/v1/students')
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .set('Idempotency-Key', randomUUID())
      .send({
        profile: { nickname: '缺同意', avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
        ageConfirmation: { band: 'UNDER_14', source: 'GUARDIAN_DECLARATION' },
        consentAcceptances: [{ policyKey: 'TEST_CHILD_CORE_SERVICE', version: 'old' }],
      });
    expect(missingConsent.status).toBe(422);
    expect(missingConsent.body.code).toBe('CONSENT_REQUIRED');

    const adult = await agent()
      .post('/v1/students')
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .set('Idempotency-Key', randomUUID())
      .send({
        profile: { nickname: '成年', avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
        ageConfirmation: { band: 'AGE_18_PLUS', source: 'GUARDIAN_DECLARATION' },
        consentAcceptances: [{ policyKey: 'TEST_CHILD_CORE_SERVICE', version: 'test-v1' }],
      });
    expect(adult.status).toBe(422);
    expect(adult.body.code).toBe('AGE_BAND_NOT_SUPPORTED');

    const idemKey = randomUUID();
    const docs = await agent()
      .get('/v1/consent-documents?ageBand=UNDER_14')
      .set('Cookie', first.cookies.header());
    const payload = {
      profile: { nickname: '小树', avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai', extra: 'ignored' },
      ageConfirmation: { band: 'UNDER_14', source: 'GUARDIAN_DECLARATION' },
      education: {
        stageCode: 'primary',
        schoolSystemCode: 'liusan',
        gradeCode: 'g3',
        gradeLabel: '三年级',
        termCode: '2026-1',
      },
      consentAcceptances: [{ policyKey: docs.body.policyKey, version: docs.body.version }],
    };
    const created = await agent()
      .post('/v1/students')
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .set('Idempotency-Key', idemKey)
      .send(payload);
    expect(created.status).toBe(201);
    const replay = await agent()
      .post('/v1/students')
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .set('Idempotency-Key', idemKey)
      .send(payload);
    expect(replay.status).toBe(201);
    expect(replay.body.profile.id).toBe(created.body.profile.id);
    const conflict = await agent()
      .post('/v1/students')
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .set('Idempotency-Key', idemKey)
      .send({ ...payload, profile: { ...payload.profile, nickname: '另一人' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const studentId = created.body.profile.id;
    const patchedEdu = await agent()
      .patch(`/v1/students/${studentId}`)
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .set('Idempotency-Key', randomUUID())
      .send({
        kind: 'EDUCATION',
        expectedVersion: created.body.profile.version,
        education: {
          stageCode: 'primary',
          schoolSystemCode: 'liusan',
          gradeCode: 'g4',
          gradeLabel: '四年级',
          termCode: '2026-1',
        },
      });
    expect(patchedEdu.body.ageBand).toBe('UNDER_14');
    expect(patchedEdu.body.education.gradeCode).toBe('g4');

    const other = await signIn('13800138003');
    const hidden = await agent().get(`/v1/students/${studentId}`).set('Cookie', other.cookies.header());
    const missing = await agent().get(`/v1/students/${randomUUID()}`).set('Cookie', other.cookies.header());
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.body.code).toBe(missing.body.code);

    const entered = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .send({ grantType: 'STUDENT_MODE', studentId });
    expect(entered.body.session.scope).toBe('STUDENT');
    first.cookies.apply(entered);
    const guardianList = await agent().get('/v1/students').set('Cookie', first.cookies.header());
    expect(guardianList.status).toBe(403);

    const step = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .send({ purpose: 'GUARDIAN_STEP_UP', device: { installationId: first.installationId } });
    const stepCode = inbox.read('+8613800138002', process.env.AUTH_TEST_INBOX_KEY ?? '');
    const back = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .send({
        grantType: 'GUARDIAN_STEP_UP',
        challengeId: step.body.challengeId,
        code: stepCode,
        device: { installationId: first.installationId },
      });
    expect(back.body.session.scope).toBe('GUARDIAN');
    first.cookies.apply(back);

    const pairing = await agent()
      .post(`/v1/students/${studentId}/pairings`)
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(pairing.status).toBe(201);
    expect(pairing.body.code).toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}/);

    const consumed = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId: pairing.body.pairingId,
        code: pairing.body.code,
        device: { installationId: randomUUID(), label: 'second-device' },
      });
    expect(consumed.body.session.scope).toBe('STUDENT');
    const studentCookies = new CookieJar();
    studentCookies.apply(consumed);

    const devices = await agent()
      .get(`/v1/students/${studentId}/device-sessions`)
      .set('Cookie', first.cookies.header());
    expect(JSON.stringify(devices.body)).not.toMatch(/credential|stp_session/i);
    const target = devices.body.items.find((item: { revokedAt: string | null }) => !item.revokedAt);
    const revoked = await agent()
      .post(`/v1/students/${studentId}/device-sessions/${target.id}/revoke`)
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'LOST_DEVICE' });
    expect(revoked.body.revoked).toBe(true);
    const stale = await agent().get(`/v1/students/${studentId}`).set('Cookie', studentCookies.header());
    expect(stale.status).toBe(401);

    const consents = await agent()
      .get(`/v1/students/${studentId}/consents`)
      .set('Cookie', first.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const withdrawn = await agent()
      .post(`/v1/students/${studentId}/consents/${current.id}/withdraw`)
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdrawn.body.status).toBe('RESTRICTED');
    const replayWithdraw = await agent()
      .post(`/v1/students/${studentId}/consents/${current.id}/withdraw`)
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookies.header())
      .set('X-CSRF-Token', first.cookies.get('stp_csrf') ?? '')
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(replayWithdraw.body.status).toBe('RESTRICTED');

  });
});
