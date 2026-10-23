import type pg from 'pg';
import { transition, type Status } from '../lifecycle';

export const DEACTIVATE_BATCH_SIZE = 500;

type DueContact = { id: number; status: Status };

// Contacts whose last wait is over, oldest first; the lock lasts until the batch commits, other workers skip them.
// No status filter: transition() is the judge, and it throws if anything but follow_up_3_sent waits to deactivate.
const DUE_SQL = `
  SELECT id, status
    FROM contacts
   WHERE next_action = 'deactivate' AND next_action_at <= $1
   ORDER BY next_action_at, id
   LIMIT $2
   FOR UPDATE SKIP LOCKED`;

// Writes one batch: each new status comes from the rulebook (D25, D49), then one UPDATE per status reached
// and one multi-row insert of status_changed events, all dated at the tick.
async function deactivateBatch(client: pg.PoolClient, contacts: DueContact[], now: Date): Promise<void> {
  const changes = contacts.map((c) => ({
    id: c.id,
    from: c.status,
    to: transition(c.status, { type: 'deactivate_due' }).status,
  }));

  const byStatus = new Map<Status, number[]>();
  for (const change of changes) byStatus.set(change.to, [...(byStatus.get(change.to) ?? []), change.id]);
  for (const [status, ids] of byStatus) {
    await client.query(
      'UPDATE contacts SET status = $2, next_action = NULL, next_action_at = NULL, updated_at = $3 WHERE id = ANY($1)',
      [ids, status, now],
    );
  }

  await client.query(
    `INSERT INTO events (contact_id, type, data, occurred_at)
     SELECT id, 'status_changed', data, $3 FROM unnest($1::int[], $2::jsonb[]) AS e(id, data)`,
    [
      changes.map((c) => c.id),
      changes.map((c) => JSON.stringify({ from: c.from, to: c.to, reason: 'deactivate_due' })),
      now,
    ],
  );
}

// Closes contacts that stayed silent through the last wait, batch by batch; each batch commits as one
// transaction, so a failure undoes the whole batch and its locks are released with it.
export async function deactivateDue(pool: pg.Pool, now: Date): Promise<{ deactivated: number }> {
  const summary = { deactivated: 0 };
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    for (;;) {
      await client.query('BEGIN');
      try {
        const { rows } = await client.query<DueContact>(DUE_SQL, [now, DEACTIVATE_BATCH_SIZE]);
        if (rows.length === 0) {
          await client.query('COMMIT');
          return summary;
        }
        await deactivateBatch(client, rows, now);
        await client.query('COMMIT');
        summary.deactivated += rows.length;
      } catch (error) {
        // A connection that can't even roll back is not handed back to the pool for reuse.
        await client.query('ROLLBACK').catch((rollbackError: Error) => {
          broken = rollbackError;
        });
        throw error;
      }
    }
  } finally {
    client.release(broken);
  }
}
