import { Injectable } from '@nestjs/common';
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

@Injectable()
export class PolicyPublishService {
  constructor(private readonly prisma: PrismaService) {}

  async publishNext(policyKey: string, version: string, contentBody: string) {
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
            scopeCanonicalJson: JSON.stringify(TEST_POLICY_SCOPE),
            scopeDigest: digestCanonical(TEST_POLICY_SCOPE),
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
}
