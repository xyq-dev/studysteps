import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  asProfileStatus,
  decideAgeBand,
  isExpired,
  nextAttemptState,
  normalizeMainlandMobile,
  sessionInvalidReason,
  stepUpValid,
  studentMayReadSelf,
} from '@studysteps/domain';
import type { CreateSessionInput, RequestAuthCodeInput, SessionGranted } from '@studysteps/contracts';
import { Prisma, type DeviceSession } from '@prisma/client';
import { AppError } from '../common/app-error';
import { RuntimeConfig } from '../common/runtime-config';
import { decryptUtf8, encryptUtf8, hmacHex, randomDigits, randomToken, sha256Hex, safeEqual } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimitService } from './rate-limit.service';
import { TestAuthDelivery } from './test-delivery.adapter';
import {
  acquireLocks,
  assertLockSetComplete,
  mergeLockIds,
  readLockedNow,
  runWriteTx,
  type LockIds,
} from '../common/lock-order';
import {
  collectStudentAuthorizationGraph,
  discoverStudentAuthorizationGraph,
} from '../students/student-authorization';
import { issueReplacementSession } from './session-lineage';

const SIGN_IN_LOOKUP_KEY_VERSION = 'v1';

@Injectable()
export class IdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: RuntimeConfig,
    private readonly rateLimit: RateLimitService,
    private readonly delivery: TestAuthDelivery,
  ) {}

  private get config() {
    return this.runtime.value;
  }

  async requestCode(
    input: RequestAuthCodeInput,
    origin: string,
    ip: string,
    session?: { id: string; accountId: string | null; deviceDigest: string; scope: string },
  ) {
    const rateNow = new Date();
    const deviceDigest = sha256Hex(input.device.installationId);
    let destination: string;
    let accountId: string | null = null;
    let authIdentityId: string | null = null;
    let lookupKeyVersion = SIGN_IN_LOOKUP_KEY_VERSION;
    let destinationLookupDigest: string;
    let boundSession: DeviceSession | null = null;
    let aliasLookupId: string | null = null;
    let identityId: string | null = null;

    if (input.purpose === 'SIGN_IN') {
      const normalized = normalizeMainlandMobile(input.identity.value);
      if (!normalized) {
        throw new AppError('VALIDATION_ERROR', '手机号格式无效', 400, { identity: 'invalid' });
      }
      destination = normalized;
      destinationLookupDigest = hmacHex(this.config.keys.lookup, `PHONE_OTP:PHONE:${destination}`);
    } else {
      if (!session || session.scope !== 'STUDENT' || !session.accountId) {
        throw new AppError('SESSION_SCOPE_FORBIDDEN', '需要学生会话才能恢复家长验证', 403);
      }
      boundSession = await this.prisma.deviceSession.findUnique({ where: { id: session.id } });
      if (!boundSession) {
        throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
      }
      const identity = await this.prisma.authIdentity.findFirst({
        where: { accountId: session.accountId, kind: 'PHONE', provider: 'PHONE_OTP' },
      });
      if (!identity) {
        throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
      }
      destination = decryptUtf8(this.config.keys.identifier, Buffer.from(identity.encryptedIdentifier));
      accountId = identity.accountId;
      authIdentityId = identity.id;
      identityId = identity.id;
      const alias = await this.prisma.authIdentityLookup.findFirst({
        where: { authIdentityId: identity.id },
        orderBy: [{ createdAt: 'desc' }, { lookupKeyVersion: 'desc' }],
      });
      if (!alias) {
        throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
      }
      lookupKeyVersion = alias.lookupKeyVersion;
      destinationLookupDigest = alias.subjectLookupDigest;
      aliasLookupId = alias.id;
      if (session.deviceDigest !== deviceDigest) {
        throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
      }
    }

    await this.rateLimit.consume(`otp:id:${destination}`, 60 * 60 * 1000, this.config.timing.otpIdPerHour, rateNow);
    await this.rateLimit.consume(`otp:id-day:${destination}`, 24 * 60 * 60 * 1000, this.config.timing.otpIdPerHour * 2, rateNow);
    await this.rateLimit.consume(`otp:device:${deviceDigest}`, 60 * 60 * 1000, this.config.timing.otpDevicePerHour, rateNow);
    await this.rateLimit.consume(`otp:ip:${ip}`, 60 * 60 * 1000, this.config.timing.otpIpPerHour, rateNow);

    const last = await this.prisma.authChallenge.findFirst({
      where: {
        destinationLookupDigest,
        purpose: input.purpose,
        deviceInstallationDigest: deviceDigest,
        consumedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    const existingLookup = await this.prisma.authIdentityLookup.findUnique({
      where: {
        provider_kind_lookupKeyVersion_subjectLookupDigest: {
          provider: 'PHONE_OTP',
          kind: 'PHONE',
          lookupKeyVersion,
          subjectLookupDigest: destinationLookupDigest,
        },
      },
    });
    const existingIdentity = existingLookup
      ? await this.prisma.authIdentity.findUnique({ where: { id: existingLookup.authIdentityId } })
      : identityId
        ? await this.prisma.authIdentity.findUnique({ where: { id: identityId } })
        : null;
    const advisory = hmacHex(this.config.keys.advisory, `PHONE_OTP:PHONE:${destination}`);
    let planned: LockIds = {
      identityAdvisoryKeys: [advisory],
      identityIds: existingIdentity ? [existingIdentity.id] : [],
      lookupIds: existingLookup ? [existingLookup.id] : aliasLookupId ? [aliasLookupId] : [],
      accountIds: existingIdentity ? [existingIdentity.accountId] : accountId ? [accountId] : [],
      challengeIds: last ? [last.id] : [],
      sessionIds: boundSession ? [boundSession.id] : [],
    };
    if (input.purpose === 'GUARDIAN_STEP_UP' && boundSession?.studentProfileId) {
      planned = await collectStudentAuthorizationGraph(
        this.prisma,
        boundSession.studentProfileId,
        planned,
        { includePairings: false, session: boundSession },
      );
    }

    const code = randomDigits(6);
    const challenge = await runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(planned, extra);
      await acquireLocks(tx, locked);
      const latest = await tx.authChallenge.findFirst({
        where: {
          destinationLookupDigest,
          purpose: input.purpose,
          deviceInstallationDigest: deviceDigest,
          consumedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      });
      let discovered: LockIds = {
        identityAdvisoryKeys: [advisory],
        identityIds: existingIdentity ? [existingIdentity.id] : [],
        lookupIds: existingLookup ? [existingLookup.id] : aliasLookupId ? [aliasLookupId] : [],
        accountIds: existingIdentity ? [existingIdentity.accountId] : accountId ? [accountId] : [],
        challengeIds: latest ? [latest.id] : [],
        sessionIds: boundSession ? [boundSession.id] : [],
      };
      if (input.purpose === 'GUARDIAN_STEP_UP' && boundSession?.studentProfileId) {
        discovered = mergeLockIds(
          discovered,
          await discoverStudentAuthorizationGraph(tx, boundSession.studentProfileId, {
            includePairings: false,
            session: boundSession,
          }),
        );
      }
      assertLockSetComplete(locked, discovered);
      const now = await readLockedNow(tx);
      if (boundSession) {
        boundSession = await this.assertSessionCurrent(tx, boundSession, { now });
      }
      if (latest && now.getTime() - latest.createdAt.getTime() < 60_000) {
        throw new AppError('RATE_LIMITED', '请稍后再试', 429);
      }
      if (boundSession) {
        await this.touchLastSeenLocked(tx, boundSession, now);
      }
      if (latest) {
        await tx.authChallenge.update({
          where: { id: latest.id },
          data: { lockedAt: now },
        });
      }
      return tx.authChallenge.create({
        data: {
          purpose: input.purpose,
          identityKind: 'PHONE',
          provider: 'PHONE_OTP',
          accountId,
          authIdentityId,
          boundSessionId: input.purpose === 'GUARDIAN_STEP_UP' ? session?.id : null,
          deviceInstallationDigest: deviceDigest,
          destinationLookupDigest,
          destinationLookupKeyVersion: lookupKeyVersion,
          encryptedDestination: Uint8Array.from(encryptUtf8(this.config.keys.identifier, destination)),
          codeDigest: hmacHex(this.config.keys.otp, code),
          codeDigestKeyVersion: 'v1',
          maxAttempts: this.config.timing.otpMaxAttempts,
          expiresAt: new Date(now.getTime() + this.config.timing.otpTtlMs),
        },
      });
    }, planned);

    this.delivery.deliver(destination, code);
    void origin;
    return {
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt.toISOString(),
      retryAfterSeconds: 60,
    };
  }

  async grantSession(
    input: CreateSessionInput,
    origin: string,
    ip: string,
    currentSession?: DeviceSession | null,
  ): Promise<{
    body: SessionGranted;
    sessionToken: string;
    csrfToken: string;
  }> {
    if (input.grantType === 'VERIFICATION_CODE' || input.grantType === 'GUARDIAN_STEP_UP') {
      return this.consumeCode(input, origin, ip, currentSession);
    }
    throw new AppError('VALIDATION_ERROR', '请使用对应服务完成该授权', 400);
  }

  private async consumeCode(
    input: Extract<CreateSessionInput, { grantType: 'VERIFICATION_CODE' | 'GUARDIAN_STEP_UP' }>,
    origin: string,
    ip: string,
    currentSession?: DeviceSession | null,
  ) {
    const rateNow = new Date();
    const deviceDigest = sha256Hex(input.device.installationId);
    const preview = await this.prisma.authChallenge.findUnique({ where: { id: input.challengeId } });
    if (!preview) {
      throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
    }

    await this.rateLimit.consume(
      `auth-fail:ip:${ip}`,
      60 * 1000,
      this.config.timing.authFailIpPerMinute,
      rateNow,
    );
    await this.rateLimit.consume(
      `auth-fail:device:${deviceDigest}`,
      60 * 1000,
      this.config.timing.authFailDevicePerMinute,
      rateNow,
    );

    if (input.grantType === 'GUARDIAN_STEP_UP') {
      const boundAccount = currentSession?.accountId ?? currentSession?.issuedByAccountId ?? null;
      const sessionMatches =
        currentSession &&
        currentSession.scope === 'STUDENT' &&
        preview.boundSessionId === currentSession.id &&
        preview.accountId !== null &&
        boundAccount === preview.accountId;
      if (!sessionMatches) {
        throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
      }
    }

    const purposeOk =
      (input.grantType === 'VERIFICATION_CODE' && preview.purpose === 'SIGN_IN') ||
      (input.grantType === 'GUARDIAN_STEP_UP' && preview.purpose === 'GUARDIAN_STEP_UP');
    if (
      preview.consumedAt ||
      preview.lockedAt ||
      isExpired(rateNow, preview.expiresAt) ||
      preview.deviceInstallationDigest !== deviceDigest ||
      !purposeOk
    ) {
      await this.recordFailedAttempt(preview.id);
      throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
    }

    if (!safeEqual(preview.codeDigest, hmacHex(this.config.keys.otp, input.code))) {
      await this.recordFailedAttempt(preview.id);
      throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
    }

    if (!preview.encryptedDestination) {
      await this.recordFailedAttempt(preview.id);
      throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
    }

    const destination = decryptUtf8(this.config.keys.identifier, preview.encryptedDestination);
    const advisory = hmacHex(this.config.keys.advisory, `PHONE_OTP:PHONE:${destination}`);
    const existingLookup = await this.prisma.authIdentityLookup.findUnique({
      where: {
        provider_kind_lookupKeyVersion_subjectLookupDigest: {
          provider: preview.provider,
          kind: preview.identityKind,
          lookupKeyVersion: preview.destinationLookupKeyVersion,
          subjectLookupDigest: preview.destinationLookupDigest,
        },
      },
    });
    const existingIdentity = existingLookup
      ? await this.prisma.authIdentity.findUnique({ where: { id: existingLookup.authIdentityId } })
      : null;

    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const successorId = randomUUID();
    let planned: LockIds = {
      identityAdvisoryKeys: [advisory],
      identityIds: existingIdentity ? [existingIdentity.id] : preview.authIdentityId ? [preview.authIdentityId] : [],
      lookupIds: existingLookup ? [existingLookup.id] : [],
      accountIds: existingIdentity ? [existingIdentity.accountId] : preview.accountId ? [preview.accountId] : [],
      challengeIds: [preview.id],
      sessionIds: preview.boundSessionId ? [preview.boundSessionId] : [],
    };
    if (input.grantType === 'GUARDIAN_STEP_UP' && currentSession?.studentProfileId) {
      planned = await collectStudentAuthorizationGraph(
        this.prisma,
        currentSession.studentProfileId,
        planned,
        { includePairings: false, session: currentSession },
      );
    }

    const granted = await runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(planned, extra);
      await acquireLocks(tx, locked);
      const challenge = await tx.authChallenge.findUnique({ where: { id: preview.id } });
      if (!challenge) {
        throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
      }
      const lookup = await tx.authIdentityLookup.findUnique({
        where: {
          provider_kind_lookupKeyVersion_subjectLookupDigest: {
            provider: challenge.provider,
            kind: challenge.identityKind,
            lookupKeyVersion: challenge.destinationLookupKeyVersion,
            subjectLookupDigest: challenge.destinationLookupDigest,
          },
        },
      });
      const identity = lookup
        ? await tx.authIdentity.findUniqueOrThrow({ where: { id: lookup.authIdentityId } })
        : null;
      let discovered: LockIds = {
        identityAdvisoryKeys: [advisory],
        identityIds: identity ? [identity.id] : [],
        lookupIds: lookup ? [lookup.id] : [],
        accountIds: identity ? [identity.accountId] : [],
        challengeIds: [challenge.id],
        sessionIds: challenge.boundSessionId ? [challenge.boundSessionId] : [],
      };
      if (input.grantType === 'GUARDIAN_STEP_UP' && currentSession?.studentProfileId) {
        discovered = mergeLockIds(
          discovered,
          await discoverStudentAuthorizationGraph(tx, currentSession.studentProfileId, {
            includePairings: false,
            session: currentSession,
          }),
        );
      }
      assertLockSetComplete(locked, discovered);
      const now = await readLockedNow(tx);
      if (
        challenge.consumedAt ||
        challenge.lockedAt ||
        isExpired(now, challenge.expiresAt) ||
        challenge.attemptCount >= challenge.maxAttempts
      ) {
        throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
      }

      let accountId = identity?.accountId ?? challenge.accountId;
      let identityId = identity?.id ?? null;
      if (!identity) {
        const createdAccount = await tx.account.create({ data: { status: 'ACTIVE' } });
        const created = await tx.authIdentity.create({
          data: {
            accountId: createdAccount.id,
            kind: 'PHONE',
            provider: 'PHONE_OTP',
            encryptedIdentifier: Uint8Array.from(encryptUtf8(this.config.keys.identifier, destination)),
            encryptionKeyVersion: 'v1',
            verifiedAt: now,
          },
        });
        await tx.authIdentityLookup.create({
          data: {
            authIdentityId: created.id,
            kind: 'PHONE',
            provider: 'PHONE_OTP',
            lookupKeyVersion: challenge.destinationLookupKeyVersion,
            subjectLookupDigest: challenge.destinationLookupDigest,
          },
        });
        accountId = createdAccount.id;
        identityId = created.id;
      } else if (
        input.grantType === 'GUARDIAN_STEP_UP' &&
        (challenge.accountId !== identity.accountId || challenge.authIdentityId !== identity.id)
      ) {
        throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
      }

      if (!accountId || !identityId) {
        throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
      }

      const account = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
      if (account.status !== 'ACTIVE') {
        throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
      }

      if (input.grantType === 'GUARDIAN_STEP_UP') {
        if (!challenge.boundSessionId) {
          throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
        }
        const bound = await tx.deviceSession.findUnique({ where: { id: challenge.boundSessionId } });
        const boundAccount = bound?.accountId ?? bound?.issuedByAccountId ?? null;
        if (
          !bound ||
          bound.scope !== 'STUDENT' ||
          bound.deviceInstallationDigest !== challenge.deviceInstallationDigest ||
          boundAccount !== challenge.accountId ||
          boundAccount !== account.id
        ) {
          throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
        }
        try {
          await this.assertSessionCurrent(tx, bound, { now, requireStepUp: false });
        } catch (error) {
          if (error instanceof AppError && error.status === 401) {
            throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
          }
          throw error;
        }
        const expiresAt = new Date(now.getTime() + this.config.timing.guardianAbsoluteMs);
        const created = await issueReplacementSession(tx, {
          predecessorId: bound.id,
          reason: 'REPLACED_BY_GUARDIAN_STEP_UP',
          lockedNow: now,
          failureCode: 'AUTH_GRANT_INVALID',
          successor: {
            id: successorId,
            scope: 'GUARDIAN',
            accountId,
            origin,
            credentialDigest: sha256Hex(sessionToken),
            csrfDigest: sha256Hex(csrfToken),
            accountAuthVersionAtIssue: account.authVersion,
            deviceInstallationDigest: deviceDigest,
            deviceLabel: input.device.label,
            authenticatedAt: now,
            stepUpVerifiedAt: now,
            lastSeenAt: now,
            expiresAt,
          },
        });
        const consumed = await tx.authChallenge.updateMany({
          where: { id: challenge.id, consumedAt: null, lockedAt: null },
          data: { consumedAt: now, accountId, authIdentityId: identityId },
        });
        if (consumed.count !== 1) {
          throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
        }
        return { session: created, now };
      }

      const consumed = await tx.authChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null, lockedAt: null },
        data: { consumedAt: now, accountId, authIdentityId: identityId },
      });
      if (consumed.count !== 1) {
        throw new AppError('AUTH_GRANT_INVALID', '验证失败', 401);
      }
      const expiresAt = new Date(now.getTime() + this.config.timing.guardianAbsoluteMs);
      const created = await tx.deviceSession.create({
        data: {
          scope: 'GUARDIAN',
          accountId,
          origin,
          credentialDigest: sha256Hex(sessionToken),
          csrfDigest: sha256Hex(csrfToken),
          accountAuthVersionAtIssue: account.authVersion,
          deviceInstallationDigest: deviceDigest,
          deviceLabel: input.device.label,
          authenticatedAt: now,
          stepUpVerifiedAt: now,
          lastSeenAt: now,
          expiresAt,
        },
      });
      return { session: created, now };
    }, planned);

    return {
      body: {
        session: {
          scope: 'GUARDIAN' as const,
          studentId: null,
          expiresAt: granted.session.expiresAt.toISOString(),
          stepUpValidUntil: new Date(granted.now.getTime() + this.config.timing.stepUpMs).toISOString(),
        },
        serverTime: granted.now.toISOString(),
      },
      sessionToken,
      csrfToken,
    };
  }

  async peekSession(token: string | undefined): Promise<DeviceSession> {
    if (!token) {
      throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
    }
    const session = await this.prisma.deviceSession.findUnique({
      where: { credentialDigest: sha256Hex(token) },
    });
    if (!session) {
      throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
    }
    return session;
  }

  async loadSession(token: string | undefined, options: { touch?: boolean; verifyLive?: boolean } = {}) {
    const session = await this.peekSession(token);
    if (options.verifyLive === false) {
      return session;
    }
    void options.touch;
    return this.assertSessionCurrent(this.prisma, session, { now: new Date() });
  }

  async currentSession(session: DeviceSession) {
    let planned: LockIds = {
      sessionIds: [session.id],
      accountIds: [
        ...(session.accountId ? [session.accountId] : []),
        ...(session.issuedByAccountId ? [session.issuedByAccountId] : []),
      ],
    };
    if (session.scope === 'STUDENT' && session.studentProfileId) {
      planned = await collectStudentAuthorizationGraph(this.prisma, session.studentProfileId, planned, {
        includePairings: false,
        session,
      });
    }
    return runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(planned, extra);
      await acquireLocks(tx, locked);
      let discovered: LockIds = {
        sessionIds: [session.id],
        accountIds: [
          ...(session.accountId ? [session.accountId] : []),
          ...(session.issuedByAccountId ? [session.issuedByAccountId] : []),
        ],
      };
      if (session.scope === 'STUDENT' && session.studentProfileId) {
        discovered = mergeLockIds(
          discovered,
          await discoverStudentAuthorizationGraph(tx, session.studentProfileId, {
            includePairings: false,
            session,
          }),
        );
      }
      assertLockSetComplete(locked, discovered);
      const now = await readLockedNow(tx);
      const current = await this.assertSessionCurrent(tx, session, { now });
      await this.touchLastSeenLocked(tx, current, now);
      const latest = await tx.deviceSession.findUniqueOrThrow({ where: { id: current.id } });
      return {
        session: this.sessionView(latest),
        serverTime: now.toISOString(),
      };
    }, planned);
  }

  async touchLastSeenLocked(
    tx: Prisma.TransactionClient,
    session: DeviceSession,
    lockedNow: Date,
  ): Promise<DeviceSession> {
    await tx.$executeRaw(
      Prisma.sql`
        UPDATE device_sessions
           SET last_seen_at = ${lockedNow}::timestamptz,
               updated_at = ${lockedNow}::timestamptz,
               version = version + 1
         WHERE id = ${session.id}::uuid
           AND revoked_at IS NULL
           AND (
             last_seen_at IS NULL
             OR last_seen_at <= ${lockedNow}::timestamptz - (${this.config.timing.lastSeenThrottleMs} * INTERVAL '1 millisecond')
           )
      `,
    );
    const latest = await tx.deviceSession.findUnique({ where: { id: session.id } });
    if (!latest) {
      throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
    }
    return this.assertSessionCurrent(tx, latest, { now: lockedNow });
  }

  async assertSessionCurrent(
    db: Prisma.TransactionClient | PrismaService,
    session: DeviceSession,
    options: { now?: Date; requireStepUp?: boolean } = {},
  ): Promise<DeviceSession> {
    const now = options.now ?? new Date();
    const current = await db.deviceSession.findUnique({ where: { id: session.id } });
    if (!current) {
      throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
    }
    const reason = sessionInvalidReason(
      {
        createdAt: current.createdAt,
        lastSeenAt: current.lastSeenAt,
        expiresAt: current.expiresAt,
        revokedAt: current.revokedAt,
        absoluteMs:
          current.scope === 'GUARDIAN'
            ? this.config.timing.guardianAbsoluteMs
            : this.config.timing.studentAbsoluteMs,
        idleMs:
          current.scope === 'GUARDIAN'
            ? this.config.timing.guardianIdleMs
            : this.config.timing.studentIdleMs,
      },
      { now: () => now },
    );
    if (reason) {
      throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
    }
    if (current.scope === 'GUARDIAN') {
      if (!current.accountId) {
        throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
      }
      const account = await db.account.findUnique({ where: { id: current.accountId } });
      if (!account || account.status !== 'ACTIVE' || account.authVersion !== current.accountAuthVersionAtIssue) {
        throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
      }
      if (options.requireStepUp && !stepUpValid(current.stepUpVerifiedAt, now, this.config.timing.stepUpMs)) {
        throw new AppError('STEP_UP_REQUIRED', '请先完成近期验证', 403);
      }
      return current;
    }
    await this.assertStudentSessionLive(db, current);
    return current;
  }

  async assertStudentSessionLive(
    db: Prisma.TransactionClient | PrismaService,
    session: DeviceSession,
  ): Promise<void> {
    if (
      session.scope !== 'STUDENT' ||
      !session.studentProfileId ||
      !session.issuedByAccountId ||
      !session.issuedByGuardianLinkId
    ) {
      throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
    }
    const issuer = await db.account.findUnique({ where: { id: session.issuedByAccountId } });
    if (!issuer || issuer.status !== 'ACTIVE' || issuer.authVersion !== session.issuerAuthVersionAtIssue) {
      throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
    }
    const student = await db.studentProfile.findUnique({ where: { id: session.studentProfileId } });
    if (!student || !studentMayReadSelf(asProfileStatus(student.status))) {
      throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
    }
    const link = await db.guardianLink.findFirst({
      where: {
        id: session.issuedByGuardianLinkId,
        studentProfileId: student.id,
        accountId: session.issuedByAccountId,
        status: 'ACTIVE',
      },
    });
    if (!link) {
      throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
    }
    const age = decideAgeBand(student.ageBand);
    if (!age.ok) {
      throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
    }
    const policy = await db.consentPolicy.findUnique({
      where: { policyKey_locale: { policyKey: age.policyKey, locale: 'zh-CN' } },
    });
    const consent = await db.consentRecord.findFirst({
      where: {
        studentProfileId: student.id,
        consentPolicyId: policy?.id,
        withdrawnAt: null,
        supersededAt: null,
      },
    });
    if (!policy?.currentDocumentVersionId || !consent || consent.documentVersionId !== policy.currentDocumentVersionId) {
      throw new AppError('AUTH_SESSION_INVALID', '未登录', 401);
    }
  }

  async findSessionByToken(token: string | undefined): Promise<DeviceSession | null> {
    if (!token) {
      return null;
    }
    return this.prisma.deviceSession.findUnique({
      where: { credentialDigest: sha256Hex(token) },
    });
  }

  async logout(token: string | undefined): Promise<void> {
    const session = await this.findSessionByToken(token);
    if (!session || session.revokedAt) {
      return;
    }
    const planned: LockIds = { sessionIds: [session.id] };
    await runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(planned, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, { sessionIds: [session.id] });
      const now = await readLockedNow(tx);
      const current = await tx.deviceSession.findUnique({ where: { id: session.id } });
      if (current && !current.revokedAt) {
        await tx.deviceSession.update({
          where: { id: current.id },
          data: { revokedAt: now, revocationReasonCode: 'LOGOUT' },
        });
      }
    }, planned);
  }

  requireStepUp(session: { stepUpVerifiedAt: Date | null }): void {
    if (!stepUpValid(session.stepUpVerifiedAt, new Date(), this.config.timing.stepUpMs)) {
      throw new AppError('STEP_UP_REQUIRED', '请先完成近期验证', 403);
    }
  }

  async recordFailedAttempt(id: string): Promise<void> {
    const planned: LockIds = { challengeIds: [id] };
    await runWriteTx(this.prisma, async (tx, extra) => {
      const locked = mergeLockIds(planned, extra);
      await acquireLocks(tx, locked);
      assertLockSetComplete(locked, { challengeIds: [id] });
      const now = await readLockedNow(tx);
      const row = await tx.authChallenge.findUnique({ where: { id } });
      if (!row || row.consumedAt) {
        return;
      }
      const next = nextAttemptState(row.attemptCount, row.maxAttempts, false);
      await tx.authChallenge.update({
        where: { id },
        data: { attemptCount: next.attemptCount, lockedAt: next.locked ? now : row.lockedAt },
      });
    }, planned);
  }

  sessionView(session: DeviceSession) {
    return {
      scope: session.scope,
      studentId: session.studentProfileId,
      expiresAt: session.expiresAt.toISOString(),
      stepUpValidUntil: session.stepUpVerifiedAt
        ? new Date(session.stepUpVerifiedAt.getTime() + this.config.timing.stepUpMs).toISOString()
        : null,
    };
  }
}
