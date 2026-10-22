import type { Queryable } from './clock';

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

// [] means consistent. Returns at most `limit` violations, lowest invariant number first.
export async function checkInvariants(db: Queryable, limit = 50): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const { invariant, sql } of CHECKS) {
    const remaining = limit - violations.length;
    if (remaining <= 0) break;
    const { rows } = await db.query<Row>(sql, [remaining]);
    for (const r of rows) violations.push({ invariant, contactId: r.contact_id, message: r.message });
  }
  return violations;
}
