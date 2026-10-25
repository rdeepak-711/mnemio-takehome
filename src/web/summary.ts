import { getNow, type Queryable } from '../clock';
import { IN_SEQUENCE, STATUSES, type Status } from '../lifecycle';
import type { Count } from '../report';
import { dayKey, dayStart, nextDay, phaseOf, type Phase } from './days';
import { BadRequest } from './errors';

export type Summary = {
  day: string;
  phase: Phase;
  statuses: Record<Status, number>; // all 9 keys
  total: number;
  active: number;
  deactivated: number;
  unsubscribed: number;
  sent: number;
  replies: number;
  bounces: number;
  replyRate: Count;
  bounceRate: Count;
};
export type CampaignDays = { first: string; today: string; simStart: string };

// The slider's range: the day of the first event to the sim clock's day. getNow throws "run npm run seed" when the
// clock is not set.
export async function campaignDays(db: Queryable, simStart: Date): Promise<CampaignDays> {
  const today = dayKey(await getNow(db));
  const { rows } = await db.query<{ first: Date | null }>('SELECT min(occurred_at) AS first FROM events');
  const first = rows[0]?.first ? dayKey(rows[0].first) : today;
  return { first: first < today ? first : today, today, simStart: dayKey(simStart) };
}

// Refuses a day after the sim clock's day: the dashboard never shows a future it would have to invent.
export async function refuseFuture(db: Queryable, day: string): Promise<void> {
  const today = dayKey(await getNow(db));
  if (day > today) throw new BadRequest(`day ${day} is in the future; the simulated clock is on ${today}`);
}

// Each contact created before $1 gets the `to` of its last status_changed event before $1, or 'new' (D57).
// One DISTINCT ON pass over events, not a subquery per contact.
const STATUS_SQL = `
  SELECT COALESCE(last.status, 'new') AS status, count(*)::int AS n
    FROM contacts c
    LEFT JOIN (
      SELECT DISTINCT ON (contact_id) contact_id, data->>'to' AS status
        FROM events
       WHERE type = 'status_changed' AND occurred_at < $1
       ORDER BY contact_id, occurred_at DESC, id DESC
    ) last ON last.contact_id = c.id
   WHERE c.created_at < $1
   GROUP BY 1`;

// Sends, replies and the report's rates (D54), all cut off at $1.
const ACTIVITY_SQL = `
  SELECT
    (SELECT count(*) FROM sends WHERE sent_at < $1)::int AS sent,
    (SELECT count(*) FROM sends WHERE sent_at < $1 AND outcome = 'bounced')::int AS bounces,
    (SELECT count(*) FROM replies WHERE received_at < $1)::int AS replies,
    (SELECT count(DISTINCT contact_id) FROM replies WHERE received_at < $1)::int AS replied,
    (SELECT count(DISTINCT contact_id) FROM sends WHERE sent_at < $1 AND outcome = 'accepted')::int AS accepted`;

type ActivityRow = Record<'sent' | 'bounces' | 'replies' | 'replied' | 'accepted', number>;

// The campaign as of the end of `day` (simulated UTC), rebuilt from events.
export async function summaryAt(db: Queryable, day: string, simStart: Date): Promise<Summary> {
  await refuseFuture(db, day);
  const end = dayStart(nextDay(day));

  const statuses = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  const byStatus = await db.query<{ status: Status; n: number }>(STATUS_SQL, [end]);
  for (const { status, n } of byStatus.rows) statuses[status] = n;

  const { rows } = await db.query<ActivityRow>(ACTIVITY_SQL, [end]);
  const a = rows[0];
  if (!a) throw new Error('summary query returned no row');

  return {
    day,
    phase: phaseOf(day, simStart),
    statuses,
    total: STATUSES.reduce((sum, s) => sum + statuses[s], 0),
    active: IN_SEQUENCE.reduce((sum, s) => sum + statuses[s], 0),
    deactivated: statuses.deactivated,
    unsubscribed: statuses.unsubscribed,
    sent: a.sent,
    replies: a.replies,
    bounces: a.bounces,
    replyRate: { count: a.replied, of: a.accepted },
    bounceRate: { count: a.bounces, of: a.sent },
  };
}
