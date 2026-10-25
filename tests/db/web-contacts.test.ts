import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { setNow } from '../../src/clock';
import { PAGE_SIZE, listContacts, contactDetail } from '../../src/web/contacts';
import { BadRequest } from '../../src/web/errors';

const pool = getPool(process.env.TEST_DATABASE_URL!);
let ada: number;
let grace: number;
let alan: number;

async function contact(
  first: string,
  last: string,
  email: string,
  company: string,
  status: string,
  next: string | null,
) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
       status, next_action, next_action_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'saas', 'CTO', 'tech', 'Europe/London', 'tech:saas', $5, $6,
       CASE WHEN $6::text IS NULL THEN NULL ELSE '2026-11-06T09:00:00Z'::timestamptz END,
       '2026-10-30T09:00:00Z', '2026-10-30T09:00:00Z') RETURNING id`,
    [first, last, email, company, status, next],
  );
  return rows[0]!.id;
}

async function send(contactId: number, step: string, at: string) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO sends (contact_id, step, idempotency_key, outcome, subject, body, template_source, sent_at)
     VALUES ($1, $2, $1::int::text || ':' || $2, 'accepted', 'Subject ' || $2, 'Body ' || $2, 'ai', $3) RETURNING id`,
    [contactId, step, at],
  );
  return rows[0]!.id;
}

async function event(contactId: number, type: string, data: unknown, at: string) {
  await pool.query(`INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, $2, $3, $4)`, [
    contactId,
    type,
    JSON.stringify(data),
    at,
  ]);
}

beforeAll(async () => {
  await resetDb(pool);
  await setNow(pool, new Date('2026-11-05T09:00:00Z'));
  // 120 plain contacts, ids 1..120: First1 Last1 c1@bulk.example, ...
  await pool.query(
    `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
       status, next_action, next_action_at, created_at, updated_at)
     SELECT 'First' || n, 'Last' || n, 'c' || n || '@bulk.example', 'Bulk Co', 'saas', 'CTO', 'tech', 'UTC', 'tech:saas',
       'new', 'first', '2026-11-06T09:00:00Z', '2026-10-30T09:00:00Z', '2026-10-30T09:00:00Z'
       FROM generate_series(1, 120) AS n`,
  );
  ada = await contact('Ada', 'Lovelace', 'ada@engines.example', 'Analytical Engines', 'replied', null);
  grace = await contact('Grace', 'Hopper', 'grace@navy.example', '100% Navy', 'first_sent', 'follow_up_1');
  alan = await contact('Alan', 'Turing', 'alan_t@bletchley.example', 'Bletchley', 'bounced', null);

  // Ada: two sends and a reply. Events are inserted out of time order on purpose.
  const first = await send(ada, 'first', '2026-11-01T09:00:00Z');
  await send(ada, 'follow_up_1', '2026-11-03T09:00:00Z');
  await pool.query(
    `INSERT INTO replies (contact_id, send_id, body, received_at, true_label, label, label_source, classified_at)
     VALUES ($1, $2, 'Sounds good, call me', '2026-11-04T10:00:00Z', 'interested', 'interested', 'ai', '2026-11-05T09:00:00Z')`,
    [ada, first],
  );
  await event(
    ada,
    'status_changed',
    { from: 'follow_up_1_sent', to: 'replied', reason: 'reply' },
    '2026-11-04T10:00:00Z',
  );
  await event(ada, 'status_changed', { from: 'new', to: 'first_sent', reason: 'send' }, '2026-11-01T09:00:00Z');
  await event(
    ada,
    'status_changed',
    { from: 'first_sent', to: 'follow_up_1_sent', reason: 'send' },
    '2026-11-03T09:00:00Z',
  );
  await send(grace, 'first', '2026-11-02T09:00:00Z');
});

afterAll(async () => {
  await resetDb(pool);
  await closePool();
});

describe('listContacts: pages', () => {
  it('pages 50 at a time, by id', async () => {
    expect(PAGE_SIZE).toBe(50);
    const p1 = await listContacts(pool, {});
    expect(p1.page).toBe(1);
    expect(p1.pageSize).toBe(50);
    expect(p1.total).toBe(123);
    expect(p1.rows).toHaveLength(50);
    const ids = p1.rows.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const p3 = await listContacts(pool, { page: 3 });
    expect(p3.rows).toHaveLength(23);
    expect(p3.rows.at(-1)!.id).toBe(alan);
  });

  it('a page past the end is empty but keeps the total', async () => {
    const p = await listContacts(pool, { page: 4 });
    expect(p.rows).toEqual([]);
    expect(p.total).toBe(123);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses page %s', async (page) => {
    await expect(listContacts(pool, { page })).rejects.toThrow(BadRequest);
  });
});

