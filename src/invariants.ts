import type { Queryable } from './clock';
import type { Config, Delivery } from './config';
import { UNSUBSCRIBE_BASE_URL, UNSUBSCRIBE_MAILTO, unsubscribeHeaders } from './delivery/rules';
import { windowSql } from './engine/claim';

export type Violation = { invariant: number; contactId: number | null; message: string };

type Row = { contact_id: number | null; message: string };

// Steps in sequence order, so array_position gives a step its 1-based index.
const STEP_ORDER = `ARRAY['first', 'follow_up_1', 'follow_up_2', 'follow_up_3']`;

// One read-only query per invariant. Each returns contact_id and a readable message, ordered by contact.
const CHECKS: readonly { invariant: number; sql: string }[] = [
  {
    // Sends are a gap-free prefix of the steps, their count fits the status, and nothing follows a bounce.
    invariant: 1,
    sql: `
      WITH s AS (
        SELECT contact_id, count(*)::int AS n, max(array_position(${STEP_ORDER}, step)) AS top,
               min(array_position(${STEP_ORDER}, step)) FILTER (WHERE outcome = 'bounced') AS bounced_at
          FROM sends GROUP BY contact_id
      ), c AS (
        SELECT c.id, c.status, coalesce(s.n, 0) AS n, coalesce(s.top, 0) AS top, s.bounced_at
          FROM contacts c LEFT JOIN s ON s.contact_id = c.id
      )
      SELECT id AS contact_id,
             format('status %s with %s send(s) (highest step %s, bounced at step %s)', status, n, top,
                    coalesce(bounced_at::text, 'none')) AS message
        FROM c
       WHERE n <> top
          OR (bounced_at IS NOT NULL AND top > bounced_at)
          OR NOT CASE status
               WHEN 'new' THEN n = 0
               WHEN 'first_sent' THEN n = 1
               WHEN 'follow_up_1_sent' THEN n = 2
               WHEN 'follow_up_2_sent' THEN n = 3
               WHEN 'follow_up_3_sent' THEN n = 4
               WHEN 'deactivated' THEN n = 4
               WHEN 'replied' THEN n BETWEEN 1 AND 4
               WHEN 'bounced' THEN n BETWEEN 1 AND 4
               WHEN 'unsubscribed' THEN n BETWEEN 0 AND 4
               ELSE false
             END
       ORDER BY id LIMIT $1`,
  },
  {
    // bounced <=> last send bounced and a bounced suppression row; either sign alone on another status is a break.
    // unsubscribed may carry both signs together: a late unsubscribe after a bounce wins (D48).
    invariant: 2,
    sql: `
      WITH last AS (
        SELECT DISTINCT ON (contact_id) contact_id, outcome
          FROM sends ORDER BY contact_id, array_position(${STEP_ORDER}, step) DESC
      ), c AS (
        SELECT c.id, c.status, coalesce(l.outcome = 'bounced', false) AS last_bounced,
               EXISTS (SELECT 1 FROM suppression x WHERE x.email = c.email AND x.reason = 'bounced') AS suppressed
          FROM contacts c LEFT JOIN last l ON l.contact_id = c.id
      )
      SELECT id AS contact_id,
             format('status %s, last send bounced: %s, bounced suppression row: %s', status, last_bounced, suppressed)
               AS message
        FROM c
       WHERE (status = 'bounced' AND NOT (last_bounced AND suppressed))
          OR (status = 'unsubscribed' AND last_bounced <> suppressed)
          OR (status NOT IN ('bounced', 'unsubscribed') AND (last_bounced OR suppressed))
       ORDER BY id LIMIT $1`,
  },
  {
    // unsubscribed needs an unsubscribed suppression row, or a bounced one with its last send bounced, since
    // the suppression row keeps its first reason (D48).
    invariant: 3,
    sql: `
      WITH last AS (
        SELECT DISTINCT ON (contact_id) contact_id, outcome
          FROM sends ORDER BY contact_id, array_position(${STEP_ORDER}, step) DESC
      )
      SELECT c.id AS contact_id,
             'status unsubscribed without an unsubscribed suppression row (or a bounced one after a bounced send)'
               AS message
        FROM contacts c LEFT JOIN last l ON l.contact_id = c.id
       WHERE c.status = 'unsubscribed'
         AND NOT EXISTS (SELECT 1 FROM suppression x WHERE x.email = c.email AND x.reason = 'unsubscribed')
         AND NOT (coalesce(l.outcome = 'bounced', false)
                  AND EXISTS (SELECT 1 FROM suppression x WHERE x.email = c.email AND x.reason = 'bounced'))
       ORDER BY c.id LIMIT $1`,
  },
  {
    invariant: 4,
    sql: `
      SELECT id AS contact_id,
             format('status %s with next_action %s at %s', status, coalesce(next_action, 'null'),
                    coalesce(next_action_at::text, 'null')) AS message
        FROM contacts
       WHERE (status IN ('new', 'first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent')
              AND (next_action IS NULL OR next_action_at IS NULL))
          OR (status IN ('replied', 'bounced', 'unsubscribed', 'deactivated')
              AND (next_action IS NOT NULL OR next_action_at IS NOT NULL))
       ORDER BY id LIMIT $1`,
  },
  {
    invariant: 5,
    sql: `
      SELECT r.contact_id,
             format('reply %s to send %s (contact %s, outcome %s): received %s, sent %s', r.id, s.id, s.contact_id,
                    s.outcome, r.received_at, s.sent_at) AS message
        FROM replies r JOIN sends s ON s.id = r.send_id
       WHERE r.received_at <= s.sent_at OR s.outcome <> 'accepted' OR r.contact_id <> s.contact_id
       ORDER BY r.contact_id, r.id LIMIT $1`,
  },
  {
    // Replay status_changed in (occurred_at, id) order: starts at new, no gaps, ends at the current status.
    invariant: 6,
    sql: `
      WITH e AS (
        SELECT contact_id, data->>'from' AS f, data->>'to' AS t,
               lag(data->>'to') OVER w AS prev, row_number() OVER w AS rn,
               row_number() OVER (PARTITION BY contact_id ORDER BY occurred_at DESC, id DESC) AS rd
          FROM events WHERE type = 'status_changed'
        WINDOW w AS (PARTITION BY contact_id ORDER BY occurred_at, id)
      ), a AS (
        SELECT contact_id, bool_or(rn = 1 AND f IS DISTINCT FROM 'new') AS bad_start,
               bool_or(rn > 1 AND f IS DISTINCT FROM prev) AS gap, max(t) FILTER (WHERE rd = 1) AS last_to
          FROM e GROUP BY contact_id
      )
      SELECT c.id AS contact_id,
             CASE
               WHEN a.contact_id IS NULL THEN format('status %s but no status_changed events', c.status)
               WHEN a.bad_start THEN 'status_changed chain does not start at new'
               WHEN a.gap THEN 'status_changed chain has a gap (from differs from the previous to)'
               ELSE format('status_changed chain ends at %s but status is %s', a.last_to, c.status)
             END AS message
        FROM contacts c LEFT JOIN a ON a.contact_id = c.id
       WHERE (a.contact_id IS NULL AND c.status <> 'new')
          OR (a.contact_id IS NOT NULL AND (a.bad_start OR a.gap OR a.last_to IS DISTINCT FROM c.status))
       ORDER BY c.id LIMIT $1`,
  },
  {
    invariant: 7,
    sql: `
      SELECT s.contact_id,
             CASE
               WHEN o.idempotency_key IS NULL THEN format('send %s has no mock_outbox row', s.idempotency_key)
               ELSE format('send %s is %s but mock_outbox says %s', s.idempotency_key, s.outcome, o.outcome)
             END AS message
        FROM sends s LEFT JOIN mock_outbox o ON o.idempotency_key = s.idempotency_key
       WHERE o.idempotency_key IS NULL OR o.outcome <> s.outcome
       ORDER BY s.contact_id, s.id LIMIT $1`,
  },
];

