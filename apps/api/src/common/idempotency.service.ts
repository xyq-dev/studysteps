import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { AppError } from './app-error';
import { digestCanonical, hmacHex } from './crypto';
import { RuntimeConfig } from './runtime-config';

export type IdempotencyActor = {
  actorScope: 'GUARDIAN' | 'STUDENT';
  actorId: string;
};

export type IdempotencyReplay = {
  kind: 'REPLAY';
  recordId: string;
  resourceType: string | null;
  resourceId: string | null;
  responseStatus: number | null;
};

export type IdempotencyFresh = {
  kind: 'NEW';
  recordId: string;
};

@Injectable()
export class IdempotencyService {
  constructor(private readonly runtime: RuntimeConfig) {}

  digestKey(actor: IdempotencyActor, operation: string, key: string): string {
    return hmacHex(
      this.runtime.value.keys.lookup,
      `IDEM:${actor.actorScope}:${actor.actorId}:${operation}:${key}`,
    );
  }

  requestDigest(value: unknown): string {
    return digestCanonical(value);
  }

  readKey(header: string | string[] | undefined): string {
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || value.length < 8 || value.length > 128) {
      throw new AppError('VALIDATION_ERROR', '缺少 Idempotency-Key', 400, {
        'Idempotency-Key': 'required',
      });
    }
    return value;
  }

  async peekId(
    db: Prisma.TransactionClient | PrismaClient,
    actor: IdempotencyActor,
    operation: string,
    key: string,
  ): Promise<string | undefined> {
    const row = await db.idempotencyRecord.findUnique({
      where: {
        actorScope_actorId_operation_keyDigest: {
          actorScope: actor.actorScope,
          actorId: actor.actorId,
          operation,
          keyDigest: this.digestKey(actor, operation, key),
        },
      },
    });
    return row?.id;
  }

  async begin(
    tx: Prisma.TransactionClient,
    actor: IdempotencyActor,
    operation: string,
    key: string,
    requestDigest: string,
    now = new Date(),
  ): Promise<IdempotencyFresh | IdempotencyReplay> {
    const keyDigest = this.digestKey(actor, operation, key);
    const existing = await tx.idempotencyRecord.findUnique({
      where: {
        actorScope_actorId_operation_keyDigest: {
          actorScope: actor.actorScope,
          actorId: actor.actorId,
          operation,
          keyDigest,
        },
      },
    });

    if (!existing) {
      try {
        const created = await tx.idempotencyRecord.create({
          data: {
            actorScope: actor.actorScope,
            actorId: actor.actorId,
            operation,
            keyDigest,
            requestDigest,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          },
        });
        return { kind: 'NEW', recordId: created.id };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
      }
    }

    const row =
      existing ??
      (await tx.idempotencyRecord.findUniqueOrThrow({
        where: {
          actorScope_actorId_operation_keyDigest: {
            actorScope: actor.actorScope,
            actorId: actor.actorId,
            operation,
            keyDigest,
          },
        },
      }));

    await tx.$queryRaw`SELECT id FROM idempotency_records WHERE id = ${row.id}::uuid FOR UPDATE`;
    const locked = await tx.idempotencyRecord.findUniqueOrThrow({ where: { id: row.id } });
    if (locked.requestDigest !== requestDigest) {
      throw new AppError('IDEMPOTENCY_CONFLICT', '幂等键冲突', 409);
    }
    if (!locked.completedAt) {
      throw new AppError('IDEMPOTENCY_IN_PROGRESS', '相同请求仍在处理', 409);
    }
    return {
      kind: 'REPLAY',
      recordId: locked.id,
      resourceType: locked.resourceType,
      resourceId: locked.resourceId,
      responseStatus: locked.responseStatus,
    };
  }

  async complete(
    tx: Prisma.TransactionClient | PrismaClient,
    recordId: string,
    resourceType: string,
    resourceId: string,
    responseStatus: number,
    now = new Date(),
  ): Promise<void> {
    await tx.idempotencyRecord.update({
      where: { id: recordId },
      data: {
        resourceType,
        resourceId,
        responseStatus,
        completedAt: now,
      },
    });
  }
}
