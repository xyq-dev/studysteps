import { Injectable, OnModuleInit } from '@nestjs/common';
import { TEST_POLICY_KEYS } from '@studysteps/contracts';
import { digestCanonical } from '../common/crypto';
import { RuntimeConfig } from '../common/runtime-config';
import { PrismaService } from '../prisma/prisma.service';
import { PolicyPublishService, TEST_POLICY_SCOPE } from './policy-publish.service';

@Injectable()
export class PolicySeedService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: RuntimeConfig,
    private readonly publisher: PolicyPublishService,
  ) {}

  private get config() {
    return this.runtime.value;
  }

  async onModuleInit(): Promise<void> {
    if (!this.runtime?.value.authTestMode || !process.env.DATABASE_URL) {
      return;
    }
    if (this.config.nodeEnv === 'production') {
      return;
    }
    await this.ensure(TEST_POLICY_KEYS.UNDER_14, '测试儿童核心服务告知（非正式）');
    await this.ensure(TEST_POLICY_KEYS.AGE_14_TO_17, '测试未成年人核心服务告知（非正式）');
    await this.publisher.ensureTestV2(TEST_POLICY_KEYS.UNDER_14);
    await this.publisher.ensureTestV2(TEST_POLICY_KEYS.AGE_14_TO_17);
  }

  private async ensure(policyKey: string, body: string): Promise<void> {
    const existing = await this.prisma.consentPolicy.findUnique({
      where: { policyKey_locale: { policyKey, locale: 'zh-CN' } },
    });
    if (existing?.currentDocumentVersionId) {
      return;
    }
    const scopeCanonicalJson = JSON.stringify(TEST_POLICY_SCOPE);
    const policy = existing ?? (await this.prisma.consentPolicy.create({
      data: { policyKey, locale: 'zh-CN' },
    }));
    const doc = await this.prisma.consentDocumentVersion.create({
      data: {
        consentPolicyId: policy.id,
        version: 'test-v1',
        contentFormat: 'text/plain',
        contentBody: `${body}\n本文件仅用于隔离测试，不是已批准的正式告知。`,
        contentDigest: digestCanonical(body),
        scopeCanonicalJson,
        scopeDigest: digestCanonical(TEST_POLICY_SCOPE),
        scopeSchemaVersion: '1',
        digestAlgorithmVersion: 'sha256-v1',
        publishedAt: new Date(),
      },
    });
    await this.prisma.consentPolicy.update({
      where: { id: policy.id },
      data: { currentDocumentVersionId: doc.id },
    });
  }
}
