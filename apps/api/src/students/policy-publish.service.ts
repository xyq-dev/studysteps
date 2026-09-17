import { Injectable } from '@nestjs/common';
import { TEST_POLICY_KEYS, TEST_POLICY_V2_VERSION } from '@studysteps/contracts';
import { TEST_POLICY_V1_SCOPE, TEST_POLICY_V2_SCOPE } from '@studysteps/domain';
import { AppError } from '../common/app-error';
import { digestCanonical } from '../common/crypto';
import { acquireLocks, assertLockSetComplete, readLockedNow, runWriteTx } from '../common/lock-order';
import { PrismaService } from '../prisma/prisma.service';

export const TEST_POLICY_SCOPE = {
  nickname: true,
  avatar: true,
  age: true,
  educationSnapshot: true,
  timezone: true,
  guardianLink: true,
  authDevice: true,
  consentAudit: true,
};

const V1_TITLES: Record<string, string> = {
  [TEST_POLICY_KEYS.UNDER_14]: '测试儿童核心服务告知（非正式）',
  [TEST_POLICY_KEYS.AGE_14_TO_17]: '测试未成年人核心服务告知（非正式）',
};

const V1_DISCLAIMER = '本文件仅用于隔离测试，不是已批准的正式告知。';
const V2_COVERAGE =
  '本测试版本覆盖：创建与修改学习计划及日程；从已发布年级模板导入；生成并保存任务实例；固化年级快照；记录实际操作者与来源审计。';

export function expectedTestV1Body(policyKey: string): string {
  return `${V1_TITLES[policyKey] ?? ''}\n${V1_DISCLAIMER}`;
}

export function expectedTestV2Body(policyKey: string): string {
  return `${expectedTestV1Body(policyKey)}\n${V2_COVERAGE}`;
}

@Injectable()
export class PolicyPublishService {
  constructor(private readonly prisma: PrismaService) {}

  async publishNext(
    policyKey: string,
    version: string,
    contentBody: string,
    scope: Record<string, boolean> = TEST_POLICY_SCOPE,
  ) {
    const policy = await this.prisma.consentPolicy.findUnique({
      where: { policyKey_locale: { policyKey, locale: 'zh-CN' } },
    });
    if (!policy) {
      throw new AppError('CONSENT_REQUIRED', '测试政策尚未发布', 422);
    }
    const planned = {
      policies: [{ id: policy.id, policyKey: policy.policyKey, locale: policy.locale }],
    };
    return runWriteTx(
      this.prisma,
      async (tx) => {
        await acquireLocks(tx, planned);
        assertLockSetComplete(planned, planned);
        const now = await readLockedNow(tx);
        const latest = await tx.consentPolicy.findUniqueOrThrow({ where: { id: policy.id } });
        const document = await tx.consentDocumentVersion.create({
          data: {
            consentPolicyId: latest.id,
            version,
            contentFormat: 'text/plain',
            contentBody,
            contentDigest: digestCanonical(contentBody),
            scopeCanonicalJson: JSON.stringify(scope),
            scopeDigest: digestCanonical(scope),
            scopeSchemaVersion: '1',
            digestAlgorithmVersion: 'sha256-v1',
            publishedAt: now,
          },
        });
        await tx.consentPolicy.update({
          where: { id: latest.id },
          data: { currentDocumentVersionId: document.id },
        });
        return { documentId: document.id, version: document.version };
      },
      planned,
    );
  }

  async ensureTestV2(policyKey: string): Promise<void> {
    const policy = await this.prisma.consentPolicy.findUnique({
      where: { policyKey_locale: { policyKey, locale: 'zh-CN' } },
      include: { documents: true },
    });
    if (!policy) {
      return;
    }
    const v1 = policy.documents.find((item) => item.version === 'test-v1');
    if (v1) {
      if (v1.contentBody !== expectedTestV1Body(policyKey)) {
        throw new Error(`refusing to mutate or replace test-v1 body for ${policyKey}`);
      }
      if (v1.scopeCanonicalJson !== JSON.stringify(TEST_POLICY_V1_SCOPE)) {
        throw new Error(`refusing to mutate or replace test-v1 scope for ${policyKey}`);
      }
    }
    const v2 = policy.documents.find((item) => item.version === TEST_POLICY_V2_VERSION);
    if (!v2) {
      await this.publishNext(policyKey, TEST_POLICY_V2_VERSION, expectedTestV2Body(policyKey), {
        ...TEST_POLICY_V2_SCOPE,
      });
      return;
    }
    if (policy.currentDocumentVersionId === v2.id) {
      return;
    }
    const planned = {
      policies: [{ id: policy.id, policyKey: policy.policyKey, locale: policy.locale }],
    };
    await runWriteTx(
      this.prisma,
      async (tx) => {
        await acquireLocks(tx, planned);
        assertLockSetComplete(planned, planned);
        const latest = await tx.consentPolicy.findUniqueOrThrow({ where: { id: policy.id } });
        const lockedV1 = await tx.consentDocumentVersion.findFirst({
          where: { consentPolicyId: latest.id, version: 'test-v1' },
        });
        if (lockedV1 && lockedV1.contentBody !== expectedTestV1Body(policyKey)) {
          throw new Error(`refusing to mutate or replace test-v1 body for ${policyKey}`);
        }
        await tx.consentPolicy.update({
          where: { id: latest.id },
          data: { currentDocumentVersionId: v2.id },
        });
      },
      planned,
    );
  }
}
