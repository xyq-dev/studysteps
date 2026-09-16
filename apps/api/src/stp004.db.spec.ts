import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { hasIsolatedPostgres, loadStp004Env } from './test/load-stp004-env';
import { digestCanonical } from './common/crypto';
import { backendPid, waitForWaiterOnHolder } from './test/lock-barrier';

const connectionString = process.env.STP004_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

describe.skipIf(!hasIsolatedPostgres)('STP 004 PostgreSQL constraints and overlapping transactions', () => {
  const prisma = new PrismaClient({ datasourceUrl: connectionString });
  const admin = process.env.STP004_ADMIN_DATABASE_URL
    ? new PrismaClient({ datasourceUrl: process.env.STP004_ADMIN_DATABASE_URL })
    : prisma;

  beforeAll(async () => {
    loadStp004Env();
    await prisma.$connect();
    const scope = {
      nickname: true,
      avatar: true,
      age: true,
      educationSnapshot: true,
      timezone: true,
      guardianLink: true,
      authDevice: true,
      consentAudit: true,
    };
    for (const [policyKey, body] of [
      ['TEST_CHILD_CORE_SERVICE', '测试儿童核心服务告知（非正式）'],
      ['TEST_MINOR_CORE_SERVICE', '测试未成年人核心服务告知（非正式）'],
    ] as const) {
      const existing = await prisma.consentPolicy.findUnique({
        where: { policyKey_locale: { policyKey, locale: 'zh-CN' } },
      });
      if (existing?.currentDocumentVersionId) {
        continue;
      }
      const policy =
        existing ??
        (await prisma.consentPolicy.create({
          data: { policyKey, locale: 'zh-CN' },
        }));
      const doc = await prisma.consentDocumentVersion.create({
        data: {
          consentPolicyId: policy.id,
          version: 'test-v1',
          contentFormat: 'text/plain',
          contentBody: `${body}\n本文件仅用于隔离测试，不是已批准的正式告知。`,
          contentDigest: digestCanonical(body),
          scopeCanonicalJson: JSON.stringify(scope),
          scopeDigest: digestCanonical(scope),
          scopeSchemaVersion: '1',
          digestAlgorithmVersion: 'sha256-v1',
          publishedAt: new Date(),
        },
      });
      await prisma.consentPolicy.update({
        where: { id: policy.id },
        data: { currentDocumentVersionId: doc.id },
      });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    if (admin !== prisma) {
      await admin.$disconnect();
    }
  });

  async function seedAccount() {
    return prisma.account.create({ data: { status: 'ACTIVE' } });
  }

  it('DB-1 rejects a second active primary guardian', async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    const student = await prisma.studentProfile.create({
      data: {
        nickname: '约束A',
        avatarPresetId: 'avatar-03',
        ageBand: 'UNDER_14',
        ageConfirmationSource: 'GUARDIAN_DECLARATION',
        ageConfirmedAt: new Date(),
        ageConfirmedByAccountId: a.id,
        createdByAccountId: a.id,
      },
    });
    await prisma.guardianLink.create({
      data: { accountId: a.id, studentProfileId: student.id },
    });
    await expect(
      prisma.guardianLink.create({
        data: { accountId: b.id, studentProfileId: student.id },
      }),
    ).rejects.toThrow(/unique|guardian_links_one_active_primary/i);
  });

  it('DB-2 rejects an illegal DeviceSession subject mix', async () => {
    const account = await seedAccount();
    await expect(
      prisma.$executeRaw`
        INSERT INTO device_sessions (
          id, scope, account_id, origin, credential_digest, csrf_digest,
          device_installation_digest, authenticated_at, expires_at, created_at, updated_at
        ) VALUES (
          ${randomUUID()}::uuid, 'STUDENT', ${account.id}::uuid, 'http://127.0.0.1:5173',
          ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, now(), now() + interval '1 day', now(), now()
        )
      `,
    ).rejects.toThrow(/device_sessions_scope_ck|check/i);
  });

  it('DB-5 rejects mutating a published consent document', async () => {
    const policy = await prisma.consentPolicy.findFirst({
      where: { currentDocumentVersionId: { not: null } },
    });
    expect(policy?.currentDocumentVersionId).toBeTruthy();
    await expect(
      prisma.consentDocumentVersion.update({
        where: { id: policy!.currentDocumentVersionId! },
        data: { contentBody: 'tamper' },
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it('DB-6 rejects pointing current policy at a draft', async () => {
    const policy = await prisma.consentPolicy.findFirstOrThrow({
      where: { policyKey: 'TEST_CHILD_CORE_SERVICE' },
    });
    const draft = await prisma.consentDocumentVersion.create({
      data: {
        consentPolicyId: policy.id,
        version: `draft-${randomUUID().slice(0, 8)}`,
        contentFormat: 'text/plain',
        contentBody: 'draft',
        contentDigest: 'x',
        scopeCanonicalJson: '{}',
        scopeDigest: 'x',
        scopeSchemaVersion: '1',
        digestAlgorithmVersion: 'sha256-v1',
      },
    });
    await expect(
      prisma.consentPolicy.update({
        where: { id: policy.id },
        data: { currentDocumentVersionId: draft.id },
      }),
    ).rejects.toThrow(/published version|current policy pointer/i);
  });

  it('PAIR-2 / AUTH-3 overlapping connections linearize on one row', async () => {
    const clientA = new pg.Client({ connectionString });
    const clientB = new pg.Client({ connectionString });
    await clientA.connect();
    await clientB.connect();
    const account = await seedAccount();
    const student = await prisma.studentProfile.create({
      data: {
        nickname: '并发',
        avatarPresetId: 'avatar-03',
        ageBand: 'UNDER_14',
        ageConfirmationSource: 'GUARDIAN_DECLARATION',
        ageConfirmedAt: new Date(),
        ageConfirmedByAccountId: account.id,
        createdByAccountId: account.id,
      },
    });
    const link = await prisma.guardianLink.create({
      data: { accountId: account.id, studentProfileId: student.id },
    });
    const guardian = await prisma.deviceSession.create({
      data: {
        scope: 'GUARDIAN',
        accountId: account.id,
        origin: 'http://127.0.0.1:5173',
        credentialDigest: randomUUID(),
        csrfDigest: randomUUID(),
        accountAuthVersionAtIssue: 1,
        deviceInstallationDigest: randomUUID(),
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const pairing = await prisma.devicePairing.create({
      data: {
        studentProfileId: student.id,
        issuedByGuardianLinkId: link.id,
        createdByAccountId: account.id,
        createdBySessionId: guardian.id,
        codeDigest: randomUUID(),
        digestKeyVersion: 'v1',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await clientA.query('BEGIN');
    await clientA.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [account.id]);
    await clientA.query('SELECT id FROM student_profiles WHERE id = $1 FOR UPDATE', [student.id]);
    await clientA.query('SELECT id FROM guardian_links WHERE id = $1 FOR UPDATE', [link.id]);
    await clientA.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [pairing.id]);

    let bAcquired = false;
    const waiter = (async () => {
      await clientB.query('BEGIN');
      await clientB.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [account.id]);
      await clientB.query('SELECT id FROM student_profiles WHERE id = $1 FOR UPDATE', [student.id]);
      await clientB.query('SELECT id FROM guardian_links WHERE id = $1 FOR UPDATE', [link.id]);
      await clientB.query('SELECT id FROM device_pairings WHERE id = $1 FOR UPDATE', [pairing.id]);
      bAcquired = true;
    })();

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bAcquired).toBe(false);
    await clientA.query('UPDATE device_pairings SET revoked_at = now() WHERE id = $1 AND consumed_at IS NULL', [
      pairing.id,
    ]);
    await clientA.query('COMMIT');
    await waiter;
    const locked = await clientB.query('SELECT revoked_at, consumed_at FROM device_pairings WHERE id = $1', [
      pairing.id,
    ]);
    expect(locked.rows[0].revoked_at).toBeTruthy();
    expect(locked.rows[0].consumed_at).toBeNull();
    await clientB.query('ROLLBACK');
    await clientA.end();
    await clientB.end();
  });

  it('DB-3 rejects a second current consent for the same policy', async () => {
    const account = await seedAccount();
    const student = await prisma.studentProfile.create({
      data: {
        nickname: '双授权',
        avatarPresetId: 'avatar-03',
        ageBand: 'UNDER_14',
        ageConfirmationSource: 'GUARDIAN_DECLARATION',
        ageConfirmedAt: new Date(),
        ageConfirmedByAccountId: account.id,
        createdByAccountId: account.id,
      },
    });
    const link = await prisma.guardianLink.create({
      data: { accountId: account.id, studentProfileId: student.id },
    });
    const policy = await prisma.consentPolicy.findFirstOrThrow({
      where: { policyKey: 'TEST_CHILD_CORE_SERVICE' },
    });
    const first = await prisma.consentRecord.create({
      data: {
        studentProfileId: student.id,
        guardianLinkId: link.id,
        consentPolicyId: policy.id,
        documentVersionId: policy.currentDocumentVersionId!,
        scopeSnapshot: '{}',
        scopeDigest: 'x',
        scopeSchemaVersion: '1',
        digestAlgorithmVersion: 'sha256-v1',
        ageBandSnapshot: 'UNDER_14',
        grantedByAccountId: account.id,
        grantedAt: new Date(),
      },
    });
    expect(first.id).toBeTruthy();
    await expect(
      prisma.consentRecord.create({
        data: {
          studentProfileId: student.id,
          guardianLinkId: link.id,
          consentPolicyId: policy.id,
          documentVersionId: policy.currentDocumentVersionId!,
          scopeSnapshot: '{}',
          scopeDigest: 'y',
          scopeSchemaVersion: '1',
          digestAlgorithmVersion: 'sha256-v1',
          ageBandSnapshot: 'UNDER_14',
          grantedByAccountId: account.id,
          grantedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/unique|consent_records_one_current/i);
  });

  it('DB-4 rejects crossed link / student / account / consumed session bindings', async () => {
    const accountA = await seedAccount();
    const accountB = await seedAccount();
    const studentA = await prisma.studentProfile.create({
      data: {
        nickname: '错配A',
        avatarPresetId: 'avatar-03',
        ageBand: 'UNDER_14',
        ageConfirmationSource: 'GUARDIAN_DECLARATION',
        ageConfirmedAt: new Date(),
        ageConfirmedByAccountId: accountA.id,
        createdByAccountId: accountA.id,
      },
    });
    const studentB = await prisma.studentProfile.create({
      data: {
        nickname: '错配B',
        avatarPresetId: 'avatar-03',
        ageBand: 'UNDER_14',
        ageConfirmationSource: 'GUARDIAN_DECLARATION',
        ageConfirmedAt: new Date(),
        ageConfirmedByAccountId: accountB.id,
        createdByAccountId: accountB.id,
      },
    });
    const linkA = await prisma.guardianLink.create({
      data: { accountId: accountA.id, studentProfileId: studentA.id },
    });
    await prisma.guardianLink.create({
      data: { accountId: accountB.id, studentProfileId: studentB.id },
    });
    const policy = await prisma.consentPolicy.findFirstOrThrow({
      where: { policyKey: 'TEST_CHILD_CORE_SERVICE' },
    });
    await expect(
      prisma.consentRecord.create({
        data: {
          studentProfileId: studentB.id,
          guardianLinkId: linkA.id,
          consentPolicyId: policy.id,
          documentVersionId: policy.currentDocumentVersionId!,
          scopeSnapshot: '{}',
          scopeDigest: 'z',
          scopeSchemaVersion: '1',
          digestAlgorithmVersion: 'sha256-v1',
          ageBandSnapshot: 'UNDER_14',
          grantedByAccountId: accountA.id,
          grantedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/foreign key|consent_records_link_fk/i);

    const guardian = await prisma.deviceSession.create({
      data: {
        scope: 'GUARDIAN',
        accountId: accountA.id,
        origin: 'http://127.0.0.1:5173',
        credentialDigest: randomUUID(),
        csrfDigest: randomUUID(),
        accountAuthVersionAtIssue: 1,
        deviceInstallationDigest: randomUUID(),
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const foreignStudentSession = await prisma.deviceSession.create({
      data: {
        scope: 'STUDENT',
        studentProfileId: studentB.id,
        issuedByGuardianLinkId: (await prisma.guardianLink.findFirstOrThrow({
          where: { studentProfileId: studentB.id },
        })).id,
        issuedByAccountId: accountB.id,
        origin: 'http://127.0.0.1:5173',
        credentialDigest: randomUUID(),
        csrfDigest: randomUUID(),
        issuerAuthVersionAtIssue: 1,
        deviceInstallationDigest: randomUUID(),
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      prisma.devicePairing.create({
        data: {
          studentProfileId: studentA.id,
          issuedByGuardianLinkId: linkA.id,
          createdByAccountId: accountA.id,
          createdBySessionId: guardian.id,
          codeDigest: randomUUID(),
          digestKeyVersion: 'v1',
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: new Date(),
          consumedBySessionId: foreignStudentSession.id,
        },
      }),
    ).rejects.toThrow(/foreign key|device_pairings_consumed_session_fk/i);
  });

  it('AUTH-3 two connections serialize first identity creation via advisory lock', async () => {
    const key = `stp004-auth3-${randomUUID()}`;
    const clientA = new pg.Client({ connectionString });
    const clientB = new pg.Client({ connectionString });
    await clientA.connect();
    await clientB.connect();
    await clientA.query('BEGIN');
    await clientA.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    let bEntered = false;
    const waiter = (async () => {
      await clientB.query('BEGIN');
      await clientB.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      bEntered = true;
    })();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bEntered).toBe(false);
    await clientA.query('COMMIT');
    await waiter;
    expect(bEntered).toBe(true);
    await clientB.query('COMMIT');
    await clientA.end();
    await clientB.end();
  });

  it('TX-1 rolled-back create, grant, consume and revoke leave no half-state', async () => {
    const account = await seedAccount();
    const policy = await prisma.consentPolicy.findFirstOrThrow({
      where: { policyKey: 'TEST_CHILD_CORE_SERVICE', currentDocumentVersionId: { not: null } },
    });
    let studentId = '';
    let linkId = '';
    let consentId = '';
    await expect(
      prisma.$transaction(async (tx) => {
        const student = await tx.studentProfile.create({
          data: {
            nickname: '半建档',
            avatarPresetId: 'avatar-03',
            ageBand: 'UNDER_14',
            ageConfirmationSource: 'GUARDIAN_DECLARATION',
            ageConfirmedAt: new Date(),
            ageConfirmedByAccountId: account.id,
            createdByAccountId: account.id,
          },
        });
        studentId = student.id;
        const link = await tx.guardianLink.create({
          data: { accountId: account.id, studentProfileId: student.id },
        });
        linkId = link.id;
        const consent = await tx.consentRecord.create({
          data: {
            studentProfileId: student.id,
            guardianLinkId: link.id,
            consentPolicyId: policy.id,
            documentVersionId: policy.currentDocumentVersionId!,
            scopeSnapshot: '{}',
            scopeDigest: 'x',
            scopeSchemaVersion: '1',
            digestAlgorithmVersion: 'sha256-v1',
            ageBandSnapshot: 'UNDER_14',
            grantedByAccountId: account.id,
            grantedAt: new Date(),
          },
        });
        consentId = consent.id;
        throw new Error('STP004_TX1_CREATE');
      }),
    ).rejects.toThrow('STP004_TX1_CREATE');
    expect(await prisma.studentProfile.findUnique({ where: { id: studentId } })).toBeNull();
    expect(await prisma.guardianLink.findUnique({ where: { id: linkId } })).toBeNull();
    expect(await prisma.consentRecord.findUnique({ where: { id: consentId } })).toBeNull();

    const student = await prisma.studentProfile.create({
      data: {
        nickname: '半消费',
        avatarPresetId: 'avatar-03',
        ageBand: 'UNDER_14',
        ageConfirmationSource: 'GUARDIAN_DECLARATION',
        ageConfirmedAt: new Date(),
        ageConfirmedByAccountId: account.id,
        createdByAccountId: account.id,
      },
    });
    const link = await prisma.guardianLink.create({
      data: { accountId: account.id, studentProfileId: student.id },
    });
    const guardian = await prisma.deviceSession.create({
      data: {
        scope: 'GUARDIAN',
        accountId: account.id,
        origin: 'http://127.0.0.1:5173',
        credentialDigest: randomUUID(),
        csrfDigest: randomUUID(),
        accountAuthVersionAtIssue: 1,
        deviceInstallationDigest: randomUUID(),
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const pairing = await prisma.devicePairing.create({
      data: {
        studentProfileId: student.id,
        issuedByGuardianLinkId: link.id,
        createdByAccountId: account.id,
        createdBySessionId: guardian.id,
        codeDigest: randomUUID(),
        digestKeyVersion: 'v1',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    let sessionId = '';
    await expect(
      prisma.$transaction(async (tx) => {
        const session = await tx.deviceSession.create({
          data: {
            scope: 'STUDENT',
            studentProfileId: student.id,
            issuedByGuardianLinkId: link.id,
            issuedByAccountId: account.id,
            origin: 'http://127.0.0.1:5173',
            credentialDigest: randomUUID(),
            csrfDigest: randomUUID(),
            issuerAuthVersionAtIssue: 1,
            deviceInstallationDigest: randomUUID(),
            authenticatedAt: new Date(),
            lastSeenAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        sessionId = session.id;
        await tx.devicePairing.update({
          where: { id: pairing.id },
          data: { consumedAt: new Date(), consumedBySessionId: session.id },
        });
        throw new Error('STP004_TX1_CONSUME');
      }),
    ).rejects.toThrow('STP004_TX1_CONSUME');
    expect(await prisma.deviceSession.findUnique({ where: { id: sessionId } })).toBeNull();
    const pairingAfter = await prisma.devicePairing.findUniqueOrThrow({ where: { id: pairing.id } });
    expect(pairingAfter.consumedAt).toBeNull();
    expect(pairingAfter.consumedBySessionId).toBeNull();

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.guardianLink.update({
          where: { id: link.id },
          data: { status: 'REVOKED', revokedAt: new Date(), revocationReasonCode: 'TX1' },
        });
        await tx.devicePairing.update({
          where: { id: pairing.id },
          data: { revokedAt: new Date() },
        });
        throw new Error('STP004_TX1_REVOKE');
      }),
    ).rejects.toThrow('STP004_TX1_REVOKE');
    const linkAfter = await prisma.guardianLink.findUniqueOrThrow({ where: { id: link.id } });
    const pairingFinal = await prisma.devicePairing.findUniqueOrThrow({ where: { id: pairing.id } });
    expect(linkAfter.status).toBe('ACTIVE');
    expect(linkAfter.revokedAt).toBeNull();
    expect(pairingFinal.revokedAt).toBeNull();
  });

  it('DB step-up bound session trigger rejects a mismatched device digest', async () => {
    const account = await seedAccount();
    const identity = await prisma.authIdentity.create({
      data: {
        accountId: account.id,
        kind: 'PHONE',
        provider: 'PHONE_OTP',
        encryptedIdentifier: Buffer.from('review-step-up'),
        encryptionKeyVersion: 'v1',
        verifiedAt: new Date(),
      },
    });
    const student = await prisma.studentProfile.create({
      data: {
        nickname: '约束',
        avatarPresetId: 'avatar-03',
        ageBand: 'UNDER_14',
        ageConfirmationSource: 'GUARDIAN_DECLARATION',
        ageConfirmedAt: new Date(),
        ageConfirmedByAccountId: account.id,
        createdByAccountId: account.id,
      },
    });
    const link = await prisma.guardianLink.create({
      data: { accountId: account.id, studentProfileId: student.id },
    });
    const bound = await prisma.deviceSession.create({
      data: {
        scope: 'STUDENT',
        studentProfileId: student.id,
        issuedByGuardianLinkId: link.id,
        issuedByAccountId: account.id,
        origin: 'http://127.0.0.1:5173',
        credentialDigest: randomUUID(),
        csrfDigest: randomUUID(),
        issuerAuthVersionAtIssue: 1,
        deviceInstallationDigest: 'digest-bound',
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const lookup = await prisma.authIdentityLookup.create({
      data: {
        authIdentityId: identity.id,
        kind: 'PHONE',
        provider: 'PHONE_OTP',
        lookupKeyVersion: 'v1',
        subjectLookupDigest: `alias-${randomUUID()}`,
      },
    });
    await expect(
      prisma.authChallenge.create({
        data: {
          purpose: 'GUARDIAN_STEP_UP',
          identityKind: 'PHONE',
          provider: 'PHONE_OTP',
          accountId: account.id,
          authIdentityId: identity.id,
          boundSessionId: bound.id,
          deviceInstallationDigest: 'digest-other',
          destinationLookupDigest: lookup.subjectLookupDigest,
          destinationLookupKeyVersion: lookup.lookupKeyVersion,
          codeDigest: randomUUID(),
          codeDigestKeyVersion: 'v1',
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
    const ok = await prisma.authChallenge.create({
      data: {
        purpose: 'GUARDIAN_STEP_UP',
        identityKind: 'PHONE',
        provider: 'PHONE_OTP',
        accountId: account.id,
        authIdentityId: identity.id,
        boundSessionId: bound.id,
        deviceInstallationDigest: 'digest-bound',
        destinationLookupDigest: lookup.subjectLookupDigest,
        destinationLookupKeyVersion: lookup.lookupKeyVersion,
        codeDigest: randomUUID(),
        codeDigestKeyVersion: 'v1',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(ok.boundSessionId).toBe(bound.id);
  });

  it('DB-7 lookup alias FK, replacement 1:1, issue immutability and pg_catalog objects', async () => {
    const catalog = await admin.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
       WHERE conname IN (
         'auth_challenges_lookup_alias_fkey',
         'device_sessions_replaced_pointer_ck',
         'auth_challenges_identity_parent_ck',
         'auth_challenges_lookup_parent_ck'
       )
    `;
    expect(catalog.map((row) => row.conname).sort()).toEqual([
      'auth_challenges_identity_parent_ck',
      'auth_challenges_lookup_alias_fkey',
      'auth_challenges_lookup_parent_ck',
      'device_sessions_replaced_pointer_ck',
    ]);
    const triggers = await admin.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger
       WHERE tgname IN (
         'ss_auth_challenges_step_up_bound_trg',
         'ss_device_sessions_issue_immutable_trg',
         'ss_device_sessions_replacement_guard_trg'
       )
    `;
    expect(triggers.map((row) => row.tgname).sort()).toEqual([
      'ss_auth_challenges_step_up_bound_trg',
      'ss_device_sessions_issue_immutable_trg',
      'ss_device_sessions_replacement_guard_trg',
    ]);
    const match = await admin.$queryRaw<Array<{ confmatchtype: string }>>`
      SELECT c.confmatchtype::text AS confmatchtype
        FROM pg_constraint c
       WHERE c.conname = 'auth_challenges_lookup_alias_fkey'
    `;
    expect(match[0]?.confmatchtype).toBe('s');

    const account = await seedAccount();
    const firstLogin = await prisma.authChallenge.create({
      data: {
        purpose: 'SIGN_IN',
        identityKind: 'PHONE',
        provider: 'PHONE_OTP',
        deviceInstallationDigest: randomUUID(),
        destinationLookupDigest: `first-${randomUUID()}`,
        destinationLookupKeyVersion: 'v1',
        codeDigest: randomUUID(),
        codeDigestKeyVersion: 'v1',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(firstLogin.authIdentityId).toBeNull();
    expect(firstLogin.accountId).toBeNull();

    const identity = await prisma.authIdentity.create({
      data: {
        accountId: account.id,
        kind: 'PHONE',
        provider: 'PHONE_OTP',
        encryptedIdentifier: Buffer.from('db7'),
        encryptionKeyVersion: 'v1',
        verifiedAt: new Date(),
      },
    });
    await prisma.authIdentityLookup.create({
      data: {
        authIdentityId: identity.id,
        kind: 'PHONE',
        provider: 'PHONE_OTP',
        lookupKeyVersion: firstLogin.destinationLookupKeyVersion,
        subjectLookupDigest: firstLogin.destinationLookupDigest,
      },
    });
    const backfilled = await prisma.authChallenge.update({
      where: { id: firstLogin.id },
      data: { accountId: account.id, authIdentityId: identity.id, consumedAt: new Date() },
    });
    expect(backfilled.authIdentityId).toBe(identity.id);

    await expect(
      prisma.authChallenge.create({
        data: {
          purpose: 'SIGN_IN',
          identityKind: 'PHONE',
          provider: 'PHONE_OTP',
          authIdentityId: identity.id,
          accountId: account.id,
          deviceInstallationDigest: randomUUID(),
          destinationLookupDigest: 'missing-alias',
          destinationLookupKeyVersion: 'v1',
          codeDigest: randomUUID(),
          codeDigestKeyVersion: 'v1',
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();

    const guardian = await prisma.deviceSession.create({
      data: {
        scope: 'GUARDIAN',
        accountId: account.id,
        origin: 'http://127.0.0.1:5173',
        credentialDigest: randomUUID(),
        csrfDigest: randomUUID(),
        accountAuthVersionAtIssue: 1,
        deviceInstallationDigest: 'dev-a',
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      prisma.deviceSession.update({
        where: { id: guardian.id },
        data: { origin: 'http://evil.example' },
      }),
    ).rejects.toThrow(/issue facts are immutable/i);

    const student = await prisma.studentProfile.create({
      data: {
        nickname: '替换链',
        avatarPresetId: 'avatar-03',
        ageBand: 'UNDER_14',
        ageConfirmationSource: 'GUARDIAN_DECLARATION',
        ageConfirmedAt: new Date(),
        ageConfirmedByAccountId: account.id,
        createdByAccountId: account.id,
      },
    });
    const link = await prisma.guardianLink.create({
      data: { accountId: account.id, studentProfileId: student.id },
    });
    const successor = await prisma.deviceSession.create({
      data: {
        scope: 'STUDENT',
        studentProfileId: student.id,
        issuedByGuardianLinkId: link.id,
        issuedByAccountId: account.id,
        origin: 'http://127.0.0.1:5173',
        credentialDigest: randomUUID(),
        csrfDigest: randomUUID(),
        issuerAuthVersionAtIssue: 1,
        deviceInstallationDigest: 'dev-a',
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const replaced = await prisma.deviceSession.update({
      where: { id: guardian.id },
      data: {
        revokedAt: new Date(),
        revocationReasonCode: 'REPLACED_BY_STUDENT_MODE',
        replacedBySessionId: successor.id,
      },
    });
    expect(replaced.replacedBySessionId).toBe(successor.id);

    const otherGuardian = await prisma.deviceSession.create({
      data: {
        scope: 'GUARDIAN',
        accountId: account.id,
        origin: 'http://127.0.0.1:5173',
        credentialDigest: randomUUID(),
        csrfDigest: randomUUID(),
        accountAuthVersionAtIssue: 1,
        deviceInstallationDigest: 'dev-a',
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      prisma.deviceSession.update({
        where: { id: otherGuardian.id },
        data: {
          revokedAt: new Date(),
          revocationReasonCode: 'REPLACED_BY_STUDENT_MODE',
          replacedBySessionId: successor.id,
        },
      }),
    ).rejects.toThrow();

    const sameScope = await prisma.deviceSession.create({
      data: {
        scope: 'GUARDIAN',
        accountId: account.id,
        origin: 'http://127.0.0.1:5173',
        credentialDigest: randomUUID(),
        csrfDigest: randomUUID(),
        accountAuthVersionAtIssue: 1,
        deviceInstallationDigest: 'dev-a',
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      prisma.deviceSession.update({
        where: { id: otherGuardian.id },
        data: {
          revokedAt: new Date(),
          revocationReasonCode: 'TEST',
          replacedBySessionId: sameScope.id,
        },
      }),
    ).rejects.toThrow(/scope direction invalid/i);
  });

  async function seedOppositePair() {
    const account = await seedAccount();
    const student = await prisma.studentProfile.create({
      data: {
        nickname: '反环',
        avatarPresetId: 'avatar-03',
        ageBand: 'UNDER_14',
        ageConfirmationSource: 'GUARDIAN_DECLARATION',
        ageConfirmedAt: new Date(),
        ageConfirmedByAccountId: account.id,
        createdByAccountId: account.id,
      },
    });
    const link = await prisma.guardianLink.create({
      data: { accountId: account.id, studentProfileId: student.id },
    });
    const digest = `cycle-${randomUUID()}`;
    const guardian = await prisma.deviceSession.create({
      data: {
        scope: 'GUARDIAN',
        accountId: account.id,
        origin: 'http://127.0.0.1:5173',
        credentialDigest: randomUUID(),
        csrfDigest: randomUUID(),
        accountAuthVersionAtIssue: 1,
        deviceInstallationDigest: digest,
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const studentSess = await prisma.deviceSession.create({
      data: {
        scope: 'STUDENT',
        studentProfileId: student.id,
        issuedByGuardianLinkId: link.id,
        issuedByAccountId: account.id,
        origin: 'http://127.0.0.1:5173',
        credentialDigest: randomUUID(),
        csrfDigest: randomUUID(),
        issuerAuthVersionAtIssue: 1,
        deviceInstallationDigest: digest,
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return { account, student, link, guardian, studentSess, digest };
  }

  it('rejects partial identity/account parent keys on AuthChallenge', async () => {
    const account = await seedAccount();
    await expect(
      prisma.authChallenge.create({
        data: {
          purpose: 'SIGN_IN',
          identityKind: 'PHONE',
          provider: 'PHONE_OTP',
          accountId: account.id,
          deviceInstallationDigest: randomUUID(),
          destinationLookupDigest: `partial-${randomUUID()}`,
          destinationLookupKeyVersion: 'v1',
          codeDigest: randomUUID(),
          codeDigestKeyVersion: 'v1',
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
  });

  it('DB concurrent replacement cycle is rejected after locking both rows and seeing the committed pointer', async () => {
    const { guardian, studentSess } = await seedOppositePair();
    const clientA = new pg.Client({ connectionString });
    const clientB = new pg.Client({ connectionString });
    const observer = new pg.Client({ connectionString: process.env.STP004_ADMIN_DATABASE_URL ?? connectionString });
    await clientA.connect();
    await clientB.connect();
    await observer.connect();
    await clientA.query('BEGIN');
    await clientA.query('SELECT id FROM device_sessions WHERE id IN ($1, $2) ORDER BY id FOR UPDATE', [
      guardian.id,
      studentSess.id,
    ]);
    const holderPid = await backendPid(clientA);
    let visible: string | null = null;
    const waiter = (async () => {
      await clientB.query('BEGIN');
      await clientB.query('SELECT id FROM device_sessions WHERE id IN ($1, $2) ORDER BY id FOR UPDATE', [
        guardian.id,
        studentSess.id,
      ]);
      const seen = await clientB.query<{ replaced_by_session_id: string | null }>(
        'SELECT replaced_by_session_id FROM device_sessions WHERE id = $1',
        [guardian.id],
      );
      visible = seen.rows[0]?.replaced_by_session_id ?? null;
      await clientB.query(
        `UPDATE device_sessions
            SET revoked_at = clock_timestamp(),
                revocation_reason_code = 'TEST_CYCLE',
                replaced_by_session_id = $2
          WHERE id = $1`,
        [studentSess.id, guardian.id],
      );
    })();
    await waitForWaiterOnHolder(observer, holderPid, 'anti-cycle B waits on both-row lock');
    await clientA.query(
      `UPDATE device_sessions
          SET revoked_at = clock_timestamp(),
              revocation_reason_code = 'TEST_CYCLE',
              replaced_by_session_id = $2
        WHERE id = $1`,
      [guardian.id, studentSess.id],
    );
    await clientA.query('COMMIT');
    await expect(waiter).rejects.toThrow(/cycle/i);
    expect(visible).toBe(studentSess.id);
    await clientB.query('ROLLBACK').catch(() => undefined);
    await clientA.end();
    await clientB.end();
    await observer.end();
  });

  it('DB multi-hop replacement chain rejects a cycle back to the root', async () => {
    const first = await seedOppositePair();
    const g1 = await prisma.deviceSession.create({
      data: {
        scope: 'GUARDIAN',
        accountId: first.account.id,
        origin: 'http://127.0.0.1:5173',
        credentialDigest: randomUUID(),
        csrfDigest: randomUUID(),
        accountAuthVersionAtIssue: 1,
        deviceInstallationDigest: first.digest,
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const s1 = await prisma.deviceSession.create({
      data: {
        scope: 'STUDENT',
        studentProfileId: first.student.id,
        issuedByGuardianLinkId: first.link.id,
        issuedByAccountId: first.account.id,
        origin: 'http://127.0.0.1:5173',
        credentialDigest: randomUUID(),
        csrfDigest: randomUUID(),
        issuerAuthVersionAtIssue: 1,
        deviceInstallationDigest: first.digest,
        authenticatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.deviceSession.update({
      where: { id: first.guardian.id },
      data: {
        revokedAt: new Date(),
        revocationReasonCode: 'REPLACED',
        replacedBySessionId: first.studentSess.id,
      },
    });
    await prisma.deviceSession.update({
      where: { id: first.studentSess.id },
      data: {
        revokedAt: new Date(),
        revocationReasonCode: 'REPLACED',
        replacedBySessionId: g1.id,
      },
    });
    await prisma.deviceSession.update({
      where: { id: g1.id },
      data: {
        revokedAt: new Date(),
        revocationReasonCode: 'REPLACED',
        replacedBySessionId: s1.id,
      },
    });
    await expect(
      prisma.deviceSession.update({
        where: { id: s1.id },
        data: {
          revokedAt: new Date(),
          revocationReasonCode: 'REPLACED',
          replacedBySessionId: first.guardian.id,
        },
      }),
    ).rejects.toThrow(/cycle/i);
  });
});