describe('listContacts: search and filter', () => {
  const emails = async (opts: Parameters<typeof listContacts>[1]) =>
    (await listContacts(pool, opts)).rows.map((r) => r.email);

  it('matches the full name, any case', async () => {
    expect(await emails({ q: 'LOVELACE' })).toEqual(['ada@engines.example']);
    expect(await emails({ q: 'ada lovelace' })).toEqual(['ada@engines.example']);
  });

  it('matches email and company', async () => {
    expect(await emails({ q: 'navy.example' })).toEqual(['grace@navy.example']);
    expect(await emails({ q: 'analytical' })).toEqual(['ada@engines.example']);
  });

  it('treats % and _ as plain characters', async () => {
    expect(await emails({ q: '%' })).toEqual(['grace@navy.example']);
    expect(await emails({ q: '_' })).toEqual(['alan_t@bletchley.example']);
  });

  it('a blank search is no search', async () => {
    expect((await listContacts(pool, { q: '   ' })).total).toBe(123);
    expect((await listContacts(pool, { q: null })).total).toBe(123);
  });

  it('filters by status, alone and with a search', async () => {
    expect(await emails({ status: 'replied' })).toEqual(['ada@engines.example']);
    // First1, First10..First19, First100..First120
    expect((await listContacts(pool, { q: 'first1', status: 'new' })).total).toBe(32);
    expect((await listContacts(pool, { q: 'first1', status: 'replied' })).total).toBe(0);
  });

  it('refuses an unknown status', async () => {
    await expect(listContacts(pool, { status: 'bogus' })).rejects.toThrow(BadRequest);
  });
});

describe('listContacts: row shape', () => {
  it('has the name, status, next action and the latest send and reply', async () => {
    const [row] = (await listContacts(pool, { q: 'ada@' })).rows;
    expect(row).toEqual({
      id: ada,
      name: 'Ada Lovelace',
      email: 'ada@engines.example',
      company: 'Analytical Engines',
      status: 'replied',
      lastSentAt: new Date('2026-11-03T09:00:00Z'),
      lastReplyAt: new Date('2026-11-04T10:00:00Z'),
      nextAction: null,
      nextActionAt: null,
    });
    const [g] = (await listContacts(pool, { q: 'grace' })).rows;
    expect(g!.lastSentAt).toEqual(new Date('2026-11-02T09:00:00Z'));
    expect(g!.lastReplyAt).toBeNull();
    expect(g!.nextAction).toBe('follow_up_1');
    expect(g!.nextActionAt).toEqual(new Date('2026-11-06T09:00:00Z'));
  });
});

describe('contactDetail', () => {
  it('returns the contact, sends, replies and events, each in time order', async () => {
    const d = await contactDetail(pool, ada);
    expect(d).not.toBeNull();
    expect(d!.contact).toMatchObject({
      id: ada,
      name: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'CTO',
      industry: 'saas',
      segment: 'tech:saas',
      timezone: 'Europe/London',
      createdAt: new Date('2026-10-30T09:00:00Z'),
      status: 'replied',
    });
    expect(d!.sends.map((s) => s.step)).toEqual(['first', 'follow_up_1']);
    expect(d!.sends[0]).toMatchObject({ outcome: 'accepted', subject: 'Subject first', templateSource: 'ai' });
    expect(d!.replies).toHaveLength(1);
    expect(d!.replies[0]).toMatchObject({
      body: 'Sounds good, call me',
      label: 'interested',
      labelSource: 'ai',
      trueLabel: 'interested',
      receivedAt: new Date('2026-11-04T10:00:00Z'),
    });
    expect(d!.events.map((e) => e.occurredAt.toISOString())).toEqual([
      '2026-11-01T09:00:00.000Z',
      '2026-11-03T09:00:00.000Z',
      '2026-11-04T10:00:00.000Z',
    ]);
    expect(d!.events[0]!.data).toEqual({ from: 'new', to: 'first_sent', reason: 'send' });
  });

  it('returns null for an unknown id', async () => {
    expect(await contactDetail(pool, 999_999)).toBeNull();
  });

  it('a contact with nothing sent has empty lists', async () => {
    const d = await contactDetail(pool, 1);
    expect(d!.sends).toEqual([]);
    expect(d!.replies).toEqual([]);
    expect(d!.events).toEqual([]);
    expect(grace).toBeGreaterThan(0);
  });
});
