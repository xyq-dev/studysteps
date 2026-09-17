import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

export type PolicyLock = {
  id: string;
  policyKey: string;
  locale: string;
};

export type LockIds = {
  idempotencyIds?: string[];
  identityAdvisoryKeys?: string[];
  identityIds?: string[];
  lookupIds?: string[];
  accountIds?: string[];
  studentIds?: string[];
  gradeConfigIds?: string[];
  templateVersionIds?: string[];
  policies?: PolicyLock[];
  linkIds?: string[];
  consentIds?: string[];
  pairingIds?: string[];
  sessionIds?: string[];
  challengeIds?: string[];
  planIds?: string[];
  taskSeriesIds?: string[];
  taskOccurrenceIds?: string[];
};

export class IncompleteLockSetError extends Error {
  constructor(readonly missing: LockIds) {
    super('lock set incomplete; retry with the full id set');
    this.name = 'IncompleteLockSetError';
  }
}

function uniqSorted(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).filter(Boolean))].sort();
}

function uniqPolicies(policies: PolicyLock[] | undefined): PolicyLock[] {
  const byId = new Map<string, PolicyLock>();
  for (const policy of policies ?? []) {
    byId.set(policy.id, policy);
  }
  return [...byId.values()].sort((left, right) => {
    return (
      left.policyKey.localeCompare(right.policyKey) ||
      left.locale.localeCompare(right.locale) ||
      left.id.localeCompare(right.id)
    );
  });
}

export function normalizeLockIds(ids: LockIds): {
  idempotencyIds: string[];
  identityAdvisoryKeys: string[];
  identityIds: string[];
  lookupIds: string[];
  accountIds: string[];
  studentIds: string[];
  gradeConfigIds: string[];
  templateVersionIds: string[];
  policies: PolicyLock[];
  linkIds: string[];
  consentIds: string[];
  pairingIds: string[];
  sessionIds: string[];
  challengeIds: string[];
  planIds: string[];
  taskSeriesIds: string[];
  taskOccurrenceIds: string[];
} {
  return {
    idempotencyIds: uniqSorted(ids.idempotencyIds),
    identityAdvisoryKeys: uniqSorted(ids.identityAdvisoryKeys),
    identityIds: uniqSorted(ids.identityIds),
    lookupIds: uniqSorted(ids.lookupIds),
    accountIds: uniqSorted(ids.accountIds),
    studentIds: uniqSorted(ids.studentIds),
    gradeConfigIds: uniqSorted(ids.gradeConfigIds),
    templateVersionIds: uniqSorted(ids.templateVersionIds),
    policies: uniqPolicies(ids.policies),
    linkIds: uniqSorted(ids.linkIds),
    consentIds: uniqSorted(ids.consentIds),
    pairingIds: uniqSorted(ids.pairingIds),
    sessionIds: uniqSorted(ids.sessionIds),
    challengeIds: uniqSorted(ids.challengeIds),
    planIds: uniqSorted(ids.planIds),
    taskSeriesIds: uniqSorted(ids.taskSeriesIds),
    taskOccurrenceIds: uniqSorted(ids.taskOccurrenceIds),
  };
}

export function mergeLockIds(left: LockIds, right: LockIds): LockIds {
  return {
    idempotencyIds: [...(left.idempotencyIds ?? []), ...(right.idempotencyIds ?? [])],
    identityAdvisoryKeys: [...(left.identityAdvisoryKeys ?? []), ...(right.identityAdvisoryKeys ?? [])],
    identityIds: [...(left.identityIds ?? []), ...(right.identityIds ?? [])],
    lookupIds: [...(left.lookupIds ?? []), ...(right.lookupIds ?? [])],
    accountIds: [...(left.accountIds ?? []), ...(right.accountIds ?? [])],
    studentIds: [...(left.studentIds ?? []), ...(right.studentIds ?? [])],
    gradeConfigIds: [...(left.gradeConfigIds ?? []), ...(right.gradeConfigIds ?? [])],
    templateVersionIds: [...(left.templateVersionIds ?? []), ...(right.templateVersionIds ?? [])],
    policies: [...(left.policies ?? []), ...(right.policies ?? [])],
    linkIds: [...(left.linkIds ?? []), ...(right.linkIds ?? [])],
    consentIds: [...(left.consentIds ?? []), ...(right.consentIds ?? [])],
    pairingIds: [...(left.pairingIds ?? []), ...(right.pairingIds ?? [])],
    sessionIds: [...(left.sessionIds ?? []), ...(right.sessionIds ?? [])],
    challengeIds: [...(left.challengeIds ?? []), ...(right.challengeIds ?? [])],
    planIds: [...(left.planIds ?? []), ...(right.planIds ?? [])],
    taskSeriesIds: [...(left.taskSeriesIds ?? []), ...(right.taskSeriesIds ?? [])],
    taskOccurrenceIds: [...(left.taskOccurrenceIds ?? []), ...(right.taskOccurrenceIds ?? [])],
  };
}

function includesAll(planned: string[], discovered: string[]): boolean {
  return discovered.every((id) => planned.includes(id));
}