// UTC day of a timestamptz expression.
const utcDay = (t: string) => `(${t} AT TIME ZONE 'UTC')::date`;

// The CTEs d, a and l: `counts` gives d its rows, at least mailbox_id, day (a UTC date) and n, and l adds each
// row's warm-up age and its limit `lim` on that day. The effective start is the creation, or the latest pause's
// resume on or before that day, since a pause restarts the warm-up (D67). $2 max, $3 start, $4 step.
const withWarmupLimit = (counts: string) => `
        WITH d AS (${counts}), a AS (
          SELECT d.*, m.address,
                 d.day - GREATEST(${utcDay('m.created_at')},
                   (SELECT max(${utcDay('p.resume_at')}) FROM mailbox_pauses p
                     WHERE p.mailbox_id = d.mailbox_id AND ${utcDay('p.resume_at')} <= d.day)) AS age
            FROM d JOIN mailboxes m ON m.id = d.mailbox_id
        ), l AS (
          SELECT a.*, CASE WHEN age < 0 THEN 0 ELSE LEAST($2::int, $3::int + $4::int * age) END AS lim FROM a
        )`;

// T22, run only with deliverability on (spec/site.md, Layer 7). "Engine send" = sends.mailbox_id IS NOT NULL.
// $1 is the limit; each check's own parameters follow from $2.
const DELIVERY_CHECKS: readonly { invariant: number; sql: string; params: (d: Delivery, seed: number) => unknown[] }[] =
  [
    {
      // Warm-up limit per (mailbox, UTC day), from withWarmupLimit.
      invariant: 8,
      sql: `
        ${withWarmupLimit(`SELECT mailbox_id, ${utcDay('sent_at')} AS day, count(*)::int AS n
                             FROM sends WHERE mailbox_id IS NOT NULL GROUP BY 1, 2`)}
        SELECT NULL::int AS contact_id,
               format('mailbox %s sent %s on %s, above its warm-up limit of %s (day %s of the warm-up)',
                      address, n, day, lim, age) AS message
          FROM l WHERE n > lim
         ORDER BY mailbox_id, day LIMIT $1`,
      params: (d) => [d.warmup.max, d.warmup.start, d.warmup.step],
    },
    {
      // $2 the cap.
      invariant: 9,
      sql: `
        SELECT NULL::int AS contact_id,
               format('domain %s got %s engine sends on %s, above the cap of %s', recipient_domain, n, day, $2::int)
                 AS message
          FROM (SELECT recipient_domain, ${utcDay('sent_at')} AS day, count(*)::int AS n
                  FROM sends WHERE mailbox_id IS NOT NULL GROUP BY 1, 2) x
         WHERE n > $2::int
         ORDER BY recipient_domain, day LIMIT $1`,
      params: (d) => [d.domainDailyCap],
    },
    {
      // The claim's own window condition, applied to sent_at (D68). $2 start hour, $3 end hour.
      invariant: 10,
      sql: `
        SELECT s.contact_id,
               format('send %s at %s is outside the %s-%s window in %s', s.idempotency_key, s.sent_at, $2::int,
                      $3::int, c.timezone) AS message
          FROM sends s JOIN contacts c ON c.id = s.contact_id
         WHERE s.mailbox_id IS NOT NULL AND NOT (${windowSql('s.sent_at', 'c.timezone', '$2::int', '$3::int')})
         ORDER BY s.contact_id, s.id LIMIT $1`,
      params: (d) => [d.sendWindow.startHour, d.sendWindow.endHour],
    },
    {
      // Strict on both sides: the sends of the batch that paused share paused_at, and resume_at is the restart.
      invariant: 11,
      sql: `
        SELECT s.contact_id,
               format('send %s at %s from mailbox %s while it was paused', s.idempotency_key, s.sent_at, s.mailbox_id)
                 AS message
          FROM sends s
         WHERE s.mailbox_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM mailbox_pauses p
                        WHERE p.mailbox_id = s.mailbox_id AND p.paused_at < s.sent_at AND s.sent_at < p.resume_at)
         ORDER BY s.contact_id, s.id LIMIT $1`,
      params: () => [],
    },
    {
      // The token recomputed in SQL; the rules test pins that it equals unsubscribeToken (D70).
      // $2 seed, $3 the link base, $4 the mailto address, $5 the List-Unsubscribe-Post value.
      invariant: 12,
      sql: `
        WITH t AS (
          SELECT s.id, s.contact_id, s.idempotency_key, s.body, s.headers,
                 left(encode(sha256(convert_to('unsubscribe:' || $2::text || ':' || s.contact_id, 'UTF8')), 'hex'), 16)
                   AS token
            FROM sends s WHERE s.mailbox_id IS NOT NULL
        ), e AS (
          SELECT t.*, $3::text || '/' || contact_id || '/' || token AS link FROM t
        )
        SELECT contact_id,
               CASE
                 WHEN right(body, length(link)) <> link
                   THEN format('send %s body does not end with its unsubscribe link', idempotency_key)
                 ELSE format('send %s has missing or wrong List-Unsubscribe headers', idempotency_key)
               END AS message
          FROM e
         WHERE headers->>'List-Unsubscribe' IS DISTINCT FROM
                 '<mailto:' || $4::text || '?subject=unsubscribe%20' || contact_id || '-' || token || '>, <' || link || '>'
            OR headers->>'List-Unsubscribe-Post' IS DISTINCT FROM $5::text
            OR right(body, length(link)) <> link
         ORDER BY contact_id, id LIMIT $1`,
      params: (_d, seed) => [
        String(seed),
        UNSUBSCRIBE_BASE_URL,
        UNSUBSCRIBE_MAILTO,
        unsubscribeHeaders(seed, 0)['List-Unsubscribe-Post'],
      ],
    },
  ];

