import type pg from 'pg';
import type { Queryable } from '../clock';
import type { Delivery } from '../config';
import { dueSql, windowSql } from '../engine/claim';
import { mailboxAddress, PAUSE_SAMPLE, shouldPause, warmupLimit } from './rules';

// The per-mailbox and per-domain SQL of the deliverability send path (D66, D67, D69).
// Every function but ensureMailboxes runs on the caller's client, inside its batch transaction.

export type LockedMailbox = { id: number; address: string; warmupStartedAt: Date; pausedUntil: Date | null };

// The start of now's UTC day, as an SQL expression on a parameter.
const dayStart = (now: string) => `(date_trunc('day', ${now}::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
// sent_at on now's UTC day, written as a range so the (…, sent_at) indexes apply.
const onDayOf = (now: string) => `sent_at >= ${dayStart(now)} AND sent_at < ${dayStart(now)} + interval '1 day'`;

// Creates mailboxes 1..count on the first call, with the warm-up starting now; later calls change nothing (D66).
export async function ensureMailboxes(db: Queryable, now: Date, count: number): Promise<void> {
  const addresses = Array.from({ length: count }, (_, i) => mailboxAddress(i + 1));
  try {
    await db.query(
      `INSERT INTO mailboxes (id, address, created_at, warmup_started_at)
       SELECT g, ($3::text[])[g], $1, $1 FROM generate_series(1, $2::int) g
       ON CONFLICT (id) DO NOTHING`,
      [now, count, addresses],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') {
      throw new Error('mailboxes table is missing (migration 003); run npm run db:reset && npm run seed', {
        cause: error,
      });
    }
    throw error;
  }
}

// Locks the first usable mailbox that has due work it may send, for the rest of the transaction (D66).
// SKIP LOCKED, so parallel workers spread over different mailboxes and never wait for one.
export async function lockMailbox(
  client: pg.PoolClient,
  now: Date,
  delivery: Delivery,
  tried: number[],
  skip: number[],
): Promise<LockedMailbox | null> {
  const { rows } = await client.query<LockedMailbox>(
    `SELECT m.id, m.address, m.warmup_started_at AS "warmupStartedAt", m.paused_until AS "pausedUntil"
       FROM mailboxes m
      WHERE m.id <= $2 AND (m.paused_until IS NULL OR m.paused_until <= $1)
        AND NOT (m.id = ANY($3::int[]))
        AND EXISTS (SELECT 1 FROM contacts c
                     WHERE ${dueSql('c.')}
                       AND ${windowSql('$1::timestamptz', 'c.timezone', '$5', '$6')}
                       AND (c.mailbox_id IS NULL OR c.mailbox_id = m.id) AND NOT (c.id = ANY($4::int[])))
      ORDER BY m.id
      LIMIT 1
      FOR UPDATE OF m SKIP LOCKED`,
    [now, delivery.mailboxCount, tried, skip, delivery.sendWindow.startHour, delivery.sendWindow.endHour],
  );
  return rows[0] ?? null;
}

// A pause whose end has passed is cleared; the warm-up already restarted at that moment (D67).
export async function resumeMailbox(client: pg.PoolClient, id: number): Promise<void> {
  await client.query('UPDATE mailboxes SET paused_until = NULL WHERE id = $1', [id]);
}

// What the mailbox may still send on now's UTC day: its warm-up limit minus its sends today, bounces included.
// Exact because the caller holds the mailbox row, so no one else sends from it meanwhile.
export async function mailboxCapacity(
  client: pg.PoolClient,
  id: number,
  now: Date,
  warmup: Delivery['warmup'],
): Promise<number> {
  const { rows } = await client.query<{ age: number; sent: number }>(
    `SELECT (($2::timestamptz AT TIME ZONE 'UTC')::date - (m.warmup_started_at AT TIME ZONE 'UTC')::date)::int AS age,
            (SELECT count(*) FROM sends WHERE mailbox_id = m.id AND ${onDayOf('$2')})::int AS sent
       FROM mailboxes m WHERE m.id = $1`,
    [id, now],
  );
  const row = rows[0];
  if (!row) throw new Error(`mailbox ${id} not found`);
  return warmupLimit(row.age, warmup) - row.sent;
}

// The domain gate (D69). A non-blocking lock, so two batches can never deadlock over domains; while it is held
// no other transaction can add to the domain's count, so the count is exact. False means skip the contact.
export async function domainHasRoom(client: pg.PoolClient, domain: string, now: Date, cap: number): Promise<boolean> {
  const lock = await client.query<{ ok: boolean }>(
    `SELECT pg_try_advisory_xact_lock(hashtext('mnemio:domain:' || $1)) AS ok`,
    [domain],
  );
  if (!lock.rows[0]?.ok) return false;
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sends WHERE recipient_domain = $1 AND mailbox_id IS NOT NULL AND ${onDayOf('$2')}`,
    [domain, now],
  );
  return (rows[0]?.n ?? 0) < cap;
}

// After a bounce: pauses the mailbox if too many of its recent sends bounced (D67). Only sends since the warm-up
// (re)started count, so a mailbox back from a pause starts with a clean sample. True when it paused.
export async function pauseIfBouncing(
  client: pg.PoolClient,
  id: number,
  now: Date,
  delivery: Pick<Delivery, 'pauseBounceRate' | 'pauseDays'>,
): Promise<boolean> {
  const { rows } = await client.query<{ sends: number; bounced: number }>(
    `SELECT count(*)::int AS sends, count(*) FILTER (WHERE outcome = 'bounced')::int AS bounced
       FROM (SELECT outcome FROM sends
              WHERE mailbox_id = $1 AND sent_at >= (SELECT warmup_started_at FROM mailboxes WHERE id = $1)
              ORDER BY sent_at DESC, id DESC
              LIMIT $2) recent`,
    [id, PAUSE_SAMPLE],
  );
  const sample = rows[0] ?? { sends: 0, bounced: 0 };
  if (!shouldPause(sample, delivery.pauseBounceRate)) return false;
  const paused = await client.query<{ resumeAt: Date }>(
    `UPDATE mailboxes SET paused_until = $2::timestamptz + make_interval(days => $3::int),
            warmup_started_at = $2::timestamptz + make_interval(days => $3::int)
      WHERE id = $1 RETURNING paused_until AS "resumeAt"`,
    [id, now, delivery.pauseDays],
  );
  await client.query(
    `INSERT INTO mailbox_pauses (mailbox_id, paused_at, resume_at, bounce_rate, sample) VALUES ($1, $2, $3, $4, $5)`,
    [id, now, paused.rows[0]!.resumeAt, sample.bounced / sample.sends, sample.sends],
  );
  return true;
}
