import type { Queryable } from '../clock';
import type { Delivery } from '../config';
import { warmupLimit } from './rules';

// The deliverability block of `npm run report` (T22). Read-only. "Today" is now's UTC day, as everywhere in T22.
export type DeliveryReport = {
  mailboxes: number; // rows in mailboxes with id <= mailboxCount
  pausedNow: number; // paused_until > now
  pauses: number; // rows in mailbox_pauses
  sentToday: number; // engine sends on now's UTC day
  capacityToday: number; // sum of warmupLimit(age today) over mailboxes not paused now
  busiestDomainToday: { domain: string; sent: number } | null;
};

// $1 = now, $2 = mailboxCount.
const DAY_START = `(date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
const TODAY = `mailbox_id IS NOT NULL AND sent_at >= ${DAY_START} AND sent_at < ${DAY_START} + interval '1 day'`;

export async function deliveryReport(db: Queryable, now: Date, delivery: Delivery): Promise<DeliveryReport> {
  const params = [now, delivery.mailboxCount];
  const totals = await db.query<{ mailboxes: number; paused_now: number; pauses: number; sent_today: number }>(
    `SELECT
       (SELECT count(*) FROM mailboxes WHERE id <= $2)::int AS mailboxes,
       (SELECT count(*) FROM mailboxes WHERE id <= $2 AND paused_until > $1)::int AS paused_now,
       (SELECT count(*) FROM mailbox_pauses)::int AS pauses,
       (SELECT count(*) FROM sends WHERE ${TODAY})::int AS sent_today`,
    params,
  );
  // Whole UTC days since each usable mailbox's warm-up (re)started, as in the send step (D66).
  const ages = await db.query<{ age: number }>(
    `SELECT (($1::timestamptz AT TIME ZONE 'UTC')::date - (warmup_started_at AT TIME ZONE 'UTC')::date)::int AS age
       FROM mailboxes WHERE id <= $2 AND (paused_until IS NULL OR paused_until <= $1)`,
    params,
  );
  const busiest = await db.query<{ domain: string; sent: number }>(
    `SELECT recipient_domain AS domain, count(*)::int AS sent FROM sends WHERE ${TODAY}
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 1`,
    [now],
  );
  const t = totals.rows[0]!;
  return {
    mailboxes: t.mailboxes,
    pausedNow: t.paused_now,
    pauses: t.pauses,
    sentToday: t.sent_today,
    capacityToday: ages.rows.reduce((sum, r) => sum + warmupLimit(r.age, delivery.warmup), 0),
    busiestDomainToday: busiest.rows[0] ?? null,
  };
}

export function formatDelivery(r: DeliveryReport, delivery: Delivery): string {
  const { startHour, endHour } = delivery.sendWindow;
  const busiest = r.busiestDomainToday
    ? `${r.busiestDomainToday.domain} (${r.busiestDomainToday.sent} of cap ${delivery.domainDailyCap})`
    : 'none';
  return [
    'Deliverability',
    `  mailboxes: ${r.mailboxes} (${r.pausedNow} paused now, ${r.pauses} ${r.pauses === 1 ? 'pause' : 'pauses'} so far)`,
    `  engine sends today: ${r.sentToday} of ${r.capacityToday} capacity`,
    `  busiest domain today: ${busiest}`,
    `  send window: ${startHour}:00–${endHour}:00 local, Monday to Friday`,
  ].join('\n');
}
