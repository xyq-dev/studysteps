import { Prisma, type DeviceSession, type PrismaClient } from '@prisma/client';
import { AppError } from '../common/app-error';

type Db = PrismaClient | Prisma.TransactionClient;

export async function collectForwardLineageIds(db: Db, rootIds: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [...new Set(rootIds.filter(Boolean))];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const row = await db.deviceSession.findUnique({ where: { id } });
    if (row?.replacedBySessionId) {
      queue.push(row.replacedBySessionId);
    }
  }
  return [...seen].sort();
}

export async function lockReplacementPair(
  tx: Prisma.TransactionClient,
  leftId: string,
  rightId: string,
): Promise<void> {
  const ids = [...new Set([leftId, rightId].filter(Boolean))].sort();
  if (ids.length === 0) {
    return;
  }
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM device_sessions WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`,
  );
}

export async function issueReplacementSession(
  tx: Prisma.TransactionClient,
  args: {
    predecessorId: string;
    reason: string;
    lockedNow: Date;
    successor: Prisma.DeviceSessionUncheckedCreateInput;
    failureCode?: 'AUTH_GRANT_INVALID' | 'AUTH_SESSION_INVALID';
  },
): Promise<DeviceSession> {
  const created = await tx.deviceSession.create({ data: args.successor });
  await lockReplacementPair(tx, args.predecessorId, created.id);
  const predecessor = await tx.deviceSession.findUnique({ where: { id: args.predecessorId } });
  if (!predecessor || predecessor.revokedAt) {
    const code = args.failureCode ?? 'AUTH_SESSION_INVALID';
    throw new AppError(code, code === 'AUTH_GRANT_INVALID' ? '验证失败' : '未登录', 401);
  }
  const revoked = await tx.deviceSession.updateMany({
    where: { id: args.predecessorId, revokedAt: null },
    data: {
      revokedAt: args.lockedNow,
      revocationReasonCode: args.reason,
      replacedBySessionId: created.id,
    },
  });
  if (revoked.count !== 1) {
    const code = args.failureCode ?? 'AUTH_SESSION_INVALID';
    throw new AppError(code, code === 'AUTH_GRANT_INVALID' ? '验证失败' : '未登录', 401);
  }
  return created;
}

export async function revokeActiveLineage(
  tx: Prisma.TransactionClient,
  rootId: string,
  lockedNow: Date,
  reason: string,
): Promise<string[]> {
  const ids = await collectForwardLineageIds(tx, [rootId]);
  for (const id of ids) {
    await tx.deviceSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: lockedNow, revocationReasonCode: reason },
    });
  }
  return ids;
}

export async function assertLineageRevoked(tx: Prisma.TransactionClient, rootId: string): Promise<void> {
  const ids = await collectForwardLineageIds(tx, [rootId]);
  for (const id of ids) {
    const row = await tx.deviceSession.findUnique({ where: { id } });
    if (row && row.revokedAt === null) {
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在', 404);
    }
  }
}
