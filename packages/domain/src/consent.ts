export type ConsentState = {
  id: string;
  withdrawnAt: Date | null;
  supersededAt: Date | null;
};

export function isCurrentConsent(record: ConsentState): boolean {
  return record.withdrawnAt === null && record.supersededAt === null;
}

export function replayWithdrawEffect(target: ConsentState): 'NOOP' | 'WITHDRAW' {
  return isCurrentConsent(target) ? 'WITHDRAW' : 'NOOP';
}

export function shouldRestrictAfterWithdraw(remainingCurrent: number): boolean {
  return remainingCurrent === 0;
}

export function utcWindowStart(now: Date, sizeMs: number): Date {
  const ms = Math.floor(now.getTime() / sizeMs) * sizeMs;
  return new Date(ms);
}
