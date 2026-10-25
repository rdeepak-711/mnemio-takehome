import type { Queryable } from '../clock';
import { PAGE_SIZE, searchPattern, searchSql } from './contacts';
import { dayStart, nextDay, parseDay } from './days';
import { BadRequest } from './errors';
import { refuseFuture } from './summary';

export const ACTIVITY_KINDS = [
  'sent',
  'bounced',
  'reply',
  'unsubscribed',
  'rescheduled',
  'deactivated',
  'suppressed',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type ActivityRow = {
  id: number;
  at: Date;
  kind: ActivityKind;
  contactId: number;
  name: string;
  email: string;
  description: string;
};
export type ActivityPage = { page: number; pageSize: number; total: number; rows: ActivityRow[] };

const STEP: Record<string, string> = {
  first: 'First email',
  follow_up_1: 'Follow-up 1',
  follow_up_2: 'Follow-up 2',
  follow_up_3: 'Follow-up 3',
};
const LABEL: Record<string, string> = {
  interested: 'interested',
  not_interested: 'not interested',
  out_of_office: 'out of office',
  unsubscribe: 'unsubscribe',
  needs_review: 'needs review',
};
const SOURCE: Record<string, string> = { rule: 'a rule', ai: 'the AI', fallback: 'the fallback (no AI answer)' };

// A stored value in words, or the value itself when it has no words.
const words = (table: Record<string, string>, v: unknown) => table[String(v)] ?? String(v);
const day = (v: unknown) => String(v).slice(0, 10);

// One sentence from the event's own stored fields, with nothing added (D61).
export function describeActivity(kind: ActivityKind, data: Record<string, unknown>): string {
  switch (kind) {
    case 'sent':
      return `${words(STEP, data.step)} sent`;
    case 'bounced':
      return `${words(STEP, data.step)} bounced; address added to the do-not-email list`;
    case 'reply':
      return `Reply received, labelled ${words(LABEL, data.label)} by ${words(SOURCE, data.label_source)}`;
    case 'unsubscribed':
      return `Unsubscribe request received (labelled by ${words(SOURCE, data.label_source)}); address added to the do-not-email list`;
    case 'rescheduled':
      return `Out of office: next email moved from ${day(data.from)} to ${day(data.to)}`;
    case 'deactivated':
      return 'Deactivated: no reply after the last follow-up';
    case 'suppressed':
      return `Not emailed: address already on the do-not-email list; now ${String(data.to)}`;
  }
}

// The kind of every event, from its type and data. status_changed events with any other reason (sent, bounced, reply,
// unsubscribe) get no kind: each repeats the send or reply event written with it, so they are never listed.
// $1 = the search pattern or NULL, $2 = the kind or NULL, $3 and $4 = the day's start and end, or NULL.
const select = (columns: string) => `
  WITH a AS (
    SELECT e.id, e.occurred_at, e.contact_id, e.data,
           CASE
             WHEN e.type = 'sent' AND e.data->>'outcome' = 'accepted' THEN 'sent'
             WHEN e.type = 'sent' AND e.data->>'outcome' = 'bounced' THEN 'bounced'
             WHEN e.type = 'reply_received' AND e.data->>'label' = 'unsubscribe' THEN 'unsubscribed'
             WHEN e.type = 'reply_received' THEN 'reply'
             WHEN e.type = 'rescheduled' THEN 'rescheduled'
             WHEN e.type = 'status_changed' AND e.data->>'reason' = 'deactivate_due' THEN 'deactivated'
             WHEN e.type = 'status_changed' AND e.data->>'reason' = 'suppressed' THEN 'suppressed'
           END AS kind
      FROM events e
     WHERE $3::timestamptz IS NULL OR (e.occurred_at >= $3 AND e.occurred_at < $4)
  )
  SELECT ${columns}
    FROM a JOIN contacts c ON c.id = a.contact_id
   WHERE a.kind IS NOT NULL AND ($2::text IS NULL OR a.kind = $2) AND ${searchSql('$1')}`;

const PAGE_SQL = `${select(
  `a.id, a.occurred_at AS at, a.kind, a.contact_id AS "contactId", c.first_name || ' ' || c.last_name AS name,
   c.email, a.data`,
)}
   ORDER BY a.occurred_at DESC, a.id DESC
   LIMIT $5 OFFSET $6`;

const COUNT_SQL = select('count(*)::int AS n');

// Events newest first, 50 per page, filtered by kind, contact search and one simulated UTC day (D61).
export async function listActivity(
  db: Queryable,
  opts: { kind?: string | null; q?: string | null; day?: string | null; page?: number },
): Promise<ActivityPage> {
  const page = opts.page ?? 1;
  if (!Number.isInteger(page) || page < 1) throw new BadRequest(`page: expected a whole number >= 1, got ${page}`);
  const kind = opts.kind || null;
  if (kind !== null && !(ACTIVITY_KINDS as readonly string[]).includes(kind)) {
    throw new BadRequest(`kind: expected one of ${ACTIVITY_KINDS.join(', ')}, got "${kind}"`);
  }
  const key = parseDay(opts.day);
  if (key !== null) await refuseFuture(db, key);
  const start = key === null ? null : dayStart(key);
  const end = key === null ? null : dayStart(nextDay(key));
  const params = [searchPattern(opts.q), kind, start, end];

  // events.id is a bigint, which pg returns as text; it is turned back into a number below.
  const [count, rows] = await Promise.all([
    db.query<{ n: number }>(COUNT_SQL, params),
    db.query<Omit<ActivityRow, 'id' | 'description'> & { id: string; data: Record<string, unknown> }>(PAGE_SQL, [
      ...params,
      PAGE_SIZE,
      (page - 1) * PAGE_SIZE,
    ]),
  ]);
  return {
    page,
    pageSize: PAGE_SIZE,
    total: count.rows[0]?.n ?? 0,
    rows: rows.rows.map(({ data, ...r }) => ({
      ...r,
      id: Number(r.id),
      description: describeActivity(r.kind, data),
    })),
  };
}
