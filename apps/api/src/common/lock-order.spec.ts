import { describe, expect, it } from 'vitest';
import { lockIdsContain, mergeLockIds, normalizeLockIds } from './lock-order';

describe('7.7 lock id planning', () => {
  it('sorts policies by policyKey, locale, then id', () => {
    const normalized = normalizeLockIds({
      policies: [
        { id: 'b', policyKey: 'TEST_MINOR_CORE_SERVICE', locale: 'zh-CN' },
        { id: 'a', policyKey: 'TEST_CHILD_CORE_SERVICE', locale: 'zh-CN' },
        { id: 'c', policyKey: 'TEST_CHILD_CORE_SERVICE', locale: 'en-US' },
      ],
    });
    expect(normalized.policies.map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });

  it('requires a retry when an earlier-order id appears after the first plan', () => {
    const planned = { accountIds: ['acct-1'], studentIds: ['stu-1'] };
    const discovered = { accountIds: ['acct-1', 'acct-2'], studentIds: ['stu-1'] };
    expect(lockIdsContain(planned, discovered)).toBe(false);
    expect(normalizeLockIds(mergeLockIds(planned, discovered)).accountIds).toEqual(['acct-1', 'acct-2']);
  });
});