export function lockIdsContain(planned: LockIds, discovered: LockIds): boolean {
  const left = normalizeLockIds(planned);
  const right = normalizeLockIds(discovered);
  return (
    includesAll(left.idempotencyIds, right.idempotencyIds) &&
    includesAll(left.identityAdvisoryKeys, right.identityAdvisoryKeys) &&
    includesAll(left.identityIds, right.identityIds) &&
    includesAll(left.lookupIds, right.lookupIds) &&
    includesAll(left.accountIds, right.accountIds) &&
    includesAll(left.studentIds, right.studentIds) &&
    includesAll(left.gradeConfigIds, right.gradeConfigIds) &&
    includesAll(left.templateVersionIds, right.templateVersionIds) &&
    includesAll(
      left.policies.map((item) => item.id),
      right.policies.map((item) => item.id),
    ) &&
    includesAll(left.linkIds, right.linkIds) &&
    includesAll(left.consentIds, right.consentIds) &&
    includesAll(left.pairingIds, right.pairingIds) &&
    includesAll(left.sessionIds, right.sessionIds) &&
    includesAll(left.challengeIds, right.challengeIds) &&
    includesAll(left.planIds, right.planIds) &&
    includesAll(left.taskSeriesIds, right.taskSeriesIds) &&
    includesAll(left.taskOccurrenceIds, right.taskOccurrenceIds)
  );
}

export function assertLockSetComplete(planned: LockIds, discovered: LockIds): void {
  if (!lockIdsContain(planned, discovered)) {
    throw new IncompleteLockSetError(discovered);
  }
}

function uuidIn(ids: string[]): Prisma.Sql {
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
}

async function lockTable(
  tx: Prisma.TransactionClient,
  sql: Prisma.Sql,
): Promise<void> {
  await tx.$queryRaw(sql);
}

export async function readLockedNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const now = rows[0]?.now;
  if (!now) {
    throw new Error('clock_timestamp() returned no row');
  }
  return now;
}

export async function acquireLocks(tx: Prisma.TransactionClient, raw: LockIds): Promise<void> {
  const ids = normalizeLockIds(raw);

  if (ids.idempotencyIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM idempotency_records WHERE id IN (${uuidIn(ids.idempotencyIds)}) ORDER BY id FOR UPDATE`,
    );
  }
  for (const key of ids.identityAdvisoryKeys) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }
  if (ids.identityIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM auth_identities WHERE id IN (${uuidIn(ids.identityIds)}) ORDER BY id FOR UPDATE`,
    );
  }
  if (ids.lookupIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM auth_identity_lookups WHERE id IN (${uuidIn(ids.lookupIds)}) ORDER BY id FOR UPDATE`,
    );
  }
  if (ids.accountIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM accounts WHERE id IN (${uuidIn(ids.accountIds)}) ORDER BY id FOR UPDATE`,
    );
  }
  if (ids.studentIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM student_profiles WHERE id IN (${uuidIn(ids.studentIds)}) ORDER BY id FOR UPDATE`,
    );
  }
  if (ids.gradeConfigIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM grade_configs WHERE id IN (${uuidIn(ids.gradeConfigIds)}) ORDER BY id FOR SHARE`,
    );
  }
  if (ids.templateVersionIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM plan_template_versions WHERE id IN (${uuidIn(ids.templateVersionIds)}) ORDER BY id FOR SHARE`,
    );
  }
  if (ids.policies.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM consent_policies WHERE id IN (${uuidIn(ids.policies.map((item) => item.id))}) ORDER BY policy_key, locale, id FOR UPDATE`,
    );
  }
  if (ids.linkIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM guardian_links WHERE id IN (${uuidIn(ids.linkIds)}) ORDER BY id FOR UPDATE`,
    );
  }
  if (ids.consentIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM consent_records WHERE id IN (${uuidIn(ids.consentIds)}) ORDER BY id FOR UPDATE`,
    );
  }
  if (ids.pairingIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM device_pairings WHERE id IN (${uuidIn(ids.pairingIds)}) ORDER BY id FOR UPDATE`,
    );
  }
  if (ids.challengeIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM auth_challenges WHERE id IN (${uuidIn(ids.challengeIds)}) ORDER BY id FOR UPDATE`,
    );
  }
  if (ids.sessionIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM device_sessions WHERE id IN (${uuidIn(ids.sessionIds)}) ORDER BY id FOR UPDATE`,
    );
  }
  if (ids.planIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM study_plans WHERE id IN (${uuidIn(ids.planIds)}) ORDER BY id FOR UPDATE`,
    );
  }
  if (ids.taskSeriesIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM task_series WHERE id IN (${uuidIn(ids.taskSeriesIds)}) ORDER BY id FOR UPDATE`,
    );
  }
  if (ids.taskOccurrenceIds.length > 0) {
    await lockTable(
      tx,
      Prisma.sql`SELECT id FROM task_occurrences WHERE id IN (${uuidIn(ids.taskOccurrenceIds)}) ORDER BY id FOR UPDATE`,
    );
  }
}

export function isRetryableTx(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'P2034' || code === '40P01' || code === '40001') {
    return true;
  }
  if (code === 'P2002') {
    const target = JSON.stringify(error);
    return /auth_identity_lookups|auth_identities|AuthIdentityLookup|AuthIdentity/.test(target);
  }
  const message = error instanceof Error ? error.message : String(error);
  return /deadlock detected|could not serialize|serialization failure/i.test(message);
}

export async function runWriteTx<T>(
  prisma: PrismaClient,
  work: (tx: Prisma.TransactionClient, extra: LockIds) => Promise<T>,
  seed: LockIds = {},
): Promise<T> {
  let extra = normalizeLockIds(seed);
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await prisma.$transaction((tx) => work(tx, extra), {
        maxWait: 5_000,
        timeout: 30_000,
      });
    } catch (error) {
      lastError = error;
      if (error instanceof IncompleteLockSetError) {
        extra = normalizeLockIds(mergeLockIds(extra, error.missing));
        continue;
      }
      if (isRetryableTx(error) && attempt < 4) {
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}
