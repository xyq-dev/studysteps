import type pg from 'pg';

export async function waitUntil<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 8000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

export async function backendPid(client: pg.Client): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = result.rows[0]?.pid;
  if (!pid) {
    throw new Error('pg_backend_pid returned no row');
  }
  return pid;
}

const OVERLAP_SQL = `
  SELECT waiter.pid AS waiter_pid,
         $1::int AS holder_pid,
         waiter.wait_event_type,
         waiter.wait_event
    FROM pg_stat_activity waiter
    JOIN LATERAL unnest(pg_blocking_pids(waiter.pid)) AS blocker(pid) ON true
   WHERE blocker.pid = $1
`;

export async function waitForWaiterOnHolder(
  observer: pg.Client,
  holderPid: number,
  label: string,
  timeoutMs = 8000,
) {
  return waitUntil(async () => {
    const result = await observer.query(OVERLAP_SQL, [holderPid]);
    return result.rows[0] ?? null;
  }, label, timeoutMs);
}

export async function waitForAdvisoryWaiter(observer: pg.Client, holderPid: number, label: string) {
  return waitUntil(async () => {
    const result = await observer.query(
      `SELECT waiter.pid AS waiter_pid, holder.pid AS holder_pid
         FROM pg_locks waiter
         JOIN pg_locks holder
           ON holder.locktype = 'advisory'
          AND waiter.locktype = 'advisory'
          AND holder.classid IS NOT DISTINCT FROM waiter.classid
          AND holder.objid IS NOT DISTINCT FROM waiter.objid
          AND holder.objsubid IS NOT DISTINCT FROM waiter.objsubid
          AND holder.pid IS DISTINCT FROM waiter.pid
        WHERE holder.granted
          AND NOT waiter.granted
          AND holder.pid = $1`,
      [holderPid],
    );
    return result.rows[0] ?? null;
  }, label);
}

export async function waitForRelationHolder(
  observer: pg.Client,
  relname: string,
  excludePids: number[],
  label: string,
) {
  return waitUntil(async () => {
    const result = await observer.query(
      `SELECT l.pid, l.mode, l.locktype
         FROM pg_locks l
         JOIN pg_class c ON c.oid = l.relation
        WHERE c.relname = $1
          AND l.granted = true
          AND l.mode IN ('RowShareLock', 'RowExclusiveLock', 'ShareRowExclusiveLock')
          AND NOT (l.pid = ANY($2::int[]))`,
      [relname, excludePids],
    );
    return result.rows[0] ?? null;
  }, label);
}
