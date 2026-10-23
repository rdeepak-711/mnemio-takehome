import type pg from 'pg';

export type Slot = { release(): Promise<void> };
export type Limiter = { acquire(): Promise<Slot | null>; usedToday(): Promise<number> };

// One statement, so parallel callers can't both see room under the budget and go over it.
// No row back means the day's budget is used up.
const RESERVE_SQL = `
  INSERT INTO ai.llm_usage (day, calls) VALUES ($1, 1)
  ON CONFLICT (day) DO UPDATE SET calls = ai.llm_usage.calls + 1 WHERE ai.llm_usage.calls < $2
  RETURNING calls`;

const RELEASE_SQL = 'UPDATE ai.llm_usage SET calls = GREATEST(calls - 1, 0) WHERE day = $1';

// OpenRouter's daily quota resets on the UTC date, so this is the one place real time matters (src/ai/ only).
const utcDay = (t: Date): string => t.toISOString().slice(0, 10);

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createLimiter(
  pool: pg.Pool,
  opts: { rpm: number; dailyBudget: number; now?: () => Date; sleep?: (ms: number) => Promise<void> },
): Limiter {
  if (!(opts.rpm > 0)) throw new Error(`rpm: expected a number > 0, got ${opts.rpm}`);
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? realSleep;
  const intervalMs = 60_000 / opts.rpm;

  // Concurrent acquires take turns on this chain; each turn waits out the gap since the last start.
  let chain: Promise<void> = Promise.resolve();
  let lastStart: number | null = null;

  function pace(): Promise<void> {
    const turn = chain.then(async () => {
      if (lastStart !== null) {
        const wait = lastStart + intervalMs - now().getTime();
        if (wait > 0) await sleep(wait);
      }
      lastStart = now().getTime();
    });
    chain = turn.catch(() => undefined); // a failed sleep must not block every later caller
    return turn;
  }

  // The slot remembers its day, so a refund after midnight goes back to the day that paid for it.
  function slotFor(day: string): Slot {
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        await pool.query(RELEASE_SQL, [day]);
      },
    };
  }

  return {
    // The budget is checked before pacing, so a caller over budget never waits for nothing.
    async acquire() {
      if (opts.dailyBudget <= 0) return null;
      const day = utcDay(now());
      const reserved = await pool.query(RESERVE_SQL, [day, opts.dailyBudget]);
      if (reserved.rowCount === 0) return null;
      const slot = slotFor(day);
      try {
        await pace();
      } catch (err) {
        await slot.release(); // no call went out, so the reservation goes back
        throw err;
      }
      return slot;
    },

    async usedToday() {
      const { rows } = await pool.query<{ calls: number }>('SELECT calls FROM ai.llm_usage WHERE day = $1', [
        utcDay(now()),
      ]);
      return rows[0]?.calls ?? 0;
    },
  };
}
