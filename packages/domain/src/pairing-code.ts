const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += CROCKFORD[(value >> bits) & 31];
    }
  }
  if (bits > 0) {
    output += CROCKFORD[(value << (5 - bits)) & 31];
  }
  return output;
}

export function formatPairingCode(raw: string): string {
  const compact = raw.replace(/-/g, '').toUpperCase();
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}`;
}

export function normalizePairingCode(raw: string): string | null {
  const compact = raw.replace(/[-\s]/g, '').toUpperCase();
  if (compact.length !== 8) {
    return null;
  }
  if (![...compact].every((ch) => CROCKFORD.includes(ch))) {
    return null;
  }
  return compact;
}

export function nextAttemptState(
  attemptCount: number,
  maxAttempts: number,
  success: boolean,
): { attemptCount: number; locked: boolean; accepted: boolean } {
  if (attemptCount >= maxAttempts) {
    return { attemptCount, locked: true, accepted: false };
  }
  if (success) {
    return { attemptCount, locked: false, accepted: true };
  }
  const next = attemptCount + 1;
  return {
    attemptCount: next,
    locked: next >= maxAttempts,
    accepted: false,
  };
}
