import type { DeviceSession, Prisma, PrismaClient } from '@prisma/client';
import { mergeLockIds, type LockIds } from '../common/lock-order';
import { collectForwardLineageIds } from '../auth/session-lineage';

type Db = PrismaClient | Prisma.TransactionClient;

export type StudentGraphOptions = {
  includePairings?: boolean;
  extraConsents?: string[];
  extraSessions?: string[];
  extraPairing?: string;
  session?: DeviceSession | null;
};

export async function collectStudentAuthorizationGraph(
  db: Db,
  studentId: string,
  extra: LockIds = {},
  options: StudentGraphOptions = {},
): Promise<LockIds> {
  const includePairings = options.includePairings !== false;
  const student = await db.studentProfile.findUnique({ where: { id: studentId } });
  const links = await db.guardianLink.findMany({ where: { studentProfileId: studentId } });
  const consents = await db.consentRecord.findMany({ where: { studentProfileId: studentId } });
  const policies = await db.consentPolicy.findMany({
    where: { id: { in: consents.map((item) => item.consentPolicyId) } },
  });
  const pairings = includePairings
    ? await db.devicePairing.findMany({ where: { studentProfileId: studentId } })
    : [];
  const sessions = await db.deviceSession.findMany({ where: { studentProfileId: studentId } });
  const lineage = await collectForwardLineageIds(db, [
    ...sessions.map((item) => item.id),
    ...(extra.sessionIds ?? []),
    ...(options.extraSessions ?? []),
    ...(options.session ? [options.session.id] : []),
  ]);
  return mergeLockIds(
    {
      studentIds: student ? [student.id] : [],
      gradeConfigIds: student?.gradeConfigId ? [student.gradeConfigId] : [],
      accountIds: [
        ...(student ? [student.createdByAccountId, student.ageConfirmedByAccountId] : []),
        ...links.map((item) => item.accountId),
      ],
      policies: policies.map((item) => ({ id: item.id, policyKey: item.policyKey, locale: item.locale })),
      linkIds: links.map((item) => item.id),
      consentIds: consents.map((item) => item.id),
      pairingIds: pairings.map((item) => item.id),
      sessionIds: lineage,
    },
    extra,
  );
}

export async function discoverStudentAuthorizationGraph(
  tx: Prisma.TransactionClient,
  studentId: string,
  options: StudentGraphOptions = {},
): Promise<LockIds> {
  const includePairings = options.includePairings !== false;
  const session = options.session ?? null;
  const extraConsents = options.extraConsents ?? [];
  const extraSessions = options.extraSessions ?? [];
  const extraPairing = options.extraPairing;
  const student = await tx.studentProfile.findUnique({ where: { id: studentId } });
  const links = await tx.guardianLink.findMany({ where: { studentProfileId: studentId } });
  const consents = await tx.consentRecord.findMany({ where: { studentProfileId: studentId } });
  const policies = await tx.consentPolicy.findMany({
    where: { id: { in: consents.map((item) => item.consentPolicyId) } },
  });
  const pairings = includePairings
    ? await tx.devicePairing.findMany({ where: { studentProfileId: studentId } })
    : [];
  const sessions = await tx.deviceSession.findMany({ where: { studentProfileId: studentId } });
  const lineage = await collectForwardLineageIds(tx, [
    ...sessions.map((item) => item.id),
    ...(session ? [session.id] : []),
    ...extraSessions,
  ]);
  return {
    studentIds: student ? [student.id] : [],
    gradeConfigIds: student?.gradeConfigId ? [student.gradeConfigId] : [],
    accountIds: [
      ...(student ? [student.createdByAccountId, student.ageConfirmedByAccountId] : []),
      ...links.map((item) => item.accountId),
      ...(session?.accountId ? [session.accountId] : []),
      ...(session?.issuedByAccountId ? [session.issuedByAccountId] : []),
    ],
    policies: policies.map((item) => ({ id: item.id, policyKey: item.policyKey, locale: item.locale })),
    linkIds: links.map((item) => item.id),
    consentIds: [...consents.map((item) => item.id), ...extraConsents],
    pairingIds: [...pairings.map((item) => item.id), ...(extraPairing ? [extraPairing] : [])],
    sessionIds: lineage,
  };
}

export async function collectLinkedStudentsGraph(
  db: Db,
  accountId: string,
  extra: LockIds = {},
  options: StudentGraphOptions = {},
): Promise<LockIds> {
  const links = await db.guardianLink.findMany({
    where: { accountId, status: 'ACTIVE' },
  });
  let graph: LockIds = extra;
  for (const link of links) {
    graph = await collectStudentAuthorizationGraph(db, link.studentProfileId, graph, options);
  }
  return graph;
}
