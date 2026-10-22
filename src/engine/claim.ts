import type pg from 'pg';
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
};

// follow_up_3_sent waits for deactivate, not a send, so the next_action filter leaves it to T15 (D45).
// Suppressed addresses are returned on purpose; the send step handles them (D34).
const CLAIM_SQL = `
  SELECT id, email, first_name AS "firstName", last_name AS "lastName", company, industry, role,
    role_family AS "roleFamily", timezone, segment, status, next_action AS "nextAction",
    next_action_at AS "nextActionAt"
  FROM contacts
  WHERE status IN ('new', 'first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent')
    AND next_action IN ('first', 'follow_up_1', 'follow_up_2', 'follow_up_3')
    AND next_action_at <= $1
  ORDER BY next_action_at, id
  LIMIT $2
  FOR UPDATE SKIP LOCKED`;

// Locks a batch of due contacts until the caller's transaction ends; other workers skip them.
// The caller must have run BEGIN on this client, or the lock ends with the statement.
export async function claimDue(client: pg.PoolClient, now: Date, limit: number): Promise<ClaimedContact[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit: expected an integer >= 1, got ${limit}`);
  }
  const { rows } = await client.query<ClaimedContact>(CLAIM_SQL, [now, limit]);
  return rows;
}
