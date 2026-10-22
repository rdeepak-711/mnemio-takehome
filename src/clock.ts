import type pg from 'pg';

// A pool, or a client inside a transaction.
export type Queryable = Pick<pg.Pool, 'query'>;

const NOT_SET = 'sim_clock is not set; run npm run seed';

export async function getNow(db: Queryable): Promise<Date> {
  const { rows } = await db.query<{ now: Date }>('SELECT now FROM sim_clock WHERE id = 1');
  const row = rows[0];
  if (!row) throw new Error(NOT_SET);
  return row.now;
}

export async function setNow(db: Queryable, t: Date): Promise<void> {
  await db.query('INSERT INTO sim_clock (id, now) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET now = EXCLUDED.now', [
    t,
  ]);
}

// One UPDATE, so concurrent callers can't both read the old value and lose a day.
export async function advance(db: Queryable, days: number): Promise<Date> {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`days: expected an integer >= 1, got ${days}`);
  }
  const { rows } = await db.query<{ now: Date }>(
    'UPDATE sim_clock SET now = now + make_interval(days => $1) WHERE id = 1 RETURNING now',
    [days],
  );
  const row = rows[0];
  if (!row) throw new Error(NOT_SET);
  return row.now;
}
