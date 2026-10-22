import type pg from 'pg';
import { classifyByRules, findReturnDate } from '../classify/rules';
import type { Config } from '../config';
import { LABELS, type Label } from '../labels';
import { IN_SEQUENCE, transition, type Status } from '../lifecycle';
import { oooReschedule } from '../schedule';

export const REPLY_BATCH_SIZE = 25;
export type ClassifyItem = { id: number; body: string }; // never the true label
export type Classifier = (items: ClassifyItem[]) => Promise<Map<number, Label>>; // T17 plugs in here
export type ReplyDeps = { config: Pick<Config, 'oooDefaultDays'>; classify?: Classifier | undefined };
export type ProcessSummary = { processed: number; rule: number; ai: number; fallback: number };

type LabelSource = 'rule' | 'ai' | 'fallback';
type PendingReply = { id: number; contactId: number; body: string; headers: Record<string, string>; receivedAt: Date };
type Labelled = PendingReply & { label: Label; source: LabelSource; returnDate: Date | null };
type LockedContact = { status: Status; email: string; nextActionAt: Date | null };

// One statement: lock due inbox rows (skipping ones another worker holds), mark them delivered and insert
// the replies, so parallel calls deliver each row exactly once. A row with no send yet is not joined, so it
// stays undelivered until the retried send commits (D35). A reply is never dated before its email (D48).
const DELIVER_SQL = `
  WITH due AS (
    SELECT i.id, s.contact_id, s.id AS send_id, i.body, i.headers, i.true_label,
           CASE WHEN i.deliver_at > s.sent_at THEN i.deliver_at ELSE $1::timestamptz END AS received_at
      FROM mock_inbox i JOIN sends s ON s.idempotency_key = i.idempotency_key
     WHERE NOT i.delivered AND i.deliver_at <= $1::timestamptz
     ORDER BY i.deliver_at, i.id
     FOR UPDATE OF i SKIP LOCKED
  ), marked AS (
    UPDATE mock_inbox m SET delivered = true FROM due WHERE m.id = due.id
  )
  INSERT INTO replies (contact_id, send_id, body, headers, received_at, true_label)
  SELECT contact_id, send_id, body, headers, received_at, true_label FROM due ORDER BY received_at, id`;

export async function deliverReplies(pool: pg.Pool, now: Date): Promise<{ delivered: number }> {
  const result = await pool.query(DELIVER_SQL, [now]);
  return { delivered: result.rowCount ?? 0 };
}

// Unlabelled replies, oldest first; the lock lasts until the batch commits, other workers skip them.
const PENDING_SQL = `
  SELECT id, contact_id AS "contactId", body, headers, received_at AS "receivedAt"
    FROM replies
   WHERE label IS NULL
   ORDER BY received_at, id
   LIMIT $1
   FOR UPDATE SKIP LOCKED`;

const isLabel = (value: unknown): value is Label => (LABELS as readonly unknown[]).includes(value);

// Asks the classifier once for the whole batch; any failure means no answers, never a stopped run (D48).
// A result that isn't a Map (undefined, a plain object) counts as a failure too.
async function askClassifier(items: ClassifyItem[], classify: Classifier | undefined): Promise<Map<number, Label>> {
  if (!classify || items.length === 0) return new Map();
  try {
    const answers: unknown = await classify(items);
    return answers instanceof Map ? (answers as Map<number, Label>) : new Map();
  } catch {
    return new Map();
  }
}

// Rules first, then the classifier for the rest, then needs_review. Dates are read from when the reply arrived.
async function labelBatch(replies: PendingReply[], deps: ReplyDeps): Promise<Labelled[]> {
  const byRule = new Map(
    replies.map((r) => [r.id, classifyByRules({ body: r.body, headers: r.headers }, r.receivedAt)]),
  );
  const rest = replies.filter((r) => byRule.get(r.id) === null);
  const answers = await askClassifier(
    rest.map((r) => ({ id: r.id, body: r.body })),
    deps.classify,
  );
  return replies.map((reply): Labelled => {
    const rule = byRule.get(reply.id);
    if (rule) {
      const returnDate = rule.label === 'out_of_office' ? rule.returnDate : null;
      return { ...reply, label: rule.label, source: 'rule', returnDate };
    }
    const answer = answers.get(reply.id);
    if (isLabel(answer)) {
      const returnDate = answer === 'out_of_office' ? findReturnDate(reply.body, reply.receivedAt) : null;
      return { ...reply, label: answer, source: 'ai', returnDate };
    }
    return { ...reply, label: 'needs_review', source: 'fallback', returnDate: null };
  });
}

