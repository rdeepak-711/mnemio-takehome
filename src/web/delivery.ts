import type { Queryable } from '../clock';
import type { Delivery } from '../config';
import { REGIONS, type Region } from './delivery-view';
import { dayStart, nextDay, parseDay } from './days';
import { BadRequest } from './errors';

export type MailboxDay = {
  id: number;
  address: string;
  limit: number; // warm-up limit for that day, the rule of invariant 8
  emails: number; // engine sends from it that day, bounces included
  bounced: number;
  paused: boolean; // a pause covers the end of the day
  pausedUntil: Date | null; // that pause's resume_at
};
export type HourRow = { hour: number; emails: number; bounced: number; regions: Record<Region, number> };
export type DeliveryPause = {
  mailboxId: number;
  address: string;
  pausedAt: Date;
  resumeAt: Date;
  bounceRate: number;
  sample: number;
};
export type DeliveryDay = {
  enabled: boolean;
  day: string;
  window: { startHour: number; endHour: number } | null;
  cap: number | null;
  totals: { emails: number; bounced: number; capacity: number; mailboxes: number; paused: number };
  mailboxes: MailboxDay[];
  hours: HourRow[];
  domains: { domain: string; emails: number }[];
  pauses: DeliveryPause[];
};

const MAX_DOMAINS = 8;
const MAX_PAUSES = 20;

// $1 = the day's start, $2 = the next day's start. Engine sends only (D64), as a range so the partial indexes apply.
const DAY_SENDS = `s.mailbox_id IS NOT NULL AND s.sent_at >= $1 AND s.sent_at < $2`;
const utcDay = (t: string) => `(${t} AT TIME ZONE 'UTC')::date`;

// The mailboxes that existed by the end of the day, with that day's warm-up limit by the rule of invariant 8: the
// effective start is the creation or the latest resume on or before the day (a pause restarts the warm-up, D67).
// Today's warmup_started_at and paused_until are not read: a past day needs the history in mailbox_pauses.
// $3 the day as a date, $4 mailboxCount, $5 max, $6 start, $7 step.
const MAILBOXES_SQL = `
  WITH m AS (
    SELECT m.id, m.address,
           $3::date - GREATEST(${utcDay('m.created_at')},
             (SELECT max(${utcDay('p.resume_at')}) FROM mailbox_pauses p
               WHERE p.mailbox_id = m.id AND ${utcDay('p.resume_at')} <= $3::date)) AS age,
           (SELECT p.resume_at FROM mailbox_pauses p
             WHERE p.mailbox_id = m.id AND p.paused_at < $2 AND p.resume_at > $2
             ORDER BY p.resume_at DESC LIMIT 1) AS paused_until
      FROM mailboxes m
     WHERE m.created_at < $2 AND m.id <= $4
  ), d AS (
    SELECT s.mailbox_id, count(*)::int AS emails, (count(*) FILTER (WHERE s.outcome = 'bounced'))::int AS bounced
      FROM sends s WHERE ${DAY_SENDS} GROUP BY 1
  )
  SELECT m.id, m.address,
         (CASE WHEN m.age < 0 THEN 0 ELSE LEAST($5::int, $6::int + $7::int * m.age) END)::int AS "limit",
         COALESCE(d.emails, 0) AS emails, COALESCE(d.bounced, 0) AS bounced, m.paused_until AS "pausedUntil"
    FROM m LEFT JOIN d ON d.mailbox_id = m.id
   ORDER BY m.id`;

// The same region rule as regionOf in delivery-view.ts.
const HOURS_SQL = `
  SELECT extract(hour FROM s.sent_at AT TIME ZONE 'UTC')::int AS hour,
         CASE WHEN c.timezone LIKE 'America/%' THEN 'americas'
              WHEN c.timezone LIKE 'Europe/%' THEN 'europe'
              WHEN c.timezone LIKE 'Australia/%' THEN 'australia'
              ELSE 'asia' END AS region,
         count(*)::int AS emails, (count(*) FILTER (WHERE s.outcome = 'bounced'))::int AS bounced
    FROM sends s JOIN contacts c ON c.id = s.contact_id
   WHERE ${DAY_SENDS}
   GROUP BY 1, 2`;