// T22c, run only with deliverability and pacing on (D72), after 8–12. Same parameter convention.
const PACING_CHECKS: typeof DELIVERY_CHECKS = [
  {
    // Hourly share per (mailbox, UTC hour): ceil(lim ÷ window hours), lim as in 8 on that hour's UTC day (D72).
    // $2 max, $3 start, $4 step, $5 the window's hours.
    invariant: 13,
    sql: `
        ${withWarmupLimit(`SELECT mailbox_id, hour, hour::date AS day, n
                             FROM (SELECT mailbox_id, date_trunc('hour', sent_at AT TIME ZONE 'UTC') AS hour,
                                          count(*)::int AS n
                                     FROM sends WHERE mailbox_id IS NOT NULL GROUP BY 1, 2) h`)}
        SELECT NULL::int AS contact_id,
               format('mailbox %s sent %s in the hour from %s UTC, above its hourly share of %s (warm-up limit %s)',
                      address, n, hour, share, lim) AS message
          FROM (SELECT l.*, ceil(lim::numeric / $5::int)::int AS share FROM l) x
         WHERE n > share
         ORDER BY mailbox_id, hour LIMIT $1`,
    params: (d) => [d.warmup.max, d.warmup.start, d.warmup.step, d.sendWindow.endHour - d.sendWindow.startHour],
  },
];

// [] means consistent. Returns at most `limit` violations, lowest invariant number first.
// With config.delivery set, 8–12 run after 1–7, and 13 after them when pacing is on, within the same limit.
export async function checkInvariants(
  db: Queryable,
  limit = 50,
  config?: Pick<Config, 'delivery' | 'seed'>,
): Promise<Violation[]> {
  const delivery = config?.delivery;
  const checks = [
    ...CHECKS.map((c) => ({ ...c, params: [] as unknown[] })),
    ...(delivery ? DELIVERY_CHECKS.map((c) => ({ ...c, params: c.params(delivery, config.seed) })) : []),
    ...(delivery && delivery.pacing
      ? PACING_CHECKS.map((c) => ({ ...c, params: c.params(delivery, config.seed) }))
      : []),
  ];
  const violations: Violation[] = [];
  for (const { invariant, sql, params } of checks) {
    const remaining = limit - violations.length;
    if (remaining <= 0) break;
    const { rows } = await db.query<Row>(sql, [remaining, ...params]);
    for (const r of rows) violations.push({ invariant, contactId: r.contact_id, message: r.message });
  }
  return violations;
}
