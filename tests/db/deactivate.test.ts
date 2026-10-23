import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { checkInvariants } from '../../src/invariants';
import { deliverReplies, processReplies } from '../../src/engine/replies';
import { deactivateDue, DEACTIVATE_BATCH_SIZE } from '../../src/engine/deactivate';

const pool = getPool(process.env.TEST_DATABASE_URL!);
const NOW = new Date('2026-11-02T09:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const NEXT: Record<string, string | null> = {
  new: 'first',
  first_sent: 'follow_up_1',
  follow_up_1_sent: 'follow_up_2',
  follow_up_2_sent: 'follow_up_3',
  follow_up_3_sent: 'deactivate',
  replied: null,
  bounced: null,
  unsubscribed: null,
  deactivated: null,
};
const STEPS = ['first', 'follow_up_1', 'follow_up_2', 'follow_up_3'];
const CHAIN = ['new', 'first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent'];

let n = 0;

// A contact at `status` with consistent prior sends, outbox rows and events. In-sequence ones are due at `due`.
async function contact(status: string, due: Date = NOW): Promise<number> {
  n += 1;
  const next = NEXT[status] ?? null;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
       status, next_action, next_action_at, created_at, updated_at)
     VALUES ('Ann', 'Lee', $1, 'Acme', 'saas', 'CTO', 'tech', 'Europe/London', 'tech:saas', $2, $3, $4, $5, $5)
     RETURNING id`,
    [`person${n}@acme.example`, status, next, next ? due : null, at(-60 * DAY_MS)],
  );
  const id = rows[0]!.id;
  const sends = Math.max(CHAIN.indexOf(status), status === 'replied' || status === 'deactivated' ? 4 : 0);
  let from = 'new';
  for (let i = 0; i < sends; i += 1) {
    const sentAt = at(-(30 - i) * DAY_MS);
    const key = `${id}:${STEPS[i]}`;
    await pool.query(
      `INSERT INTO sends (contact_id, step, idempotency_key, outcome, subject, body, template_source, sent_at)
       VALUES ($1, $2, $3, 'accepted', 's', 'b', 'fallback', $4)`,
      [id, STEPS[i], key, sentAt],
    );
    await pool.query(`INSERT INTO mock_outbox VALUES ($1, 'accepted', $2)`, [key, sentAt]);
    await changed(id, from, CHAIN[i + 1]!, sentAt);
    from = CHAIN[i + 1]!;
  }
  if (from !== status) await changed(id, from, status, at(-2 * DAY_MS));
  return id;
}

async function changed(id: number, from: string, to: string, occurredAt: Date) {
  await pool.query(`INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, 'status_changed', $2, $3)`, [
    id,
    JSON.stringify({ from, to, reason: 'test' }),
    occurredAt,
  ]);
}

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await pool.query<T>(sql, params)).rows;
}
const row = async (id: number) =>
  (await q('SELECT status, next_action, next_action_at, updated_at FROM contacts WHERE id = $1', [id]))[0]!;
const statusOf = async (id: number) => (await row(id)).status;

beforeEach(async () => {
  await resetDb(pool);
  n = 0;
});

afterAll(async () => {
  await closePool();
});

describe('deactivateDue', () => {
  it('a due follow_up_3_sent contact becomes deactivated, with one status_changed event', async () => {
    const id = await contact('follow_up_3_sent', at(-DAY_MS));
    expect(await deactivateDue(pool, NOW)).toEqual({ deactivated: 1 });
    expect(await row(id)).toEqual({ status: 'deactivated', next_action: null, next_action_at: null, updated_at: NOW });
    expect(
      await q('SELECT type, data, occurred_at FROM events WHERE contact_id = $1 AND occurred_at = $2', [id, NOW]),
    ).toEqual([
      {
        type: 'status_changed',
        data: { from: 'follow_up_3_sent', to: 'deactivated', reason: 'deactivate_due' },
        occurred_at: NOW,
      },
    ]);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('due exactly at now counts; one millisecond later does not', async () => {
    const exact = await contact('follow_up_3_sent', NOW);
    const later = await contact('follow_up_3_sent', at(1));
    expect(await deactivateDue(pool, NOW)).toEqual({ deactivated: 1 });
    expect(await statusOf(exact)).toBe('deactivated');
    expect(await row(later)).toMatchObject({
      status: 'follow_up_3_sent',
      next_action: 'deactivate',
      next_action_at: at(1),
    });
  });

  it('never touches other statuses, even when their next action is overdue', async () => {
    const ids = [];
    for (const s of ['new', 'first_sent', 'follow_up_1_sent', 'follow_up_2_sent'])
      ids.push(await contact(s, at(-DAY_MS)));
    for (const s of ['replied', 'deactivated']) ids.push(await contact(s));
    const before = await q('SELECT * FROM contacts ORDER BY id');
    const eventsBefore = await q('SELECT count(*)::int AS n FROM events');
    expect(await deactivateDue(pool, NOW)).toEqual({ deactivated: 0 });
    expect(await q('SELECT * FROM contacts ORDER BY id')).toEqual(before);
    expect(await q('SELECT count(*)::int AS n FROM events')).toEqual(eventsBefore);
  });

  it('a second run at the same now deactivates nothing more', async () => {
    await contact('follow_up_3_sent');
    await deactivateDue(pool, NOW);
    expect(await deactivateDue(pool, NOW)).toEqual({ deactivated: 0 });
    expect((await q(`SELECT count(*)::int AS n FROM events WHERE data->>'reason' = 'deactivate_due'`))[0]).toEqual({
      n: 1,
    });
  });

  it(`works in batches of ${DEACTIVATE_BATCH_SIZE}: more than one batch are all deactivated`, async () => {
    expect(DEACTIVATE_BATCH_SIZE).toBe(500);
    const total = DEACTIVATE_BATCH_SIZE + 37;
    // Bulk insert: building 537 full histories one by one is slow, and only status and due date matter here.
    await pool.query(
      `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
         status, next_action, next_action_at, created_at, updated_at)
       SELECT 'Ann', 'Lee', 'bulk' || g || '@acme.example', 'Acme', 'saas', 'CTO', 'tech', 'Europe/London', 'tech:saas',
              'follow_up_3_sent', 'deactivate', $1::timestamptz - g * interval '1 second', $2, $2
         FROM generate_series(1, $3::int) g`,
      [NOW, at(-60 * DAY_MS), total],
    );
    expect(await deactivateDue(pool, NOW)).toEqual({ deactivated: total });
    expect(await q(`SELECT status, count(*)::int AS n FROM contacts GROUP BY status`)).toEqual([
      { status: 'deactivated', n: total },
    ]);
  });

  it('4 calls at once over 1,200 due contacts deactivate each exactly once', async () => {
    await pool.query(
      `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
         status, next_action, next_action_at, created_at, updated_at)
       SELECT 'Ann', 'Lee', 'bulk' || g || '@acme.example', 'Acme', 'saas', 'CTO', 'tech', 'Europe/London', 'tech:saas',
              'follow_up_3_sent', 'deactivate', $1, $2, $2
         FROM generate_series(1, 1200) g`,
      [at(-DAY_MS), at(-60 * DAY_MS)],
    );
    const results = await Promise.all(Array.from({ length: 4 }, () => deactivateDue(pool, NOW)));
    expect(results.reduce((sum, r) => sum + r.deactivated, 0)).toBe(1200);
    expect((await q(`SELECT count(*)::int AS n FROM events WHERE data->>'reason' = 'deactivate_due'`))[0]).toEqual({
      n: 1200,
    });
    expect((await q(`SELECT count(*)::int AS n FROM contacts WHERE status = 'deactivated'`))[0]).toEqual({ n: 1200 });
  });
});

describe('deactivation inside a tick (replies first)', () => {
  it('a reply processed in the same tick wins: replied, not deactivated', async () => {
    const id = await contact('follow_up_3_sent', at(-DAY_MS));
    await pool.query(
      `INSERT INTO mock_inbox (idempotency_key, body, headers, true_label, deliver_at)
       VALUES ($1, 'Sounds interesting, can we talk on Thursday?', '{}', 'interested', $2)`,
      [`${id}:follow_up_3`, at(-3600_000)],
    );
    await deliverReplies(pool, NOW);
    await processReplies(pool, NOW, { config: { oooDefaultDays: 7 } });
    expect(await deactivateDue(pool, NOW)).toEqual({ deactivated: 0 });
    expect(await statusOf(id)).toBe('replied');
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('a deactivation pushed back by an out-of-office is respected until the new date', async () => {
    const id = await contact('follow_up_3_sent', at(-DAY_MS));
    await pool.query(
      `INSERT INTO mock_inbox (idempotency_key, body, headers, true_label, deliver_at)
       VALUES ($1, 'I am out of the office until 20 November.', '{"Auto-Submitted": "auto-replied"}', 'out_of_office', $2)`,
      [`${id}:follow_up_3`, at(-3600_000)],
    );
    await deliverReplies(pool, NOW);
    await processReplies(pool, NOW, { config: { oooDefaultDays: 7 } });
    const moved = new Date('2026-11-21T00:00:00Z');
    expect(await deactivateDue(pool, NOW)).toEqual({ deactivated: 0 });
    expect(await row(id)).toMatchObject({ status: 'follow_up_3_sent', next_action_at: moved });

    expect(await deactivateDue(pool, moved)).toEqual({ deactivated: 1 });
    expect(await statusOf(id)).toBe('deactivated');
    expect(await checkInvariants(pool)).toEqual([]);
  });
});
