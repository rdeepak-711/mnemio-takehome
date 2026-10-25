import type { Queryable } from '../clock';
import { TERMINAL } from '../lifecycle';
import { nextDay, phaseOf, type Phase } from './days';
import { campaignDays } from './summary';

export type TimelineDay = {
  day: string;
  phase: Phase;
  firstEmails: number;
  followUps: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
  deactivated: number;
  entered: number;
  left: number;
};

type Counts = Omit<TimelineDay, 'day' | 'phase'>;

// UTC calendar day of a timestamp, as text, so it matches dayKey().
const DAY = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

// Bounced sends count as sends (firstEmails / followUps) and as bounces.
const SENDS_SQL = `
  SELECT ${DAY('sent_at')} AS day,
         count(*) FILTER (WHERE step = 'first')::int AS "firstEmails",
         count(*) FILTER (WHERE step <> 'first')::int AS "followUps",
         count(*) FILTER (WHERE outcome = 'bounced')::int AS bounces
    FROM sends GROUP BY 1`;

const REPLIES_SQL = `SELECT ${DAY('received_at')} AS day, count(*)::int AS replies FROM replies GROUP BY 1`;

// $1 = the finished statuses: a move into one of them leaves the sequence.
const MOVES_SQL = `
  SELECT ${DAY('occurred_at')} AS day,
         count(*) FILTER (WHERE data->>'to' = 'unsubscribed')::int AS unsubscribes,
         count(*) FILTER (WHERE data->>'to' = 'deactivated')::int AS deactivated,
         count(*) FILTER (WHERE data->>'from' = 'new')::int AS entered,
         count(*) FILTER (WHERE data->>'to' = ANY($1))::int AS "left"
    FROM events WHERE type = 'status_changed' GROUP BY 1`;

// One entry per day from the first event to the sim clock's day, zeros on quiet days.
export async function timeline(db: Queryable, simStart: Date): Promise<TimelineDay[]> {
  const { first, today } = await campaignDays(db, simStart);
  const byDay = new Map<string, TimelineDay>();
  for (let day = first; day <= today; day = nextDay(day)) {
    byDay.set(day, {
      day,
      phase: phaseOf(day, simStart),
      firstEmails: 0,
      followUps: 0,
      replies: 0,
      bounces: 0,
      unsubscribes: 0,
      deactivated: 0,
      entered: 0,
      left: 0,
    });
  }

  const results = await Promise.all([
    db.query<{ day: string } & Partial<Counts>>(SENDS_SQL),
    db.query<{ day: string } & Partial<Counts>>(REPLIES_SQL),
    db.query<{ day: string } & Partial<Counts>>(MOVES_SQL, [TERMINAL]),
  ]);
  for (const { rows } of results) {
    for (const { day, ...counts } of rows) {
      const entry = byDay.get(day);
      if (entry) Object.assign(entry, counts); // a day outside the range (none, normally) is dropped
    }
  }
  return [...byDay.values()];
}
