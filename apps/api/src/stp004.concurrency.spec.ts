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
import { PolicyPublishService, TEST_POLICY_SCOPE } from './students/policy-publish.service';
import { RuntimeConfig } from './common/runtime-config';
import { digestCanonical, hmacHex, sha256Hex } from './common/crypto';
import { hasIsolatedPostgres, loadStp004Env } from './test/load-stp004-env';
import { backendPid, waitForAdvisoryWaiter, waitForWaiterOnHolder } from './test/lock-barrier';
import { StudentsService } from './students/students.service';

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

describe.skipIf(!hasIsolatedPostgres)('STP 004 business concurrency with overlapping transactions', () => {
  let app: INestApplication;
  let inbox: TestAuthDelivery;
  let publisher: PolicyPublishService;
  let runtime: RuntimeConfig;
  let students: StudentsService;
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
    publisher = app.get(PolicyPublishService);
    runtime = app.get(RuntimeConfig);
    students = app.get(StudentsService);
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

  function freshPhone() {
    return `13800138${String(200 + Math.floor(Math.random() * 80)).padStart(3, '0')}`;
  }

  async function currentPolicyVersion() {
    const policy = await prisma.consentPolicy.findUniqueOrThrow({
      where: { policyKey_locale: { policyKey: 'TEST_CHILD_CORE_SERVICE', locale: 'zh-CN' } },
    });
    return policy.currentDocumentVersionId;
  }

  async function restorePolicy(documentId: string | null) {
    if (!documentId) {
      return;
    }
    await prisma.consentPolicy.update({
      where: { policyKey_locale: { policyKey: 'TEST_CHILD_CORE_SERVICE', locale: 'zh-CN' } },
      data: { currentDocumentVersionId: documentId },
    });
  }

  async function signIn(phone: string, installationId = randomUUID()) {
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
        device: { installationId, label: 'concur' },
      });
    expect(sessionRes.status).toBe(201);
    cookies.apply(sessionRes);
    return { cookies, installationId, phone };
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

  function writeHeaders(cookies: CookieJar, idempotencyKey = randomUUID()) {
    return {
      Origin: ORIGIN,
      Cookie: cookies.header(),
      'X-CSRF-Token': cookies.get('stp_csrf') ?? '',
      'Idempotency-Key': idempotencyKey,
    };
  }

  async function sessionByCookie(cookies: CookieJar) {
    return prisma.deviceSession.findUniqueOrThrow({
      where: { credentialDigest: sha256Hex(cookies.get('stp_session') ?? '') },
    });
  }

  async function consumePairing(pairingId: string, code: string, label: string, installationId = randomUUID()) {
    const cookies = new CookieJar();
    const consumed = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .send({
        grantType: 'PAIRING_CODE',
        pairingId,
        code,
        device: { installationId, label },
      });
    expect(consumed.status).toBe(201);
    cookies.apply(consumed);
    return { cookies, installationId };
  }

  it('CON-2 publish-first: overlapping grant of the old version is rejected', async () => {
    const baseline = await currentPolicyVersion();
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    try {
    const { cookies } = await signIn(freshPhone());
    const student = await createStudent(cookies, '发布先完成');
    const policy = await prisma.consentPolicy.findUniqueOrThrow({
      where: { policyKey_locale: { policyKey: student.policyKey, locale: 'zh-CN' } },
    });
    await holder.connect();
    const newDocumentId = randomUUID();
    const newVersion = `test-pub-${newDocumentId.slice(0, 8)}`;
    const body = '并发发布的测试政策正文（非正式）';
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM consent_policies WHERE id = $1 FOR UPDATE', [policy.id]);
    await holder.query(
      `INSERT INTO consent_document_versions (
         id, consent_policy_id, version, content_format, content_body, content_digest,
         scope_canonical_json, scope_digest, scope_schema_version, digest_algorithm_version,
         published_at, created_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'text/plain', $4, $5, $6, $7, '1', 'sha256-v1', now(), now()
       )`,
      [
        newDocumentId,
        policy.id,
        newVersion,
        body,
        digestCanonical(body),
        JSON.stringify(TEST_POLICY_SCOPE),
        digestCanonical(TEST_POLICY_SCOPE),
      ],
    );
    await holder.query(
      'UPDATE consent_policies SET current_document_version_id = $1, updated_at = now() WHERE id = $2',
      [newDocumentId, policy.id],
    );
    const holderPid = await backendPid(holder);

    const grantPromise = dispatch(
      agent()
        .post(`/v1/students/${student.studentId}/consents`)
        .set(writeHeaders(cookies))
        .send({
          expectedStudentVersion: student.version,
          acceptances: [{ policyKey: student.policyKey, version: student.policyVersion }],
        }),
    );

    const overlap = await waitForWaiterOnHolder(observer, holderPid, 'CON-2 publish-first grant waiter');
    expect(overlap.holder_pid).toBe(holderPid);
    expect(overlap.waiter_pid).not.toBe(holderPid);

    await holder.query('COMMIT');
    const granted = await grantPromise;
    expect(granted.status).toBe(409);
    expect(granted.body.code).toBe('CONSENT_VERSION_CHANGED');
    expect(granted.status).not.toBe(500);

    const current = await prisma.consentRecord.findFirst({
      where: { studentProfileId: student.studentId, withdrawnAt: null, supersededAt: null },
    });
    expect(current?.documentVersionId).not.toBe(newDocumentId);
    } finally {
      await holder.end().catch(() => undefined);
      await observer.end().catch(() => undefined);
      await restorePolicy(baseline);
    }
  });

  it('CON-2 grant-first: overlapping publish waits, later access follows the new policy', async () => {
    const baseline = await currentPolicyVersion();
    const { cookies } = await signIn(freshPhone());
    const student = await createStudent(cookies, '授权先完成');
    const link = await prisma.guardianLink.findFirstOrThrow({
      where: { studentProfileId: student.studentId, status: 'ACTIVE' },
    });
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM guardian_links WHERE id = $1 FOR UPDATE', [link.id]);
    const blockerPid = await backendPid(blocker);

    const grantPromise = dispatch(
      agent()
        .post(`/v1/students/${student.studentId}/consents`)
        .set(writeHeaders(cookies))
        .send({
          expectedStudentVersion: student.version,
          acceptances: [{ policyKey: student.policyKey, version: student.policyVersion }],
        }),
    );

    const grantWait = await waitForWaiterOnHolder(observer, blockerPid, 'CON-2 grant waits on guardian_links');
    const publishVersion = `test-grant-${randomUUID().slice(0, 8)}`;
    const publishPromise = publisher.publishNext(
      student.policyKey,
      publishVersion,
      '授权先完成后发布的测试政策（非正式）',
    );
    const overlap = await waitForWaiterOnHolder(observer, grantWait.waiter_pid, 'CON-2 publish waits on grant');
    expect(overlap.holder_pid).toBe(grantWait.waiter_pid);
    expect(overlap.waiter_pid).not.toBe(grantWait.waiter_pid);

    await blocker.query('ROLLBACK');
    const granted = await grantPromise;
    expect(granted.status).toBeLessThan(300);
    const published = await publishPromise;
    expect(published.version).toBe(publishVersion);

    const pairing = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(cookies))
      .send({});
    expect(pairing.status).toBe(422);
    expect(pairing.body.code).toBe('CONSENT_REQUIRED');
    const studentMode = await agent()
      .post('/v1/auth/session')
      .set('Origin', ORIGIN)
      .set('Cookie', cookies.header())
      .set('X-CSRF-Token', cookies.get('stp_csrf') ?? '')
      .send({ grantType: 'STUDENT_MODE', studentId: student.studentId });
    expect(studentMode.status).toBe(422);
    expect(studentMode.body.code).toBe('CONSENT_REQUIRED');
    const detail = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', cookies.header());
    expect(detail.body.learningAccess.reason).toBe('CONSENT_REQUIRED');
    await blocker.end().catch(() => undefined);
    await observer.end().catch(() => undefined);
    await restorePolicy(baseline);
  });

  it('AUTH-3 two valid challenges concurrently create one Account and one AuthIdentity', async () => {
    const startedAt = new Date();
    const phone = freshPhone();
    const destination = `+86${phone}`;
    const deviceA = randomUUID();
    const deviceB = randomUUID();
    const first = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .send({
        purpose: 'SIGN_IN',
        identity: { kind: 'PHONE', value: phone },
        device: { installationId: deviceA },
      });
    const codeA = inbox.read(destination, process.env.AUTH_TEST_INBOX_KEY ?? '');
    const second = await agent()
      .post('/v1/auth/code')
      .set('Origin', ORIGIN)
      .send({
        purpose: 'SIGN_IN',
        identity: { kind: 'PHONE', value: phone },
        device: { installationId: deviceB },
      });
    const codeB = inbox.read(destination, process.env.AUTH_TEST_INBOX_KEY ?? '');
    expect(first.status).toBeLessThan(300);
    expect(second.status).toBeLessThan(300);
    expect(first.body.challengeId).not.toBe(second.body.challengeId);
    expect(codeA).toMatch(/^\d{6}$/);
    expect(codeB).toMatch(/^\d{6}$/);

    const advisory = hmacHex(runtime.value.keys.advisory, `PHONE_OTP:PHONE:${destination}`);
    const lookupDigest = hmacHex(runtime.value.keys.lookup, `PHONE_OTP:PHONE:${destination}`);
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [advisory]);
    const holderPid = await backendPid(holder);

    const loginA = dispatch(
      agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'VERIFICATION_CODE',
          challengeId: first.body.challengeId,
          code: codeA,
          device: { installationId: deviceA, label: 'auth3-a' },
        }),
    );
    const loginB = dispatch(
      agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'VERIFICATION_CODE',
          challengeId: second.body.challengeId,
          code: codeB,
          device: { installationId: deviceB, label: 'auth3-b' },
        }),
    );

    const firstWaiter = await waitForAdvisoryWaiter(observer, holderPid, 'AUTH-3 first login waiter');
    expect(firstWaiter.holder_pid).toBe(holderPid);
    await holder.query('COMMIT');
    const [resA, resB] = await Promise.all([loginA, loginB]);
    expect([resA.status, resB.status].every((status) => status !== 500)).toBe(true);
    expect([resA.status, resB.status].some((status) => status === 201)).toBe(true);

    const lookups = await prisma.authIdentityLookup.findMany({
      where: { subjectLookupDigest: lookupDigest },
    });
    expect(lookups).toHaveLength(1);
    const lookup = lookups[0];
    expect(lookup).toBeDefined();
    const identities = await prisma.authIdentity.findMany({
      where: { id: lookup!.authIdentityId },
    });
    expect(identities).toHaveLength(1);
    const identity = identities[0];
    expect(identity).toBeDefined();
    const accounts = await prisma.account.findMany({
      where: { identities: { some: { id: identity!.id } } },
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toBeDefined();
    const dangling = await prisma.account.findMany({
      where: { identities: { none: {} }, createdAt: { gte: startedAt } },
    });
    expect(dangling).toHaveLength(0);

    await holder.end();
    await observer.end();
  });

  it('PAIR two devices concurrently consume one code; loser leaves no residue', async () => {
    const { cookies } = await signIn(freshPhone());
    const student = await createStudent(cookies, '配对并发');
    const issued = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(cookies))
      .send({});
    expect(issued.status).toBe(201);
    const pairingId = issued.body.pairingId as string;
    const code = issued.body.code as string;

    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [pairingId]);
    const holderPid = await backendPid(holder);

    const consumeA = dispatch(
      agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'PAIRING_CODE',
          pairingId,
          code,
          device: { installationId: randomUUID(), label: 'pair-a' },
        }),
    );
    const consumeB = dispatch(
      agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'PAIRING_CODE',
          pairingId,
          code,
          device: { installationId: randomUUID(), label: 'pair-b' },
        }),
    );

    const overlap = await waitForWaiterOnHolder(observer, holderPid, 'PAIR consume waiter');
    expect(overlap.holder_pid).toBe(holderPid);
    await holder.query('COMMIT');
    const [resA, resB] = await Promise.all([consumeA, consumeB]);
    const statuses = [resA.status, resB.status];
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 401)).toHaveLength(1);
    expect(statuses.includes(500)).toBe(false);
    const failed = resA.status === 401 ? resA : resB;
    expect(failed.body.code).toBe('PAIRING_INVALID');

    const sessions = await prisma.deviceSession.findMany({
      where: { studentProfileId: student.studentId, scope: 'STUDENT' },
    });
    expect(sessions).toHaveLength(1);
    const studentSession = sessions[0];
    expect(studentSession).toBeDefined();
    const pairing = await prisma.devicePairing.findUniqueOrThrow({ where: { id: pairingId } });
    expect(pairing.consumedAt).toBeTruthy();
    expect(pairing.consumedBySessionId).toBe(studentSession!.id);
    expect(pairing.revokedAt).toBeNull();

    await holder.end();
    await observer.end();
  });

  it('CON-3 write-first: revoke waits, then later writes from the old state fail', async () => {
    const { cookies } = await signIn(freshPhone());
    const student = await createStudent(cookies, '旧写入');
    const pairing = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(cookies))
      .send({});
    expect(pairing.status).toBe(201);
    const consents = await agent()
      .get(`/v1/students/${student.studentId}/consents`)
      .set('Cookie', cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [pairing.body.pairingId]);
    const blockerPid = await backendPid(blocker);

    const patchPromise = dispatch(
      agent()
        .patch(`/v1/students/${student.studentId}`)
        .set(writeHeaders(cookies))
        .send({ kind: 'BASIC', expectedVersion: student.version, nickname: '已改名' }),
    );
    const writer = await waitForWaiterOnHolder(observer, blockerPid, 'CON-3 patch waits on pairing');
    const withdrawPromise = dispatch(
      agent()
        .post(`/v1/students/${student.studentId}/consents/${current.id}/withdraw`)
        .set(writeHeaders(cookies))
        .send({ reasonCode: 'GUARDIAN_REQUEST' }),
    );
    const overlap = await waitForWaiterOnHolder(observer, writer.waiter_pid, 'CON-3 withdraw waits on write');
    expect(overlap.holder_pid).toBe(writer.waiter_pid);

    await blocker.query('ROLLBACK');
    const patched = await patchPromise;
    expect(patched.status).toBeLessThan(300);
    expect(patched.body.nickname).toBe('已改名');
    const withdrawn = await withdrawPromise;
    expect(withdrawn.status).toBeLessThan(300);
    expect(withdrawn.body.status).toBe('RESTRICTED');

    const late = await agent()
      .patch(`/v1/students/${student.studentId}`)
      .set(writeHeaders(cookies))
      .send({ kind: 'BASIC', expectedVersion: patched.body.version, nickname: '晚到提交' });
    expect(late.status).toBe(403);

    await blocker.end();
    await observer.end();
  });

  it('CON-3 revoke-first: overlapping write cannot commit after revoke', async () => {
    const { cookies } = await signIn(freshPhone());
    const student = await createStudent(cookies, '撤销先完成');
    const pairing = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(cookies))
      .send({});
    const consents = await agent()
      .get(`/v1/students/${student.studentId}/consents`)
      .set('Cookie', cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [pairing.body.pairingId]);
    const blockerPid = await backendPid(blocker);

    const withdrawPromise = dispatch(
      agent()
        .post(`/v1/students/${student.studentId}/consents/${current.id}/withdraw`)
        .set(writeHeaders(cookies))
        .send({ reasonCode: 'GUARDIAN_REQUEST' }),
    );
    const revoker = await waitForWaiterOnHolder(observer, blockerPid, 'CON-3 withdraw waits on pairing');
    const patchPromise = dispatch(
      agent()
        .patch(`/v1/students/${student.studentId}`)
        .set(writeHeaders(cookies))
        .send({ kind: 'BASIC', expectedVersion: student.version, nickname: '不应写入' }),
    );
    const overlap = await waitForWaiterOnHolder(observer, revoker.waiter_pid, 'CON-3 write waits on revoke');
    expect(overlap.holder_pid).toBe(revoker.waiter_pid);

    await blocker.query('ROLLBACK');
    const withdrawn = await withdrawPromise;
    expect(withdrawn.body.status).toBe('RESTRICTED');
    const patched = await patchPromise;
    expect(patched.status).toBe(403);
    const stored = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.studentId } });
    expect(stored.nickname).toBe('撤销先完成');

    await blocker.end();
    await observer.end();
  });

  it('CON-1 two patches with the same expectedVersion: one succeeds, one 409', async () => {
    const { cookies } = await signIn(freshPhone());
    const student = await createStudent(cookies, '版本冲突');
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM student_profiles WHERE id = $1 FOR UPDATE', [student.studentId]);
    const holderPid = await backendPid(holder);

    const first = dispatch(
      agent()
        .patch(`/v1/students/${student.studentId}`)
        .set(writeHeaders(cookies))
        .send({ kind: 'BASIC', expectedVersion: student.version, nickname: '版本甲' }),
    );
    const waiter = await waitForWaiterOnHolder(observer, holderPid, 'CON-1 first patch waits');
    const second = dispatch(
      agent()
        .patch(`/v1/students/${student.studentId}`)
        .set(writeHeaders(cookies))
        .send({ kind: 'BASIC', expectedVersion: student.version, nickname: '版本乙' }),
    );
    const overlap = await waitForWaiterOnHolder(observer, waiter.waiter_pid, 'CON-1 second patch waits');
    expect(overlap.holder_pid).toBe(waiter.waiter_pid);

    await holder.query('ROLLBACK');
    const [resA, resB] = await Promise.all([first, second]);
    const statuses = [resA.status, resB.status];
    expect(statuses.filter((status) => status < 300)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
    const failed = resA.status === 409 ? resA : resB;
    expect(failed.body.code).toBe('VERSION_CONFLICT');
    const stored = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.studentId } });
    expect(['版本甲', '版本乙']).toContain(stored.nickname);
    expect(stored.version).toBe(student.version + 1);

    await holder.end();
    await observer.end();
  });

  it('PAIR-4 generate vs consume and consume vs revoke stay linearized without deadlock', async () => {
    const { cookies } = await signIn(freshPhone());
    const student = await createStudent(cookies, '配对锁序');
    const issued = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(cookies))
      .send({});
    expect(issued.status).toBe(201);
    await prisma.devicePairing.update({
      where: { id: issued.body.pairingId },
      data: { createdAt: new Date(Date.now() - 31_000) },
    });

    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [issued.body.pairingId]);
    const holderPid = await backendPid(holder);

    const consume = dispatch(
      agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'PAIRING_CODE',
          pairingId: issued.body.pairingId,
          code: issued.body.code,
          device: { installationId: randomUUID(), label: 'pair4-consume' },
        }),
    );
    const consumeWaiter = await waitForWaiterOnHolder(observer, holderPid, 'PAIR-4 consume waits');
    const generate = dispatch(
      agent().post(`/v1/students/${student.studentId}/pairings`).set(writeHeaders(cookies)).send({}),
    );
    const generateWaiter = await waitForWaiterOnHolder(observer, consumeWaiter.waiter_pid, 'PAIR-4 generate waits');
    expect(generateWaiter.holder_pid).toBe(consumeWaiter.waiter_pid);

    await holder.query('ROLLBACK');
    const [consumed, created] = await Promise.all([consume, generate]);
    expect([consumed.status, created.status].includes(500)).toBe(false);
    const sessions = await prisma.deviceSession.findMany({
      where: { studentProfileId: student.studentId, scope: 'STUDENT' },
    });
    expect(sessions.length).toBeLessThanOrEqual(1);
    if (consumed.status === 201) {
      expect(sessions).toHaveLength(1);
    }

    const next = await createStudent(cookies, '兑换对撤销');
    const second = await agent()
      .post(`/v1/students/${next.studentId}/pairings`)
      .set(writeHeaders(cookies))
      .send({});
    const holder2 = new pg.Client({ connectionString });
    await holder2.connect();
    await holder2.query('BEGIN');
    await holder2.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [second.body.pairingId]);
    const holder2Pid = await backendPid(holder2);
    const consume2 = dispatch(
      agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'PAIRING_CODE',
          pairingId: second.body.pairingId,
          code: second.body.code,
          device: { installationId: randomUUID(), label: 'pair4-rev' },
        }),
    );
    const consume2Waiter = await waitForWaiterOnHolder(observer, holder2Pid, 'PAIR-4 consume-vs-revoke consume waits');
    const revoke = dispatch(
      agent()
        .post(`/v1/students/${next.studentId}/pairings/${second.body.pairingId}/revoke`)
        .set(writeHeaders(cookies))
        .send({}),
    );
    const revokeWaiter = await waitForWaiterOnHolder(observer, consume2Waiter.waiter_pid, 'PAIR-4 revoke waits');
    expect(revokeWaiter.holder_pid).toBe(consume2Waiter.waiter_pid);
    await holder2.query('ROLLBACK');
    const [consumed2, revoked] = await Promise.all([consume2, revoke]);
    expect([consumed2.status, revoked.status].includes(500)).toBe(false);
    const laterSessions = await prisma.deviceSession.findMany({
      where: { studentProfileId: next.studentId, scope: 'STUDENT' },
    });
    expect(laterSessions.length).toBeLessThanOrEqual(1);
    const pairing = await prisma.devicePairing.findUniqueOrThrow({ where: { id: second.body.pairingId } });
    expect(Boolean(pairing.consumedAt) && Boolean(pairing.revokedAt)).toBe(false);

    await holder.end();
    await holder2.end();
    await observer.end();
  });

  it('WD-2 concurrent replay of C1 after C2 stays ONBOARDING', async () => {
    const { cookies } = await signIn(freshPhone());
    const student = await createStudent(cookies, '并发旧撤回');
    const consents = await agent()
      .get(`/v1/students/${student.studentId}/consents`)
      .set('Cookie', cookies.header());
    const c1 = consents.body.items.find((item: { current: boolean }) => item.current);
    const withdrawn = await agent()
      .post(`/v1/students/${student.studentId}/consents/${c1.id}/withdraw`)
      .set(writeHeaders(cookies))
      .send({ reasonCode: 'GUARDIAN_REQUEST' });
    expect(withdrawn.body.status).toBe('RESTRICTED');
    const latest = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', cookies.header());
    const granted = await agent()
      .post(`/v1/students/${student.studentId}/consents`)
      .set(writeHeaders(cookies))
      .send({
        expectedStudentVersion: latest.body.version,
        acceptances: [{ policyKey: student.policyKey, version: student.policyVersion }],
      });
    expect(granted.body.status).toBe('ONBOARDING');
    const afterGrant = await agent()
      .get(`/v1/students/${student.studentId}/consents`)
      .set('Cookie', cookies.header());
    const c2 = afterGrant.body.items.find((item: { current: boolean }) => item.current);

    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM consent_records WHERE id = $1 FOR UPDATE', [c1.id]);
    const holderPid = await backendPid(holder);

    const first = dispatch(
      agent()
        .post(`/v1/students/${student.studentId}/consents/${c1.id}/withdraw`)
        .set(writeHeaders(cookies))
        .send({ reasonCode: 'GUARDIAN_REQUEST' }),
    );
    const waiter = await waitForWaiterOnHolder(observer, holderPid, 'WD-2 first replay waits');
    const second = dispatch(
      agent()
        .post(`/v1/students/${student.studentId}/consents/${c1.id}/withdraw`)
        .set(writeHeaders(cookies))
        .send({ reasonCode: 'GUARDIAN_REQUEST' }),
    );
    const overlap = await waitForWaiterOnHolder(observer, waiter.waiter_pid, 'WD-2 second replay waits');
    expect(overlap.holder_pid).toBe(waiter.waiter_pid);

    await holder.query('ROLLBACK');
    const [resA, resB] = await Promise.all([first, second]);
    expect([resA.status, resB.status].includes(500)).toBe(false);
    expect(resA.status).toBeLessThan(300);
    expect(resB.status).toBeLessThan(300);
    expect(resA.body.status).toBe('ONBOARDING');
    expect(resB.body.status).toBe('ONBOARDING');
    const current = await prisma.consentRecord.findUniqueOrThrow({ where: { id: c2.id } });
    expect(current.withdrawnAt).toBeNull();
    expect(current.supersededAt).toBeNull();
    const profile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.studentId } });
    expect(profile.status).toBe('ONBOARDING');

    await holder.end();
    await observer.end();
  });

  it('FAIL-2 concurrent wrong OTP attempts increment and last-try races stay linearizable', async () => {
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
    const delivered = inbox.read(`+86${phone.replace(/^\+86/, '')}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    const wrongCode = delivered === '000000' ? '000001' : '000000';
    const challengeId = codeRes.body.challengeId as string;

    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM auth_challenges WHERE id = $1 FOR UPDATE', [challengeId]);
    const holderPid = await backendPid(holder);

    const failA = dispatch(
      agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'VERIFICATION_CODE',
          challengeId,
          code: wrongCode,
          device: { installationId },
        }),
    );
    const waiter = await waitForWaiterOnHolder(observer, holderPid, 'FAIL-2 first wrong waits');
    const failB = dispatch(
      agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'VERIFICATION_CODE',
          challengeId,
          code: wrongCode,
          device: { installationId },
        }),
    );
    const overlap = await waitForWaiterOnHolder(observer, waiter.waiter_pid, 'FAIL-2 second wrong waits');
    expect(overlap.holder_pid).toBe(waiter.waiter_pid);
    await holder.query('ROLLBACK');
    const [resA, resB] = await Promise.all([failA, failB]);
    expect(resA.status).toBe(401);
    expect(resB.status).toBe(401);
    expect([resA.status, resB.status].includes(500)).toBe(false);
    const afterWrong = await prisma.authChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    expect(afterWrong.attemptCount).toBe(2);
    expect(afterWrong.consumedAt).toBeNull();

    await prisma.authChallenge.update({
      where: { id: challengeId },
      data: { attemptCount: 4, lockedAt: null },
    });
    const holder2 = new pg.Client({ connectionString });
    await holder2.connect();
    await holder2.query('BEGIN');
    await holder2.query('SELECT id FROM auth_challenges WHERE id = $1 FOR UPDATE', [challengeId]);
    const holder2Pid = await backendPid(holder2);
    const lastWrong = dispatch(
      agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'VERIFICATION_CODE',
          challengeId,
          code: wrongCode,
          device: { installationId },
        }),
    );
    const lastWaiter = await waitForWaiterOnHolder(observer, holder2Pid, 'FAIL-2 last wrong waits');
    const lastCorrect = dispatch(
      agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'VERIFICATION_CODE',
          challengeId,
          code: delivered,
          device: { installationId },
        }),
    );
    const lastOverlap = await waitForWaiterOnHolder(observer, lastWaiter.waiter_pid, 'FAIL-2 correct waits');
    expect(lastOverlap.holder_pid).toBe(lastWaiter.waiter_pid);
    await holder2.query('ROLLBACK');
    const [wrongRes, correctRes] = await Promise.all([lastWrong, lastCorrect]);
    expect([wrongRes.status, correctRes.status].includes(500)).toBe(false);
    const raced = await prisma.authChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    const created = await prisma.deviceSession.count({
      where: { deviceInstallationDigest: sha256Hex(installationId) },
    });
    if (created === 1) {
      expect(raced.consumedAt).toBeTruthy();
      expect([wrongRes.status, correctRes.status].filter((status) => status === 201)).toHaveLength(1);
    } else {
      expect(created).toBe(0);
      expect(raced.consumedAt).toBeNull();
      expect(raced.lockedAt).toBeTruthy();
      expect(raced.attemptCount).toBeGreaterThanOrEqual(5);
      expect(wrongRes.status).toBe(401);
      expect(correctRes.status).toBe(401);
    }

    await holder.end();
    await holder2.end();
    await observer.end();
  });

  it('CON-3 revoke-first: overlapping student heartbeat cannot refresh a revoked session', async () => {
    const { cookies } = await signIn(freshPhone());
    const student = await createStudent(cookies, '会话心跳');
    const pairing = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(cookies))
      .send({});
    const studentCookies = await consumePairing(pairing.body.pairingId, pairing.body.code, 'con3-student');
    const studentRow = await sessionByCookie(studentCookies.cookies);
    const stale = new Date(Date.now() - 90_000);
    await prisma.deviceSession.update({
      where: { id: studentRow.id },
      data: { lastSeenAt: stale, version: studentRow.version },
    });
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_sessions WHERE id = $1 FOR UPDATE', [studentRow.id]);
    const blockerPid = await backendPid(blocker);

    const revokePromise = dispatch(
      agent()
        .post(`/v1/students/${student.studentId}/device-sessions/${studentRow.id}/revoke`)
        .set(writeHeaders(cookies))
        .send({ reasonCode: 'GUARDIAN_REQUEST' }),
    );
    const revoker = await waitForWaiterOnHolder(observer, blockerPid, 'CON-3 revoke waits on student session');
    const readPromise = dispatch(
      agent().get(`/v1/students/${student.studentId}`).set('Cookie', studentCookies.cookies.header()),
    );
    const overlap = await waitForWaiterOnHolder(observer, revoker.waiter_pid, 'CON-3 student GET waits on revoke');
    expect(overlap.holder_pid).toBe(revoker.waiter_pid);

    await blocker.query('ROLLBACK');
    const revoked = await revokePromise;
    expect(revoked.status).toBeLessThan(300);
    const read = await readPromise;
    expect(read.status).toBe(401);
    expect(read.body.code).toBe('AUTH_SESSION_INVALID');
    const after = await prisma.deviceSession.findUniqueOrThrow({ where: { id: studentRow.id } });
    expect(after.revokedAt).toBeTruthy();
    expect(after.lastSeenAt!.getTime()).toBe(stale.getTime());
    expect(after.version).toBe(studentRow.version);

    await blocker.end();
    await observer.end();
  });

  it('CON-3 step-up vs device revoke: revoke-first does not mint a guardian session', async () => {
    const auth = await signIn(freshPhone());
    const guardian = await sessionByCookie(auth.cookies);
    const student = await createStudent(auth.cookies, '提权重置');
    const pairing = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(auth.cookies))
      .send({});
    const consumed = await consumePairing(pairing.body.pairingId, pairing.body.code, 'con3-step');
    const studentRow = await sessionByCookie(consumed.cookies);
    const codeRes = await agent()
      .post('/v1/auth/code')
      .set(writeHeaders(consumed.cookies))
      .send({ purpose: 'GUARDIAN_STEP_UP', device: { installationId: consumed.installationId } });
    expect(codeRes.status).toBeLessThan(300);
    const stepCode = inbox.read(`+86${auth.phone.replace(/^\+86/, '')}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_sessions WHERE id = $1 FOR UPDATE', [studentRow.id]);
    const blockerPid = await backendPid(blocker);

    const revokePromise = dispatch(
      agent()
        .post(`/v1/students/${student.studentId}/device-sessions/${studentRow.id}/revoke`)
        .set(writeHeaders(auth.cookies))
        .send({ reasonCode: 'GUARDIAN_REQUEST' }),
    );
    const revoker = await waitForWaiterOnHolder(observer, blockerPid, 'step-up revoke waits on session');
    const stepPromise = dispatch(
      agent()
        .post('/v1/auth/session')
        .set(writeHeaders(consumed.cookies))
        .send({
          grantType: 'GUARDIAN_STEP_UP',
          challengeId: codeRes.body.challengeId,
          code: stepCode,
          device: { installationId: consumed.installationId },
        }),
    );
    const overlap = await waitForWaiterOnHolder(observer, revoker.waiter_pid, 'step-up consume waits on revoke');
    expect(overlap.holder_pid).toBe(revoker.waiter_pid);

    await blocker.query('ROLLBACK');
    const revoked = await revokePromise;
    expect(revoked.status).toBeLessThan(300);
    const stepped = await stepPromise;
    expect(stepped.status).toBe(401);
    expect(stepped.body.code).toBe('AUTH_GRANT_INVALID');
    const guardians = await prisma.deviceSession.findMany({
      where: { accountId: guardian.accountId!, scope: 'GUARDIAN', revokedAt: null },
    });
    expect(guardians.some((item) => item.id === guardian.id)).toBe(true);
    expect(guardians.filter((item) => item.id !== guardian.id && item.createdAt.getTime() >= guardian.createdAt.getTime()).length).toBe(0);
    const bound = await prisma.deviceSession.findUniqueOrThrow({ where: { id: studentRow.id } });
    expect(bound.revokedAt).toBeTruthy();

    await blocker.end();
    await observer.end();
  });

  it('CON-3 authVersion bump while a write waits: later commit is 401 and does not persist', async () => {
    const { cookies } = await signIn(freshPhone());
    const student = await createStudent(cookies, '版本提升');
    const session = await sessionByCookie(cookies);
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [session.accountId]);
    const blockerPid = await backendPid(blocker);

    const patchPromise = dispatch(
      agent()
        .patch(`/v1/students/${student.studentId}`)
        .set(writeHeaders(cookies))
        .send({ kind: 'BASIC', expectedVersion: student.version, nickname: '不应写入' }),
    );
    await waitForWaiterOnHolder(observer, blockerPid, 'authVersion patch waits');
    await blocker.query('UPDATE accounts SET auth_version = auth_version + 1 WHERE id = $1', [session.accountId]);
    await blocker.query('COMMIT');
    const patched = await patchPromise;
    expect(patched.status).toBe(401);
    expect(patched.body.code).toBe('AUTH_SESSION_INVALID');
    const stored = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.studentId } });
    expect(stored.nickname).toBe('版本提升');

    await blocker.end();
    await observer.end();
  });

  it('CON-3 overlapping lastSeen refreshes write once and stay monotonic', async () => {
    const { cookies } = await signIn(freshPhone());
    await createStudent(cookies, '心跳一次');
    const row = await sessionByCookie(cookies);
    const stale = new Date(Date.now() - 90_000);
    await prisma.deviceSession.update({
      where: { id: row.id },
      data: { lastSeenAt: stale, version: row.version },
    });
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_sessions WHERE id = $1 FOR UPDATE', [row.id]);
    const blockerPid = await backendPid(blocker);
    const first = dispatch(agent().get('/v1/students').set('Cookie', cookies.header()));
    const firstWaiter = await waitForWaiterOnHolder(observer, blockerPid, 'TIME-2 first GET waits');
    const second = dispatch(agent().get('/v1/students').set('Cookie', cookies.header()));
    await waitForWaiterOnHolder(observer, firstWaiter.waiter_pid, 'TIME-2 second GET waits');
    await blocker.query('ROLLBACK');
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBeLessThan(300);
    expect(b.status).toBeLessThan(300);
    const after = await prisma.deviceSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.lastSeenAt!.getTime()).toBeGreaterThan(stale.getTime());
    expect(after.version).toBe(row.version + 1);
    const again = await agent().get('/v1/students').set('Cookie', cookies.header());
    expect(again.status).toBeLessThan(300);
    const throttled = await prisma.deviceSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(throttled.version).toBe(after.version);
    expect(throttled.lastSeenAt!.getTime()).toBe(after.lastSeenAt!.getTime());

    await blocker.end();
    await observer.end();
  });

  it('CON-3 replay vs link revoke: revoke-first does not return the archived profile', async () => {
    const { cookies } = await signIn(freshPhone());
    const key = randomUUID();
    const docs = await agent().get('/v1/consent-documents?ageBand=UNDER_14').set('Cookie', cookies.header());
    const created = await agent()
      .post('/v1/students')
      .set(writeHeaders(cookies, key))
      .send({
        profile: { nickname: '幂等泄露', avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
        ageConfirmation: { band: 'UNDER_14', source: 'GUARDIAN_DECLARATION' },
        consentAcceptances: [{ policyKey: docs.body.policyKey, version: docs.body.version }],
      });
    expect(created.status).toBe(201);
    const studentId = created.body.profile.id as string;
    const session = await sessionByCookie(cookies);
    const link = await prisma.guardianLink.findFirstOrThrow({
      where: { studentProfileId: studentId, status: 'ACTIVE' },
    });
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM guardian_links WHERE id = $1 FOR UPDATE', [link.id]);
    const blockerPid = await backendPid(blocker);

    const revokePromise = students.revokeGuardianLink(session.accountId!, studentId, 'TEST_REVOKE');
    const revoker = await waitForWaiterOnHolder(observer, blockerPid, 'replay revoke waits');
    const replayPromise = dispatch(
      agent()
        .post('/v1/students')
        .set(writeHeaders(cookies, key))
        .send({
          profile: { nickname: '幂等泄露', avatarPresetId: 'avatar-03', timezone: 'Asia/Shanghai' },
          ageConfirmation: { band: 'UNDER_14', source: 'GUARDIAN_DECLARATION' },
          consentAcceptances: [{ policyKey: docs.body.policyKey, version: docs.body.version }],
        }),
    );
    const overlap = await waitForWaiterOnHolder(observer, revoker.waiter_pid, 'replay waits on revoke');
    expect(overlap.holder_pid).toBe(revoker.waiter_pid);

    await blocker.query('ROLLBACK');
    await revokePromise;
    const replayed = await replayPromise;
    expect(replayed.status).toBe(404);
    expect(replayed.body.code).toBe('RESOURCE_NOT_FOUND');
    const visible = await agent().get(`/v1/students/${studentId}`).set('Cookie', cookies.header());
    expect(visible.status).toBe(404);

    await blocker.end();
    await observer.end();
  });

  async function requestAndConsumeStepUp(studentCookies: CookieJar, installationId: string, phone: string) {
    const codeRes = await agent()
      .post('/v1/auth/code')
      .set(writeHeaders(studentCookies))
      .send({ purpose: 'GUARDIAN_STEP_UP', device: { installationId } });
    expect(codeRes.status).toBeLessThan(300);
    const stepCode = inbox.read(`+86${phone.replace(/^\+86/, '')}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    return { challengeId: codeRes.body.challengeId as string, stepCode };
  }

  it('LOCK-1 / device step-up-first: revoke follows S0→G1 and the new Guardian cookie is 401', async () => {
    const auth = await signIn(freshPhone());
    const student = await createStudent(auth.cookies, '设备提权先');
    const pairing = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(auth.cookies))
      .send({});
    const consumed = await consumePairing(pairing.body.pairingId, pairing.body.code, 'lock1-step');
    const studentRow = await sessionByCookie(consumed.cookies);
    const prepared = await requestAndConsumeStepUp(consumed.cookies, consumed.installationId, auth.phone);
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_sessions WHERE id = $1 FOR UPDATE', [studentRow.id]);
    const blockerPid = await backendPid(blocker);

    const stepPromise = dispatch(
      agent()
        .post('/v1/auth/session')
        .set(writeHeaders(consumed.cookies))
        .send({
          grantType: 'GUARDIAN_STEP_UP',
          challengeId: prepared.challengeId,
          code: prepared.stepCode,
          device: { installationId: consumed.installationId },
        }),
    );
    const stepper = await waitForWaiterOnHolder(observer, blockerPid, 'LOCK-1 step-up waits on S0');
    const revokePromise = dispatch(
      agent()
        .post(`/v1/students/${student.studentId}/device-sessions/${studentRow.id}/revoke`)
        .set(writeHeaders(auth.cookies))
        .send({ reasonCode: 'GUARDIAN_REQUEST' }),
    );
    const overlap = await waitForWaiterOnHolder(observer, stepper.waiter_pid, 'LOCK-1 revoke waits on step-up');
    expect(overlap.holder_pid).toBe(stepper.waiter_pid);

    await blocker.query('ROLLBACK');
    const stepped = await stepPromise;
    expect(stepped.status).toBe(201);
    const g1 = new CookieJar();
    g1.apply(stepped);
    const revoked = await revokePromise;
    expect(revoked.status).toBeLessThan(300);
    const g1Read = await agent().get('/v1/auth/session').set('Cookie', g1.header());
    expect(g1Read.status).toBe(401);
    const g1Row = await sessionByCookie(g1);
    expect(g1Row.revokedAt).toBeTruthy();
    const s0 = await prisma.deviceSession.findUniqueOrThrow({ where: { id: studentRow.id } });
    expect(s0.replacedBySessionId).toBe(g1Row.id);
    expect(s0.revokedAt).toBeTruthy();

    await blocker.end();
    await observer.end();
  });

  it('link revoke-first: overlapping step-up does not mint Guardian; no student cookie revival', async () => {
    const auth = await signIn(freshPhone());
    const student = await createStudent(auth.cookies, '关系撤销先');
    const pairing = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(auth.cookies))
      .send({});
    const consumed = await consumePairing(pairing.body.pairingId, pairing.body.code, 'link-rev-first');
    const studentRow = await sessionByCookie(consumed.cookies);
    const guardian = await sessionByCookie(auth.cookies);
    const prepared = await requestAndConsumeStepUp(consumed.cookies, consumed.installationId, auth.phone);
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_sessions WHERE id = $1 FOR UPDATE', [studentRow.id]);
    const blockerPid = await backendPid(blocker);

    const revokePromise = students.revokeGuardianLink(guardian.accountId!, student.studentId, 'TEST_LINK_REVOKE');
    const revoker = await waitForWaiterOnHolder(observer, blockerPid, 'link revoke waits on S0');
    const stepPromise = dispatch(
      agent()
        .post('/v1/auth/session')
        .set(writeHeaders(consumed.cookies))
        .send({
          grantType: 'GUARDIAN_STEP_UP',
          challengeId: prepared.challengeId,
          code: prepared.stepCode,
          device: { installationId: consumed.installationId },
        }),
    );
    const overlap = await waitForWaiterOnHolder(observer, revoker.waiter_pid, 'step-up waits on link revoke');
    expect(overlap.holder_pid).toBe(revoker.waiter_pid);

    await blocker.query('ROLLBACK');
    await revokePromise;
    const stepped = await stepPromise;
    expect(stepped.status).toBe(401);
    const challenge = await prisma.authChallenge.findUniqueOrThrow({ where: { id: prepared.challengeId } });
    expect(challenge.consumedAt).toBeNull();

    await blocker.end();
    await observer.end();
  });

  it('link step-up-first: G1 stays valid but the target profile is 404', async () => {
    const auth = await signIn(freshPhone());
    const student = await createStudent(auth.cookies, '关系提权先');
    const pairing = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(auth.cookies))
      .send({});
    const consumed = await consumePairing(pairing.body.pairingId, pairing.body.code, 'link-step-first');
    const studentRow = await sessionByCookie(consumed.cookies);
    const guardian = await sessionByCookie(auth.cookies);
    const prepared = await requestAndConsumeStepUp(consumed.cookies, consumed.installationId, auth.phone);
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_sessions WHERE id = $1 FOR UPDATE', [studentRow.id]);
    const blockerPid = await backendPid(blocker);

    const stepPromise = dispatch(
      agent()
        .post('/v1/auth/session')
        .set(writeHeaders(consumed.cookies))
        .send({
          grantType: 'GUARDIAN_STEP_UP',
          challengeId: prepared.challengeId,
          code: prepared.stepCode,
          device: { installationId: consumed.installationId },
        }),
    );
    const stepper = await waitForWaiterOnHolder(observer, blockerPid, 'link step-up waits on S0');
    const revokePromise = students.revokeGuardianLink(guardian.accountId!, student.studentId, 'TEST_LINK_REVOKE');
    const overlap = await waitForWaiterOnHolder(observer, stepper.waiter_pid, 'link revoke waits on step-up');
    expect(overlap.holder_pid).toBe(stepper.waiter_pid);

    await blocker.query('ROLLBACK');
    const stepped = await stepPromise;
    expect(stepped.status).toBe(201);
    const g1 = new CookieJar();
    g1.apply(stepped);
    await revokePromise;
    const sessionRead = await agent().get('/v1/auth/session').set('Cookie', g1.header());
    expect(sessionRead.status).toBeLessThan(300);
    const profileRead = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', g1.header());
    expect(profileRead.status).toBe(404);
    const g1Row = await sessionByCookie(g1);
    expect(g1Row.revokedAt).toBeNull();

    await blocker.end();
    await observer.end();
  });

  it('consent revoke-first: overlapping step-up does not mint Guardian', async () => {
    const auth = await signIn(freshPhone());
    const student = await createStudent(auth.cookies, '同意撤销先');
    const pairing = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(auth.cookies))
      .send({});
    const consumed = await consumePairing(pairing.body.pairingId, pairing.body.code, 'consent-rev-first');
    const studentRow = await sessionByCookie(consumed.cookies);
    const consents = await agent()
      .get(`/v1/students/${student.studentId}/consents`)
      .set('Cookie', auth.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const prepared = await requestAndConsumeStepUp(consumed.cookies, consumed.installationId, auth.phone);
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_sessions WHERE id = $1 FOR UPDATE', [studentRow.id]);
    const blockerPid = await backendPid(blocker);

    const withdrawPromise = dispatch(
      agent()
        .post(`/v1/students/${student.studentId}/consents/${current.id}/withdraw`)
        .set(writeHeaders(auth.cookies))
        .send({ reasonCode: 'GUARDIAN_REQUEST' }),
    );
    const revoker = await waitForWaiterOnHolder(observer, blockerPid, 'consent revoke waits on S0');
    const stepPromise = dispatch(
      agent()
        .post('/v1/auth/session')
        .set(writeHeaders(consumed.cookies))
        .send({
          grantType: 'GUARDIAN_STEP_UP',
          challengeId: prepared.challengeId,
          code: prepared.stepCode,
          device: { installationId: consumed.installationId },
        }),
    );
    const overlap = await waitForWaiterOnHolder(observer, revoker.waiter_pid, 'step-up waits on consent revoke');
    expect(overlap.holder_pid).toBe(revoker.waiter_pid);

    await blocker.query('ROLLBACK');
    const withdrawn = await withdrawPromise;
    expect(withdrawn.status).toBeLessThan(300);
    const stepped = await stepPromise;
    expect(stepped.status).toBe(401);
    const challenge = await prisma.authChallenge.findUniqueOrThrow({ where: { id: prepared.challengeId } });
    expect(challenge.consumedAt).toBeNull();

    await blocker.end();
    await observer.end();
  });

  it('consent step-up-first: G1 keeps only the RESTRICTED min path', async () => {
    const auth = await signIn(freshPhone());
    const student = await createStudent(auth.cookies, '同意提权先');
    const pairing = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(auth.cookies))
      .send({});
    const consumed = await consumePairing(pairing.body.pairingId, pairing.body.code, 'consent-step-first');
    const studentRow = await sessionByCookie(consumed.cookies);
    const consents = await agent()
      .get(`/v1/students/${student.studentId}/consents`)
      .set('Cookie', auth.cookies.header());
    const current = consents.body.items.find((item: { current: boolean }) => item.current);
    const prepared = await requestAndConsumeStepUp(consumed.cookies, consumed.installationId, auth.phone);
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_sessions WHERE id = $1 FOR UPDATE', [studentRow.id]);
    const blockerPid = await backendPid(blocker);

    const stepPromise = dispatch(
      agent()
        .post('/v1/auth/session')
        .set(writeHeaders(consumed.cookies))
        .send({
          grantType: 'GUARDIAN_STEP_UP',
          challengeId: prepared.challengeId,
          code: prepared.stepCode,
          device: { installationId: consumed.installationId },
        }),
    );
    const stepper = await waitForWaiterOnHolder(observer, blockerPid, 'consent step-up waits on S0');
    const withdrawPromise = dispatch(
      agent()
        .post(`/v1/students/${student.studentId}/consents/${current.id}/withdraw`)
        .set(writeHeaders(auth.cookies))
        .send({ reasonCode: 'GUARDIAN_REQUEST' }),
    );
    const overlap = await waitForWaiterOnHolder(observer, stepper.waiter_pid, 'consent revoke waits on step-up');
    expect(overlap.holder_pid).toBe(stepper.waiter_pid);

    await blocker.query('ROLLBACK');
    const stepped = await stepPromise;
    expect(stepped.status).toBe(201);
    const g1 = new CookieJar();
    g1.apply(stepped);
    const withdrawn = await withdrawPromise;
    expect(withdrawn.status).toBeLessThan(300);
    const sessionRead = await agent().get('/v1/auth/session').set('Cookie', g1.header());
    expect(sessionRead.status).toBeLessThan(300);
    const profile = await agent().get(`/v1/students/${student.studentId}`).set('Cookie', g1.header());
    expect(profile.status).toBeLessThan(300);
    expect(profile.body.status).toBe('RESTRICTED');
    const pairingDenied = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(g1))
      .send({});
    expect(pairingDenied.status).toBe(403);
    const g1Row = await sessionByCookie(g1);
    expect(g1Row.revokedAt).toBeNull();

    await blocker.end();
    await observer.end();
  });

  it('TIME-3 challenge, pairing and session idle/absolute expire while waiting on locks', async () => {
    const auth = await signIn(freshPhone());
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
    const challengeBlocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await challengeBlocker.connect();
    await challengeBlocker.query('BEGIN');
    await challengeBlocker.query('SELECT id FROM auth_challenges WHERE id = $1 FOR UPDATE', [codeRes.body.challengeId]);
    const challengePid = await backendPid(challengeBlocker);
    const consumePromise = dispatch(
      agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'VERIFICATION_CODE',
          challengeId: codeRes.body.challengeId,
          code: delivered,
          device: { installationId, label: 'time3' },
        }),
    );
    await waitForWaiterOnHolder(observer, challengePid, 'TIME-3 consume waits on challenge');
    await challengeBlocker.query('UPDATE auth_challenges SET expires_at = clock_timestamp() - interval \'1 second\' WHERE id = $1', [
      codeRes.body.challengeId,
    ]);
    await challengeBlocker.query('COMMIT');
    const consumed = await consumePromise;
    expect(consumed.status).toBe(401);

    const student = await createStudent(auth.cookies, '时间配对');
    const pairing = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(auth.cookies))
      .send({});
    const pairingBlocker = new pg.Client({ connectionString });
    await pairingBlocker.connect();
    await pairingBlocker.query('BEGIN');
    await pairingBlocker.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [pairing.body.pairingId]);
    const pairingPid = await backendPid(pairingBlocker);
    const pairingPromise = dispatch(
      agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'PAIRING_CODE',
          pairingId: pairing.body.pairingId,
          code: pairing.body.code,
          device: { installationId: randomUUID(), label: 'time3-pair' },
        }),
    );
    await waitForWaiterOnHolder(observer, pairingPid, 'TIME-3 consume waits on pairing');
    await pairingBlocker.query('UPDATE device_pairings SET expires_at = clock_timestamp() - interval \'1 second\' WHERE id = $1', [
      pairing.body.pairingId,
    ]);
    await pairingBlocker.query('COMMIT');
    const paired = await pairingPromise;
    expect(paired.status).toBe(401);

    const guardian = await sessionByCookie(auth.cookies);
    const idleBlocker = new pg.Client({ connectionString });
    await idleBlocker.connect();
    await idleBlocker.query('BEGIN');
    await idleBlocker.query('SELECT id FROM device_sessions WHERE id = $1 FOR UPDATE', [guardian.id]);
    const idlePid = await backendPid(idleBlocker);
    const idlePromise = dispatch(agent().get('/v1/students').set('Cookie', auth.cookies.header()));
    await waitForWaiterOnHolder(observer, idlePid, 'TIME-3 GET waits on session');
    await idleBlocker.query(
      "UPDATE device_sessions SET last_seen_at = clock_timestamp() - interval '3 hours' WHERE id = $1",
      [guardian.id],
    );
    await idleBlocker.query('COMMIT');
    const idle = await idlePromise;
    expect(idle.status).toBe(401);

    const shortToken = randomUUID();
    const short = await prisma.deviceSession.create({
      data: {
        scope: 'GUARDIAN',
        accountId: guardian.accountId!,
        origin: ORIGIN,
        credentialDigest: sha256Hex(shortToken),
        csrfDigest: sha256Hex('csrf'),
        accountAuthVersionAtIssue: guardian.accountAuthVersionAtIssue,
        deviceInstallationDigest: guardian.deviceInstallationDigest,
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        stepUpVerifiedAt: new Date(),
        expiresAt: new Date(Date.now() + 1500),
      },
    });
    const absBlocker = new pg.Client({ connectionString });
    await absBlocker.connect();
    await absBlocker.query('BEGIN');
    await absBlocker.query('SELECT id FROM device_sessions WHERE id = $1 FOR UPDATE', [short.id]);
    const absPid = await backendPid(absBlocker);
    const absPromise = dispatch(agent().get('/v1/auth/session').set('Cookie', `stp_session=${shortToken}`));
    await waitForWaiterOnHolder(observer, absPid, 'TIME-3 absolute waits on session');
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await absBlocker.query('COMMIT');
    const abs = await absPromise;
    expect(abs.status).toBe(401);

    await challengeBlocker.end();
    await pairingBlocker.end();
    await idleBlocker.end();
    await absBlocker.end();
    await observer.end();
  });

  it('HB-2 authVersion invalidation vs GET heartbeat leaves lastSeen unchanged', async () => {
    const auth = await signIn(freshPhone());
    const guardian = await sessionByCookie(auth.cookies);
    const stale = new Date(Date.now() - 90_000);
    await prisma.deviceSession.update({
      where: { id: guardian.id },
      data: { lastSeenAt: stale, version: guardian.version },
    });
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_sessions WHERE id = $1 FOR UPDATE', [guardian.id]);
    const blockerPid = await backendPid(blocker);
    const readPromise = dispatch(agent().get('/v1/students').set('Cookie', auth.cookies.header()));
    await waitForWaiterOnHolder(observer, blockerPid, 'HB-2 authVersion GET waits');
    await blocker.query('UPDATE accounts SET auth_version = auth_version + 1 WHERE id = $1', [guardian.accountId]);
    await blocker.query('COMMIT');
    const read = await readPromise;
    expect(read.status).toBe(401);
    const after = await prisma.deviceSession.findUniqueOrThrow({ where: { id: guardian.id } });
    expect(after.lastSeenAt!.getTime()).toBe(stale.getTime());
    expect(after.version).toBe(guardian.version);
    await blocker.end();
    await observer.end();
  });

  it('HB-2 link revoke vs student GET heartbeat leaves lastSeen unchanged', async () => {
    const auth = await signIn(freshPhone());
    const student = await createStudent(auth.cookies, 'HB2关系');
    const pairing = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(auth.cookies))
      .send({});
    const consumed = await consumePairing(pairing.body.pairingId, pairing.body.code, 'hb2-link');
    const row = await sessionByCookie(consumed.cookies);
    const stale = new Date(Date.now() - 90_000);
    await prisma.deviceSession.update({
      where: { id: row.id },
      data: { lastSeenAt: stale, version: row.version },
    });
    const link = await prisma.guardianLink.findFirstOrThrow({
      where: { studentProfileId: student.studentId, status: 'ACTIVE' },
    });
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_sessions WHERE id = $1 FOR UPDATE', [row.id]);
    const blockerPid = await backendPid(blocker);
    const readPromise = dispatch(
      agent().get(`/v1/students/${student.studentId}`).set('Cookie', consumed.cookies.header()),
    );
    await waitForWaiterOnHolder(observer, blockerPid, 'HB-2 link GET waits');
    await blocker.query(
      `UPDATE guardian_links SET status = 'REVOKED', revoked_at = clock_timestamp(), revocation_reason_code = 'TEST' WHERE id = $1`,
      [link.id],
    );
    await blocker.query('COMMIT');
    const read = await readPromise;
    expect(read.status).toBe(401);
    const after = await prisma.deviceSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.lastSeenAt!.getTime()).toBe(stale.getTime());
    expect(after.version).toBe(row.version);
    await blocker.end();
    await observer.end();
  });

  it('HB-2 policy publish vs student GET heartbeat leaves lastSeen unchanged', async () => {
    const auth = await signIn(freshPhone());
    const student = await createStudent(auth.cookies, 'HB2政策');
    const pairing = await agent()
      .post(`/v1/students/${student.studentId}/pairings`)
      .set(writeHeaders(auth.cookies))
      .send({});
    const consumed = await consumePairing(pairing.body.pairingId, pairing.body.code, 'hb2-policy');
    const row = await sessionByCookie(consumed.cookies);
    const stale = new Date(Date.now() - 90_000);
    await prisma.deviceSession.update({
      where: { id: row.id },
      data: { lastSeenAt: stale, version: row.version },
    });
    const policy = await prisma.consentPolicy.findUniqueOrThrow({
      where: { policyKey_locale: { policyKey: student.policyKey, locale: 'zh-CN' } },
    });
    const newDocumentId = randomUUID();
    const newVersion = `hb2-${newDocumentId.slice(0, 8)}`;
    const body = 'HB-2 政策发布测试正文';
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM consent_policies WHERE id = $1 FOR UPDATE', [policy.id]);
    const blockerPid = await backendPid(blocker);
    const readPromise = dispatch(
      agent().get(`/v1/students/${student.studentId}`).set('Cookie', consumed.cookies.header()),
    );
    await waitForWaiterOnHolder(observer, blockerPid, 'HB-2 policy GET waits');
    await blocker.query(
      `INSERT INTO consent_document_versions (
         id, consent_policy_id, version, content_format, content_body, content_digest,
         scope_canonical_json, scope_digest, scope_schema_version, digest_algorithm_version,
         published_at, created_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'text/plain', $4, $5, $6, $7, '1', 'sha256-v1', clock_timestamp(), clock_timestamp()
       )`,
      [
        newDocumentId,
        policy.id,
        newVersion,
        body,
        digestCanonical(body),
        JSON.stringify(TEST_POLICY_SCOPE),
        digestCanonical(TEST_POLICY_SCOPE),
      ],
    );
    await blocker.query(
      'UPDATE consent_policies SET current_document_version_id = $1, updated_at = clock_timestamp() WHERE id = $2',
      [newDocumentId, policy.id],
    );
    await blocker.query('COMMIT');
    const read = await readPromise;
    expect(read.status).toBe(401);
    const after = await prisma.deviceSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.lastSeenAt!.getTime()).toBe(stale.getTime());
    expect(after.version).toBe(row.version);
    await blocker.end();
    await observer.end();
  });

  it('HB-2 session revoke vs GET heartbeat leaves lastSeen unchanged', async () => {
    const auth = await signIn(freshPhone());
    const guardian = await sessionByCookie(auth.cookies);
    const stale = new Date(Date.now() - 90_000);
    await prisma.deviceSession.update({
      where: { id: guardian.id },
      data: { lastSeenAt: stale, version: guardian.version },
    });
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_sessions WHERE id = $1 FOR UPDATE', [guardian.id]);
    const blockerPid = await backendPid(blocker);
    const readPromise = dispatch(agent().get('/v1/students').set('Cookie', auth.cookies.header()));
    await waitForWaiterOnHolder(observer, blockerPid, 'HB-2 session GET waits');
    await blocker.query(
      `UPDATE device_sessions SET revoked_at = clock_timestamp(), revocation_reason_code = 'TEST' WHERE id = $1`,
      [guardian.id],
    );
    await blocker.query('COMMIT');
    const read = await readPromise;
    expect(read.status).toBe(401);
    const after = await prisma.deviceSession.findUniqueOrThrow({ where: { id: guardian.id } });
    expect(after.lastSeenAt!.getTime()).toBe(stale.getTime());
    expect(after.version).toBe(guardian.version);
    await blocker.end();
    await observer.end();
  });

  it('concurrent SIGN_IN codes for the same identity and device are 201+429 with one live challenge', async () => {
    const phone = freshPhone();
    const installationId = randomUUID();
    const destination = `+86${phone}`;
    const advisory = hmacHex(runtime.value.keys.advisory, `PHONE_OTP:PHONE:${destination}`);
    const holder = new pg.Client({ connectionString });
    const observer = await observerClient();
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [advisory]);
    const holderPid = await backendPid(holder);
    const body = {
      purpose: 'SIGN_IN' as const,
      identity: { kind: 'PHONE' as const, value: phone },
      device: { installationId },
    };
    const firstPromise = dispatch(agent().post('/v1/auth/code').set('Origin', ORIGIN).send(body));
    await waitForAdvisoryWaiter(observer, holderPid, 'first code waits on advisory');
    const secondPromise = dispatch(agent().post('/v1/auth/code').set('Origin', ORIGIN).send(body));
    await holder.query('ROLLBACK');
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 429]);
    const live = await prisma.authChallenge.findMany({
      where: {
        deviceInstallationDigest: sha256Hex(installationId),
        consumedAt: null,
        lockedAt: null,
      },
    });
    expect(live).toHaveLength(1);
    await holder.end();
    await observer.end();
  });

  it('failed OTP lock uses post-lock clock after waiting past expiry', async () => {
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
    const delivered = inbox.read(`+86${phone.replace(/^\+86/, '')}`, process.env.AUTH_TEST_INBOX_KEY ?? '');
    const wrong = delivered === '000000' ? '000001' : '000000';
    await prisma.authChallenge.update({
      where: { id: codeRes.body.challengeId },
      data: { attemptCount: 4 },
    });
    const blocker = new pg.Client({ connectionString });
    const observer = await observerClient();
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM auth_challenges WHERE id = $1 FOR UPDATE', [codeRes.body.challengeId]);
    const blockerPid = await backendPid(blocker);
    const failPromise = dispatch(
      agent()
        .post('/v1/auth/session')
        .set('Origin', ORIGIN)
        .send({
          grantType: 'VERIFICATION_CODE',
          challengeId: codeRes.body.challengeId,
          code: wrong,
          device: { installationId },
        }),
    );
    await waitForWaiterOnHolder(observer, blockerPid, 'fail-lock waits on challenge');
    await blocker.query(
      `UPDATE auth_challenges SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [codeRes.body.challengeId],
    );
    await blocker.query('COMMIT');
    const failed = await failPromise;
    expect(failed.status).toBe(401);
    const row = await prisma.authChallenge.findUniqueOrThrow({ where: { id: codeRes.body.challengeId } });
    expect(row.attemptCount).toBe(5);
    expect(row.lockedAt).toBeTruthy();
    expect(row.lockedAt!.getTime()).toBeGreaterThanOrEqual(row.expiresAt.getTime());
    await blocker.end();
    await observer.end();
  });
});

