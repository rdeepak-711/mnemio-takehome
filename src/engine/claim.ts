import type pg from 'pg';
import type { Delivery } from '../config';
import type { Status, Step } from '../lifecycle';
import type { Industry, RoleFamily } from '../segments';

export type ClaimedContact = {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  industry: Industry;
  role: string;
  roleFamily: RoleFamily;
  timezone: string;
  segment: string;
  status: Status;
  nextAction: Step;
  nextActionAt: Date;
  // The sticky sender (D66). Only selected when a filter is given, so the no-filter query stays the T12 query.
  mailboxId?: number | null;
};

// follow_up_3_sent waits for deactivate, not a send, so the next_action filter leaves it to T15 (D45).
// Suppressed addresses are returned on purpose; the send step handles them (D34).
// `c` is the table alias with its dot ('' or 'c.'); $1 is now. Shared with the mailbox lock (D66).
export function dueSql(c: string): string {
  return `${c}status IN ('new', 'first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent')
    AND ${c}next_action IN ('first', 'follow_up_1', 'follow_up_2', 'follow_up_3')
    AND ${c}next_action_at <= $1`;
}

// Local Monday to Friday and start <= hour < end, at `at` in `timezone` (D68). Postgres's timezone data handles
// daylight saving. The arguments are SQL expressions and parameter names, never values, so nothing is string-built
// from data. Shared with invariant 10; inSendWindow in src/delivery/rules.ts is the same rule in TypeScript.
export function windowSql(at: string, timezone: string, start: string, end: string): string {
  const local = `(${at} AT TIME ZONE ${timezone})`;
  return `extract(isodow FROM ${local}) <= 5
    AND extract(hour FROM ${local}) >= ${start}
    AND extract(hour FROM ${local}) < ${end}`;
}

// With deliverability on (D66, D68, D69); each condition is added only when given, so no filter is the T12 query.
export type ClaimFilter = {
  mailboxId?: number; // only contacts whose mailbox_id is NULL or this
  window?: Delivery['sendWindow']; // only contacts inside their local window at `now`
  skip?: number[]; // contact ids to leave out
};

// Locks a batch of due contacts until the caller's transaction ends; other workers skip them.
// The caller must have run BEGIN on this client, or the lock ends with the statement.
export async function claimDue(
  client: pg.PoolClient,
  now: Date,
  limit: number,
  filter: ClaimFilter = {},
): Promise<ClaimedContact[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit: expected an integer >= 1, got ${limit}`);
  }
  const params: unknown[] = [now, limit];
  const param = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const filtered = filter.mailboxId !== undefined || filter.window !== undefined || filter.skip !== undefined;
  const conditions = [dueSql('')];
  if (filter.mailboxId !== undefined)
    conditions.push(`(mailbox_id IS NULL OR mailbox_id = ${param(filter.mailboxId)})`);
  if (filter.window) {
    const { startHour, endHour } = filter.window;
    conditions.push(windowSql('$1::timestamptz', 'timezone', param(startHour), param(endHour)));
  }
  if (filter.skip && filter.skip.length > 0) conditions.push(`NOT (id = ANY(${param(filter.skip)}::int[]))`);

  const { rows } = await client.query<ClaimedContact>(
    `SELECT id, email, first_name AS "firstName", last_name AS "lastName", company, industry, role,
       role_family AS "roleFamily", timezone, segment, status, next_action AS "nextAction",
       next_action_at AS "nextActionAt"${filtered ? ', mailbox_id AS "mailboxId"' : ''}
     FROM contacts
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY next_action_at, id
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    params,
  );
  return rows;
}
