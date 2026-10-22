import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { checkInvariants } from '../../src/invariants';

const pool = getPool(process.env.TEST_DATABASE_URL!);
const at = (iso: string) => new Date(iso);
const T0 = at('2026-10-20T09:00:00Z');
const T1 = at('2026-10-21T09:00:00Z');
const T2 = at('2026-10-22T09:00:00Z');

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

async function contact(status: string): Promise<{ id: number; email: string }> {
  n += 1;
  const email = `person${n}@acme.example`;
  const next = NEXT[status] ?? null;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
       status, next_action, next_action_at, created_at, updated_at)
     VALUES ('Ann', 'Lee', $1, 'Acme', 'saas', 'CEO', 'founder', 'Europe/London', 'founder:saas', $2, $3, $4, $5, $5)
     RETURNING id`,
    [email, status, next, next ? T2 : null, T0],
  );
  return { id: rows[0]!.id, email };
}

async function send(
  contactId: number,
  step: string,
  sentAt: Date,
  opts: { outcome?: string; outbox?: string | null } = {},
): Promise<number> {
  const outcome = opts.outcome ?? 'accepted';
  const key = `${contactId}:${step}`;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO sends (contact_id, step, idempotency_key, outcome, subject, body, template_source, sent_at)
     VALUES ($1, $2, $3, $4, 'Hi', 'Hello', 'fallback', $5) RETURNING id`,
    [contactId, step, key, outcome, sentAt],
  );
  const outbox = opts.outbox === undefined ? outcome : opts.outbox;
  if (outbox !== null) {
    await pool.query('INSERT INTO mock_outbox (idempotency_key, outcome, received_at) VALUES ($1, $2, $3)', [
      key,
      outbox,
      sentAt,
    ]);
  }
  return rows[0]!.id;
}

async function changed(contactId: number, from: string, to: string, occurredAt: Date) {
  await pool.query(`INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, 'status_changed', $2, $3)`, [
    contactId,
    JSON.stringify({ from, to, reason: 'test' }),
    occurredAt,
  ]);
}

async function suppress(email: string, reason: string, addedAt: Date) {
  await pool.query('INSERT INTO suppression (email, reason, added_at) VALUES ($1, $2, $3)', [email, reason, addedAt]);
}

async function reply(contactId: number, sendId: number, receivedAt: Date, label = 'interested') {
  await pool.query(
    `INSERT INTO replies (contact_id, send_id, body, received_at, true_label, label, label_source, classified_at)
     VALUES ($1, $2, 'Sounds good', $3, $4, $4, 'ai', $3)`,
    [contactId, sendId, receivedAt, label],
  );
}

// A first_sent contact with its send, outbox row and event.
async function firstSent() {
  const c = await contact('first_sent');
  await send(c.id, 'first', T0);
  await changed(c.id, 'new', 'first_sent', T0);
  return c;
}

// A bounced contact with its bounced send, outbox row, suppression row and event.
async function bounced(opts: { suppression?: boolean } = {}) {
  const c = await contact('bounced');
  await send(c.id, 'first', T0, { outcome: 'bounced' });
  if (opts.suppression !== false) await suppress(c.email, 'bounced', T0);
  await changed(c.id, 'new', 'bounced', T0);
  return c;
}

// The invariant numbers reported, without duplicates.
async function reported(limit?: number): Promise<number[]> {
  const violations = await checkInvariants(pool, limit);
  return [...new Set(violations.map((v) => v.invariant))].sort();
}

beforeEach(async () => {
  await resetDb(pool);
  n = 0;
});

afterAll(async () => {
  await closePool();
});

