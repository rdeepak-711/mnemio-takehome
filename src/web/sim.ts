import type pg from 'pg';
import type { Config } from '../config';
import { MIGRATIONS_DIR, resetDb } from '../db/migrate';
import { advanceDays, MAX_ADVANCE_DAYS, type TickDeps, type TickSummary } from '../engine/tick';
import { checkInvariants, type Violation } from '../invariants';
import { seed } from '../seed/seed';
import { BadRequest, SimBusy } from './errors';

// One control at a time per server process (D58). Kept on globalThis, so the advance and reset routes share it even
// if Next bundles this module once per route.
const LOCK = '__mnemioSimBusy';
const g = globalThis as typeof globalThis & { [LOCK]?: boolean };

// Takes the lock synchronously, before fn's first await, so of two calls made together exactly one runs.
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  if (g[LOCK]) throw new SimBusy();
  g[LOCK] = true;
  try {
    return await fn();
  } finally {
    g[LOCK] = false;
  }
}

// The engine's advanceDays, the same path as `npm run advance`, then the invariant check.
export async function simAdvance(
  deps: TickDeps,
  days: number,
): Promise<{ days: TickSummary[]; violations: Violation[] }> {
  // Same rule as advanceDays, checked first so a bad value neither moves the clock nor takes the lock.
  if (!Number.isInteger(days) || days < 1 || days > MAX_ADVANCE_DAYS) {
    throw new BadRequest(`days: expected a whole number from 1 to ${MAX_ADVANCE_DAYS}, got ${days}`);
  }
  return withLock(async () => {
    const summaries: TickSummary[] = [];
    await advanceDays(deps, days, (s) => summaries.push(s));
    return { days: summaries, violations: await checkInvariants(deps.pool) };
  });
}

// `npm run db:reset` (keeping saved AI answers, D52) then `npm run seed`.
export async function simReset(pool: pg.Pool, config: Config): Promise<{ contacts: number }> {
  return withLock(async () => {
    await resetDb(pool, MIGRATIONS_DIR, { keepAi: true });
    return seed(pool, config);
  });
}
