import type { Queryable } from '../clock';
import { STATUSES, type Status } from '../lifecycle';
import { PAGE_SIZE } from './contacts';
import { dayStart, nextDay, parseDay } from './days';
import { BadRequest } from './errors';
import { LAST_CHANGE_SQL, LAST_STATUS, refuseFuture } from './summary';

export type StageRow = {
  id: number;
  name: string;
  email: string;
  company: string;
  since: Date | null; // when the contact entered the stage; null for a contact still new with no events
  from: string | null;
  reason: string | null;
};
export type StagePage = {
  day: string;
  status: Status;
  page: number;
  pageSize: number;
  total: number;
  rows: StageRow[];
};

// $1 = the end of the day, $2 = the status. The same rebuild as the funnel (D57, D62), so totals match it.
const FROM = `
    FROM contacts c
    LEFT JOIN (${LAST_CHANGE_SQL}) last ON last.contact_id = c.id
   WHERE c.created_at < $1 AND ${LAST_STATUS} = $2`;

const PAGE_SQL = `
  SELECT c.id, c.first_name || ' ' || c.last_name AS name, c.email, c.company, last.occurred_at AS since,
         last.data->>'from' AS "from", last.data->>'reason' AS reason
  ${FROM}
   ORDER BY last.occurred_at DESC NULLS LAST, c.id
   LIMIT $3 OFFSET $4`;

const COUNT_SQL = `SELECT count(*)::int AS n ${FROM}`;

// Who was in `status` at the end of `day` (simulated UTC), most recent entry first, 50 per page.
export async function stageAt(db: Queryable, day: string, status: string, opts: { page?: number }): Promise<StagePage> {
  const page = opts.page ?? 1;
  if (!Number.isInteger(page) || page < 1) throw new BadRequest(`page: expected a whole number >= 1, got ${page}`);
  if (!(STATUSES as readonly string[]).includes(status)) {
    throw new BadRequest(`status: expected one of ${STATUSES.join(', ')}, got "${status}"`);
  }
  const key = parseDay(day);
  if (key === null) throw new BadRequest('day: expected a date as YYYY-MM-DD');
  await refuseFuture(db, key);
  const end = dayStart(nextDay(key));

  const [count, rows] = await Promise.all([
    db.query<{ n: number }>(COUNT_SQL, [end, status]),
    db.query<StageRow>(PAGE_SQL, [end, status, PAGE_SIZE, (page - 1) * PAGE_SIZE]),
  ]);
  return {
    day: key,
    status: status as Status,
    page,
    pageSize: PAGE_SIZE,
    total: count.rows[0]?.n ?? 0,
    rows: rows.rows,
  };
}