describe('checkInvariants on consistent data', () => {
  it('an empty database has no violations', async () => {
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('a clean hand-built dataset (new, first_sent, bounced) has no violations', async () => {
    await contact('new');
    await firstSent();
    await bounced();
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('a clean replied, unsubscribed and deactivated contact have no violations', async () => {
    const r = await contact('replied');
    const s = await send(r.id, 'first', T0);
    await reply(r.id, s, T1);
    await changed(r.id, 'new', 'first_sent', T0);
    await changed(r.id, 'first_sent', 'replied', T1);

    const u = await contact('unsubscribed');
    const us = await send(u.id, 'first', T0);
    await reply(u.id, us, T1, 'unsubscribe');
    await suppress(u.email, 'unsubscribed', T1);
    await changed(u.id, 'new', 'first_sent', T0);
    await changed(u.id, 'first_sent', 'unsubscribed', T1);

    const d = await contact('deactivated');
    const steps = ['first', 'follow_up_1', 'follow_up_2', 'follow_up_3'];
    const chain = ['new', 'first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent'];
    for (let i = 0; i < 4; i += 1) {
      const when = at(`2026-10-0${i + 1}T09:00:00Z`);
      await send(d.id, steps[i]!, when);
      await changed(d.id, chain[i]!, chain[i + 1]!, when);
    }
    await changed(d.id, 'follow_up_3_sent', 'deactivated', T0);

    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('does not change any rows', async () => {
    await contact('first_sent'); // broken on purpose
    const before = await pool.query('SELECT * FROM contacts ORDER BY id');
    await checkInvariants(pool);
    const after = await pool.query('SELECT * FROM contacts ORDER BY id');
    expect(after.rows).toEqual(before.rows);
  });
});

describe('checkInvariants catches each break, with the right number', () => {
  it('1: first_sent with no sends', async () => {
    const c = await contact('first_sent');
    await changed(c.id, 'new', 'first_sent', T0);
    expect(await reported()).toEqual([1]);
    const violations = await checkInvariants(pool);
    expect(violations[0]!.contactId).toBe(c.id);
    expect(violations[0]!.message.length).toBeGreaterThan(0);
  });

  it('1: a follow_up_1 send with no first send', async () => {
    const c = await contact('first_sent');
    await send(c.id, 'follow_up_1', T0);
    await changed(c.id, 'new', 'first_sent', T0);
    expect(await reported()).toEqual([1]);
  });

  it('1: a new contact that has a send', async () => {
    const c = await contact('new');
    await send(c.id, 'first', T0);
    expect(await reported()).toContain(1);
  });

  it('2: bounced without a suppression row', async () => {
    const c = await bounced({ suppression: false });
    expect(await reported()).toEqual([2]);
    expect((await checkInvariants(pool))[0]!.contactId).toBe(c.id);
  });

  it('2: a bounced suppression row for a contact that is not bounced', async () => {
    const c = await firstSent();
    await suppress(c.email, 'bounced', T0);
    expect(await reported()).toEqual([2]);
    expect((await checkInvariants(pool))[0]!.contactId).toBe(c.id);
  });

  it('2: bounced whose last send was accepted', async () => {
    const c = await contact('bounced');
    await send(c.id, 'first', T0);
    await suppress(c.email, 'bounced', T0);
    await changed(c.id, 'new', 'bounced', T0);
    expect(await reported()).toContain(2);
  });

  // T14: a late "unsubscribe" to an earlier email can arrive after a later email bounced; unsubscribe wins.
  async function unsubscribedAfterBounce(opts: { suppression: boolean }) {
    const c = await contact('unsubscribed');
    const first = await send(c.id, 'first', T0);
    await send(c.id, 'follow_up_1', T1, { outcome: 'bounced' });
    if (opts.suppression) await suppress(c.email, 'bounced', T1);
    await reply(c.id, first, T2, 'unsubscribe');
    await changed(c.id, 'new', 'first_sent', T0);
    await changed(c.id, 'first_sent', 'bounced', T1);
    await changed(c.id, 'bounced', 'unsubscribed', T2);
    return c;
  }

  it('2 and 3: unsubscribed after a bounce, with only the bounced suppression row (first reason wins), is not a break', async () => {
    await unsubscribedAfterBounce({ suppression: true });
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('2: unsubscribed whose last send bounced but with no bounced suppression row is a break', async () => {
    const c = await unsubscribedAfterBounce({ suppression: false });
    await suppress(c.email, 'unsubscribed', T2);
    expect(await reported()).toEqual([2]);
  });

  it('2: unsubscribed with a bounced suppression row but no bounced send is a break', async () => {
    const c = await contact('unsubscribed');
    const s = await send(c.id, 'first', T0);
    await suppress(c.email, 'bounced', T1);
    await reply(c.id, s, T1, 'unsubscribe');
    await changed(c.id, 'new', 'first_sent', T0);
    await changed(c.id, 'first_sent', 'unsubscribed', T1);
    // Also 3: with no bounced send, a bounced row doesn't excuse the missing unsubscribed row.
    expect(await reported()).toEqual([2, 3]);
  });

  it('3: unsubscribed without a suppression row', async () => {
    const c = await contact('unsubscribed');
    const s = await send(c.id, 'first', T0);
    await reply(c.id, s, T1, 'unsubscribe');
    await changed(c.id, 'new', 'first_sent', T0);
    await changed(c.id, 'first_sent', 'unsubscribed', T1);
    expect(await reported()).toEqual([3]);
    expect((await checkInvariants(pool))[0]!.contactId).toBe(c.id);
  });

  it('5: a reply received before its send', async () => {
    const c = await contact('replied');
    const s = await send(c.id, 'first', T1);
    await reply(c.id, s, T0);
    await changed(c.id, 'new', 'first_sent', T1);
    await changed(c.id, 'first_sent', 'replied', T2);
    expect(await reported()).toEqual([5]);
    expect((await checkInvariants(pool))[0]!.contactId).toBe(c.id);
  });

  it('5: a reply to a bounced send', async () => {
    const c = await bounced();
    const { rows } = await pool.query<{ id: number }>('SELECT id FROM sends WHERE contact_id = $1', [c.id]);
    await reply(c.id, rows[0]!.id, T1);
    expect(await reported()).toEqual([5]);
  });

  it('5: a reply whose contact is not the send’s contact', async () => {
    const a = await firstSent();
    const b = await contact('replied');
    const bs = await send(b.id, 'first', T0);
    await changed(b.id, 'new', 'first_sent', T0);
    await changed(b.id, 'first_sent', 'replied', T1);
    await reply(b.id, bs, T1);
    const { rows } = await pool.query<{ id: number }>('SELECT id FROM sends WHERE contact_id = $1', [a.id]);
    await reply(b.id, rows[0]!.id, T1);
    expect(await reported()).toContain(5);
  });

  it('6: a status_changed chain that ends at a different status', async () => {
    const c = await firstSent();
    await changed(c.id, 'first_sent', 'follow_up_1_sent', T1);
    expect(await reported()).toEqual([6]);
    expect((await checkInvariants(pool))[0]!.contactId).toBe(c.id);
  });

  it('6: a first_sent contact with no events', async () => {
    const c = await contact('first_sent');
    await send(c.id, 'first', T0);
    expect(await reported()).toEqual([6]);
  });

  it('6: a chain with a gap (from does not equal the previous to)', async () => {
    const c = await contact('follow_up_1_sent');
    await send(c.id, 'first', T0);
    await send(c.id, 'follow_up_1', T1);
    await changed(c.id, 'new', 'first_sent', T0);
    await changed(c.id, 'new', 'follow_up_1_sent', T1);
    expect(await reported()).toEqual([6]);
  });

  it('6: a chain that does not start at new', async () => {
    const c = await contact('first_sent');
    await send(c.id, 'first', T0);
    await changed(c.id, 'follow_up_1_sent', 'first_sent', T0);
    expect(await reported()).toEqual([6]);
  });

  it('6: replays events in occurred_at order, not insert order', async () => {
    const c = await contact('follow_up_1_sent');
    await send(c.id, 'first', T0);
    await send(c.id, 'follow_up_1', T1);
    await changed(c.id, 'first_sent', 'follow_up_1_sent', T1); // inserted first, happened second
    await changed(c.id, 'new', 'first_sent', T0);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('7: a send with no mock_outbox row', async () => {
    const c = await contact('first_sent');
    await send(c.id, 'first', T0, { outbox: null });
    await changed(c.id, 'new', 'first_sent', T0);
    expect(await reported()).toEqual([7]);
    expect((await checkInvariants(pool))[0]!.contactId).toBe(c.id);
  });

  it('7: a send whose mock_outbox outcome differs', async () => {
    const c = await contact('first_sent');
    await send(c.id, 'first', T0, { outbox: 'bounced' });
    await changed(c.id, 'new', 'first_sent', T0);
    expect(await reported()).toEqual([7]);
  });
});

describe('checkInvariants limit', () => {
  async function brokenContacts(count: number) {
    for (let i = 0; i < count; i += 1) {
      const c = await contact('first_sent');
      await changed(c.id, 'new', 'first_sent', T0);
    }
  }

  it('caps the number returned at the limit', async () => {
    await brokenContacts(5);
    expect(await checkInvariants(pool, 3)).toHaveLength(3);
    expect(await checkInvariants(pool, 10)).toHaveLength(5);
  });

  it('defaults to 50', async () => {
    await brokenContacts(60);
    expect(await checkInvariants(pool)).toHaveLength(50);
  });
});
