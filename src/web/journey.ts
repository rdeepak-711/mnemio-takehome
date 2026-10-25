import type { Queryable } from '../clock';
import { STATUSES, type Status } from '../lifecycle';
import { dayStart, nextDay } from './days';
import { refuseFuture } from './summary';

export type Move = { from: Status; to: Status; count: number };

const SQL = `
  SELECT data->>'from' AS "from", data->>'to' AS "to", count(*)::int AS count
    FROM events
   WHERE type = 'status_changed' AND occurred_at >= $1 AND occurred_at < $2
   GROUP BY 1, 2`;

const order = (s: Status) => STATUSES.indexOf(s);

// Who moved from which status to which during `day`: largest group first, then from and to in STATUSES order.
export async function movesOn(db: Queryable, day: string): Promise<Move[]> {
  await refuseFuture(db, day);
  const { rows } = await db.query<Move>(SQL, [dayStart(day), dayStart(nextDay(day))]);
  return rows.sort((a, b) => b.count - a.count || order(a.from) - order(b.from) || order(a.to) - order(b.to));
}