const DOMAINS_SQL = `
  SELECT s.recipient_domain AS domain, count(*)::int AS emails
    FROM sends s WHERE ${DAY_SENDS}
   GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${MAX_DOMAINS}`;

// $1 = the next day's start.
const PAUSES_SQL = `
  SELECT p.mailbox_id AS "mailboxId", m.address, p.paused_at AS "pausedAt", p.resume_at AS "resumeAt",
         p.bounce_rate AS "bounceRate", p.sample
    FROM mailbox_pauses p JOIN mailboxes m ON m.id = p.mailbox_id
   WHERE p.paused_at < $1
   ORDER BY p.paused_at DESC, p.id DESC LIMIT ${MAX_PAUSES}`;

const zeroRegions = (): Record<Region, number> => ({ americas: 0, europe: 0, asia: 0, australia: 0 });

// The selected simulated UTC day as the engine's deliverability saw it (D71): every count is over engine sends with
// sent_at in [day 00:00Z, next day 00:00Z). With deliverability off, the "off" answer and no queries.
export async function deliveryDay(db: Queryable, day: string, delivery: Delivery | null): Promise<DeliveryDay> {
  const key = parseDay(day);
  if (key === null) throw new BadRequest('day: expected a date as YYYY-MM-DD');
  if (delivery === null) {
    return {
      enabled: false,
      day: key,
      window: null,
      cap: null,
      totals: { emails: 0, bounced: 0, capacity: 0, mailboxes: 0, paused: 0 },
      mailboxes: [],
      hours: [],
      domains: [],
      pauses: [],
    };
  }

  const start = dayStart(key);
  const end = dayStart(nextDay(key));
  const { max, start: first, step } = delivery.warmup;
  const [boxes, byHour, domains, pauses] = await Promise.all([
    db.query<Omit<MailboxDay, 'paused'>>(MAILBOXES_SQL, [start, end, key, delivery.mailboxCount, max, first, step]),
    db.query<{ hour: number; region: Region; emails: number; bounced: number }>(HOURS_SQL, [start, end]),
    db.query<{ domain: string; emails: number }>(DOMAINS_SQL, [start, end]),
    db.query<DeliveryPause>(PAUSES_SQL, [end]),
  ]);

  const mailboxes: MailboxDay[] = boxes.rows.map((m) => ({
    id: m.id,
    address: m.address,
    limit: m.limit,
    emails: m.emails,
    bounced: m.bounced,
    paused: m.pausedUntil !== null,
    pausedUntil: m.pausedUntil,
  }));

  const hours: HourRow[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    emails: 0,
    bounced: 0,
    regions: zeroRegions(),
  }));
  for (const r of byHour.rows) {
    const h = hours[r.hour];
    if (!h || !(REGIONS as readonly string[]).includes(r.region)) continue;
    h.emails += r.emails;
    h.bounced += r.bounced;
    h.regions[r.region] += r.emails;
  }

  const emails = hours.reduce((sum, h) => sum + h.emails, 0);
  const bounced = hours.reduce((sum, h) => sum + h.bounced, 0);
  return {
    enabled: true,
    day: key,
    window: { ...delivery.sendWindow },
    cap: delivery.domainDailyCap,
    totals: {
      emails,
      bounced,
      capacity: mailboxes.reduce((sum, m) => sum + m.limit, 0),
      mailboxes: mailboxes.length,
      paused: mailboxes.filter((m) => m.paused).length,
    },
    mailboxes,
    hours,
    domains: domains.rows,
    pauses: pauses.rows.map((p) => ({ ...p, bounceRate: Number(p.bounceRate) })),
  };
}
