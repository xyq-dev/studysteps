export type Clock = {
  now(): Date;
};

export const systemClock: Clock = {
  now() {
    return new Date();
  },
};

export function isExpired(now: Date, expiresAt: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}
