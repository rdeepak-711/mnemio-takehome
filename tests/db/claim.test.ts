import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { claimDue } from '../../src/engine/claim';

const pool = getPool(process.env.TEST_DATABASE_URL!);
const NOW = new Date('2026-11-02T09:00:00Z');
const at = (msFromNow: number) => new Date(NOW.getTime() + msFromNow);
const DAY_MS = 24 * 60 * 60 * 1000;

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

let n = 0;

async function contact(status: string, dueAt: Date | null = NOW): Promise<number> {
  n += 1;
  const next = NEXT[status] ?? null;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
       status, next_action, next_action_at, created_at, updated_at)
     VALUES ('Ann', 'Lee', $1, 'Acme', 'saas', 'CTO', 'tech', 'Europe/London', 'tech:saas', $2, $3, $4, $5, $5)
     RETURNING id`,
    [`person${n}@acme.example`, status, next, next ? dueAt : null, at(-30 * DAY_MS)],
  );
  return rows[0]!.id;
}

// Runs fn inside BEGIN … ROLLBACK on its own client.
async function inTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

beforeEach(async () => {
  await resetDb(pool);
  n = 0;
});

afterAll(async () => {
  await closePool();
});

describe('what is due', () => {
  it('returns due contacts at every sending step, with camelCase fields', async () => {
    const statuses = ['new', 'first_sent', 'follow_up_1_sent', 'follow_up_2_sent'];
    const created = [];
    for (const s of statuses) created.push(await contact(s, at(-DAY_MS)));
    const claimed = await inTx((c) => claimDue(c, NOW, 10));
    expect(ids(claimed)).toEqual(created);
    expect(claimed.map((r) => r.nextAction)).toEqual(['first', 'follow_up_1', 'follow_up_2', 'follow_up_3']);
    expect(claimed[0]).toEqual({
      id: created[0],
      email: 'person1@acme.example',
      firstName: 'Ann',
      lastName: 'Lee',
      company: 'Acme',
      industry: 'saas',
      role: 'CTO',
      roleFamily: 'tech',
      timezone: 'Europe/London',
      segment: 'tech:saas',
      status: 'new',
      nextAction: 'first',
      nextActionAt: at(-DAY_MS),
    });
  });

  it('due exactly at now counts; one millisecond later does not', async () => {
    const exact = await contact('new', NOW);
    await contact('new', at(1));
    expect(ids(await inTx((c) => claimDue(c, NOW, 10)))).toEqual([exact]);
  });

  it('never returns terminal contacts', async () => {
    for (const s of ['replied', 'bounced', 'unsubscribed', 'deactivated']) await contact(s);
    expect(await inTx((c) => claimDue(c, NOW, 10))).toEqual([]);
  });

  it('never returns follow_up_3_sent (its next action is deactivate), even when due', async () => {
    await contact('follow_up_3_sent', at(-5 * DAY_MS));
    expect(await inTx((c) => claimDue(c, NOW, 10))).toEqual([]);
  });

  it('returns a due contact whose address is suppressed (the send step handles it)', async () => {
    const id = await contact('first_sent');
    await pool.query(
      `INSERT INTO suppression (email, reason, added_at) VALUES ('person1@acme.example', 'unsubscribed', $1)`,
      [NOW],
    );
    expect(ids(await inTx((c) => claimDue(c, NOW, 10)))).toEqual([id]);
  });

  it('limit caps the batch; order is oldest due first, then lowest id', async () => {
    const a = await contact('new', at(-1000));
    const b = await contact('new', at(-3000));
    const c = await contact('new', at(-1000));
    const d = await contact('new', at(-2000));
    expect(ids(await inTx((cl) => claimDue(cl, NOW, 3)))).toEqual([b, d, a]);
    expect(ids(await inTx((cl) => claimDue(cl, NOW, 10)))).toEqual([b, d, a, c]);
  });

  it.each([0, -1, 1.5, Number.NaN])('limit %s throws naming limit', async (limit) => {
    await contact('new');
    await expect(inTx((c) => claimDue(c, NOW, limit))).rejects.toThrow(/limit/);
  });

  it('changes nothing in the table', async () => {
    for (let i = 0; i < 5; i += 1) await contact('new');
    const before = await pool.query('SELECT * FROM contacts ORDER BY id');
    await inTx((c) => claimDue(c, NOW, 10));
    expect((await pool.query('SELECT * FROM contacts ORDER BY id')).rows).toEqual(before.rows);
  });
});

describe('locking', () => {
  it('two transactions at once get disjoint sets, and the second does not wait', async () => {
    for (let i = 0; i < 8; i += 1) await contact('new');
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const first = await claimDue(a, NOW, 5);
      const started = performance.now();
      const second = await claimDue(b, NOW, 5);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(first).toHaveLength(5);
      expect(second).toHaveLength(3);
      const overlap = ids(first).filter((id) => ids(second).includes(id));
      expect(overlap).toEqual([]);
    } finally {
      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
      a.release();
      b.release();
    }
  });

  it('after a rollback, the same contacts can be claimed again', async () => {
    for (let i = 0; i < 3; i += 1) await contact('new');
    const first = await inTx((c) => claimDue(c, NOW, 10));
    const again = await inTx((c) => claimDue(c, NOW, 10));
    expect(ids(again)).toEqual(ids(first));
  });

  it('while one transaction holds its batch, another sees only the rest', async () => {
    for (let i = 0; i < 4; i += 1) await contact('new');
    const a = await pool.connect();
    try {
      await a.query('BEGIN');
      const held = await claimDue(a, NOW, 2);
      const rest = await inTx((c) => claimDue(c, NOW, 10));
      expect(rest).toHaveLength(2);
      expect(ids(rest).some((id) => ids(held).includes(id))).toBe(false);
    } finally {
      await a.query('ROLLBACK');
      a.release();
    }
  });

  it('4 transactions at once over 100 due contacts: no overlap, all 100 covered', async () => {
    for (let i = 0; i < 100; i += 1) await contact('new', at(-i * 1000));
    const clients = await Promise.all(Array.from({ length: 4 }, () => pool.connect()));
    try {
      await Promise.all(clients.map((c) => c.query('BEGIN')));
      const batches = await Promise.all(clients.map((c) => claimDue(c, NOW, 30)));
      const all = batches.flatMap(ids);
      expect(new Set(all).size).toBe(all.length);
      expect(all).toHaveLength(100);
      expect(batches.map((b) => b.length).sort((x, y) => x - y)).toEqual([10, 30, 30, 30]);
    } finally {
      for (const c of clients) {
        await c.query('ROLLBACK');
        c.release();
      }
    }
  });
});