async function addEvent(client: pg.PoolClient, contactId: number, type: string, data: object, now: Date) {
  await client.query('INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, $2, $3, $4)', [
    contactId,
    type,
    JSON.stringify(data),
    now,
  ]);
}

// The return date is a calendar day; sent as YYYY-MM-DD so the session time zone can't shift it.
const utcDay = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

async function apply(client: pg.PoolClient, reply: Labelled, now: Date, deps: ReplyDeps): Promise<void> {
  await client.query(
    'UPDATE replies SET label = $2, label_source = $3, return_date = $4, classified_at = $5 WHERE id = $1',
    [reply.id, reply.label, reply.source, utcDay(reply.returnDate), now],
  );
  await addEvent(
    client,
    reply.contactId,
    'reply_received',
    { reply_id: reply.id, label: reply.label, label_source: reply.source },
    now,
  );

  // Re-read under lock each time, so a second reply from the same contact sees the first one's effect.
  const locked = await client.query<LockedContact>(
    'SELECT status, email, next_action_at AS "nextActionAt" FROM contacts WHERE id = $1 FOR UPDATE',
    [reply.contactId],
  );
  const contact = locked.rows[0];
  if (!contact) throw new Error(`reply ${reply.id} points at missing contact ${reply.contactId}`);
  const from = contact.status;

  // The person's wish holds whatever the status; a bounced row already there keeps its reason (D48).
  if (reply.label === 'unsubscribe') {
    await client.query(
      `INSERT INTO suppression (email, reason, added_at) VALUES ($1, 'unsubscribed', $2) ON CONFLICT (email) DO NOTHING`,
      [contact.email, now],
    );
  }

  const next = transition(from, { type: 'reply', label: reply.label });
  if (next.status !== from) {
    await client.query(
      'UPDATE contacts SET status = $2, next_action = NULL, next_action_at = NULL, updated_at = $3 WHERE id = $1',
      [reply.contactId, next.status, now],
    );
    const reason = reply.label === 'unsubscribe' ? 'unsubscribe' : 'reply';
    await addEvent(client, reply.contactId, 'status_changed', { from, to: next.status, reason }, now);
    return;
  }

  // 'unchanged' only comes from an out-of-office to an in-sequence contact; anything else leaves the row alone.
  if (next.nextAction !== 'unchanged' || !IN_SEQUENCE.includes(from)) return;
  if (contact.nextActionAt === null) {
    throw new Error(`contact ${reply.contactId} is ${from} with no next_action_at (invariant 4)`);
  }
  const moved = oooReschedule(contact.nextActionAt, now, reply.returnDate, deps.config.oooDefaultDays);
  if (moved.getTime() === contact.nextActionAt.getTime()) return;
  await client.query('UPDATE contacts SET next_action_at = $2, updated_at = $3 WHERE id = $1', [
    reply.contactId,
    moved,
    now,
  ]);
  await addEvent(
    client,
    reply.contactId,
    'rescheduled',
    { from: contact.nextActionAt.toISOString(), to: moved.toISOString(), cause: 'ooo' },
    now,
  );
}

// Labels and applies unlabelled replies batch by batch; each batch commits as one transaction,
// so a failure undoes the whole batch and its locks are released with it.
export async function processReplies(pool: pg.Pool, now: Date, deps: ReplyDeps): Promise<ProcessSummary> {
  const summary: ProcessSummary = { processed: 0, rule: 0, ai: 0, fallback: 0 };
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    for (;;) {
      await client.query('BEGIN');
      try {
        const { rows } = await client.query<PendingReply>(PENDING_SQL, [REPLY_BATCH_SIZE]);
        if (rows.length === 0) {
          await client.query('COMMIT');
          return summary;
        }
        const labelled = await labelBatch(rows, deps);
        const batch = { rule: 0, ai: 0, fallback: 0 };
        for (const reply of labelled) {
          await apply(client, reply, now, deps);
          batch[reply.source] += 1;
        }
        await client.query('COMMIT');
        summary.processed += labelled.length;
        summary.rule += batch.rule;
        summary.ai += batch.ai;
        summary.fallback += batch.fallback;
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
