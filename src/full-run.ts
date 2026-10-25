import { warmSequences } from './ai/warm';
import { MIGRATIONS_DIR, resetDb } from './db/migrate';
import { advanceDays, MAX_ADVANCE_DAYS, type TickDeps, type TickSummary } from './engine/tick';
import { checkInvariants, type Violation } from './invariants';
import { IN_SEQUENCE } from './lifecycle';
import { report, type Report } from './report';
import { seed } from './seed/seed';

export const DEFAULT_MAX_DAYS = 60;
// Milliseconds of wall-clock time per phase.
export type Timings = {
  reset: number;
  seed: number;
  warm: number;
  advance: number;
  check: number;
  report: number;
  total: number;
};
export type FullRunResult = {
  days: number;
  finished: boolean;
  timings: Timings;
  violations: Violation[];
  report: Report;
};

// Reset (keeping the AI cache), seed, warm the sequences, advance until nobody is in sequence, check, report (D55).
export async function fullRun(
  deps: TickDeps & { timer?: () => number }, // wall-clock timing only, never business time
  opts: { maxDays?: number; onDay?: (summary: TickSummary) => unknown } = {},
): Promise<FullRunResult> {
  const maxDays = opts.maxDays ?? DEFAULT_MAX_DAYS;
  // Checked before any query, so a bad value never resets the database.
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > MAX_ADVANCE_DAYS) {
    throw new Error(`maxDays: expected an integer from 1 to ${MAX_ADVANCE_DAYS}, got ${maxDays}`);
  }
  const timer = deps.timer ?? (() => performance.now());
  const { pool, config, ai } = deps;
  const start = timer();
  let mark = start;
  const lap = (): number => {
    const now = timer();
    const ms = now - mark;
    mark = now;
    return ms;
  };

  await resetDb(pool, MIGRATIONS_DIR, { keepAi: true });
  const reset = lap();
  await seed(pool, config);
  const seeded = lap();
  if (ai) await warmSequences(ai);
  const warm = lap();

  const inSequence = async (): Promise<number> => {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts WHERE status = ANY($1)`, [
      IN_SEQUENCE,
    ]);
    return rows[0]?.n ?? 0;
  };
  let days = 0;
  let left = await inSequence();
  while (left > 0 && days < maxDays) {
    await advanceDays(deps, 1, opts.onDay);
    days += 1;
    left = await inSequence();
  }
  const advance = lap();

  const violations = await checkInvariants(pool);
  const check = lap();
  const result = await report(pool, { simStart: config.simStart, dailyAiBudget: config.dailyAiBudget });
  const reportMs = lap();

  return {
    days,
    finished: left === 0,
    timings: { reset, seed: seeded, warm, advance, check, report: reportMs, total: mark - start },
    violations,
    report: result,
  };
}

export function formatFullRun(r: FullRunResult): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const t = r.timings;
  const end = r.finished
    ? 'finished: nobody left in sequence'
    : `stopped at the limit: ${r.report.inSequence} still in sequence`;
  return [
    `timings: reset ${s(t.reset)} · seed ${s(t.seed)} · warm ${s(t.warm)} · advance ${s(t.advance)} · check ${s(t.check)} · report ${s(t.report)} · total ${s(t.total)}`,
    `days: ${r.days} (${end})`,
  ].join('\n');
}
