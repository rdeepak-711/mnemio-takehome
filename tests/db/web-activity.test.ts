import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { ACTIVITY_KINDS, describeActivity, listActivity } from '../../src/web/activity';
import { BadRequest } from '../../src/web/errors';
import { loadWebFixture, type FixtureIds } from '../helpers/web-fixture';

const pool = getPool(process.env.TEST_DATABASE_URL!);
let ids: FixtureIds;

beforeAll(async () => {
  await resetDb(pool);
  ids = await loadWebFixture(pool);
  // Two kinds the fixture doesn't produce on its own.
  await pool.query(
    `INSERT INTO events (contact_id, type, data, occurred_at) VALUES
       ($1, 'rescheduled', '{"from":"2026-11-07T09:00:00.000Z","to":"2026-11-10T00:00:00.000Z","cause":"ooo"}',
        '2026-11-04T08:30:00Z'),
       ($2, 'status_changed', '{"from":"new","to":"bounced","reason":"suppressed"}', '2026-11-04T08:45:00Z')`,
    [ids.A, ids.D],
  );
});

afterAll(async () => {
  await resetDb(pool);
  await closePool();
});

describe('describeActivity: one sentence from the stored data only', () => {
  it.each([
    ['sent', { step: 'first', outcome: 'accepted' }, 'First email sent'],
    ['sent', { step: 'follow_up_2', outcome: 'accepted' }, 'Follow-up 2 sent'],
    [
      'bounced',
      { step: 'follow_up_1', outcome: 'bounced' },
      'Follow-up 1 bounced; address added to the do-not-email list',
    ],
    ['reply', { label: 'interested', label_source: 'ai' }, 'Reply received, labelled interested by the AI'],
    ['reply', { label: 'out_of_office', label_source: 'rule' }, 'Reply received, labelled out of office by a rule'],
    [
      'reply',
      { label: 'needs_review', label_source: 'fallback' },
      'Reply received, labelled needs review by the fallback (no AI answer)',
    ],
    ['reply', { label: 'not_interested', label_source: 'ai' }, 'Reply received, labelled not interested by the AI'],
    [
      'unsubscribed',
      { label: 'unsubscribe', label_source: 'rule' },
      'Unsubscribe request received (labelled by a rule); address added to the do-not-email list',
    ],
    [
      'rescheduled',
      { from: '2026-11-07T09:00:00.000Z', to: '2026-11-10T00:00:00.000Z', cause: 'ooo' },
      'Out of office: next email moved from 2026-11-07 to 2026-11-10',
    ],
    ['deactivated', { from: 'follow_up_3_sent', to: 'deactivated' }, 'Deactivated: no reply after the last follow-up'],
    [
      'suppressed',
      { from: 'new', to: 'unsubscribed', reason: 'suppressed' },
      'Not emailed: address already on the do-not-email list; now unsubscribed',
    ],
  ] as const)('%s %j → %s', (kind, data, text) => {
    expect(describeActivity(kind, data)).toBe(text);
  });
});

describe('listActivity on the fixed dataset (D61)', () => {
  it('lists every happening once, newest first, with the contact', async () => {
    const page = await listActivity(pool, {});
    expect(page).toMatchObject({ page: 1, pageSize: 50, total: 15 });
    expect(page.rows.map((r) => [r.kind, r.contactId, r.at.toISOString()])).toEqual([
      ['suppressed', ids.D, '2026-11-04T08:45:00.000Z'],
      ['rescheduled', ids.A, '2026-11-04T08:30:00.000Z'],
      ['deactivated', ids.G, '2026-11-04T08:00:00.000Z'],
      ['sent', ids.E, '2026-11-04T07:00:00.000Z'],
      ['reply', ids.B, '2026-11-03T12:00:00.000Z'],
      ['sent', ids.E, '2026-11-03T06:00:00.000Z'],
      ['sent', ids.G, '2026-11-02T13:00:00.000Z'],
      ['bounced', ids.C, '2026-11-02T10:00:00.000Z'],
      ['unsubscribed', ids.F, '2026-11-02T00:00:00.000Z'],
      ['sent', ids.G, '2026-11-01T13:00:00.000Z'],
      ['sent', ids.B, '2026-11-01T08:00:00.000Z'],
      ['sent', ids.A, '2026-10-31T23:59:59.000Z'],
      ['sent', ids.G, '2026-10-31T13:00:00.000Z'],
      ['sent', ids.G, '2026-10-30T13:00:00.000Z'],
      ['sent', ids.F, '2026-10-30T12:00:00.000Z'],
    ]);
  });

  it('each row carries the name, email and description', async () => {
    const { rows } = await listActivity(pool, { kind: 'deactivated' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: expect.any(Number),
      at: new Date('2026-11-04T08:00:00Z'),
      kind: 'deactivated',
      contactId: ids.G,
      name: 'G Fixture',
      email: 'g@fixture.example',
      description: 'Deactivated: no reply after the last follow-up',
    });
  });

  it('filters by kind', async () => {
    const totals = Object.fromEntries(
      await Promise.all(ACTIVITY_KINDS.map(async (k) => [k, (await listActivity(pool, { kind: k })).total])),
    );
    expect(totals).toEqual({
      sent: 9,
      bounced: 1,
      reply: 1,
      unsubscribed: 1,
      rescheduled: 1,
      deactivated: 1,
      suppressed: 1,
    });
  });

  it('filters by one day', async () => {
    const { rows, total } = await listActivity(pool, { day: '2026-11-02' });
    expect(total).toBe(3);
    expect(rows.map((r) => r.kind)).toEqual(['sent', 'bounced', 'unsubscribed']);
  });

  it('filters by contact search, any case', async () => {
    expect((await listActivity(pool, { q: 'COMPANY g' })).total).toBe(5);
    expect((await listActivity(pool, { q: 'f@fixture' })).rows.map((r) => r.kind)).toEqual(['unsubscribed', 'sent']);
  });

  it('combines filters', async () => {
    expect((await listActivity(pool, { q: 'company g', kind: 'sent', day: '2026-10-31' })).total).toBe(1);
  });

  it('a page past the end is empty but keeps the total', async () => {
    const p = await listActivity(pool, { page: 2 });
    expect(p.rows).toEqual([]);
    expect(p.total).toBe(15);
  });

  it('refuses a bad kind, page or day, and a future day', async () => {
    await expect(listActivity(pool, { kind: 'status_changed' })).rejects.toThrow(BadRequest);
    await expect(listActivity(pool, { page: 0 })).rejects.toThrow(BadRequest);
    await expect(listActivity(pool, { day: '2026-02-30' })).rejects.toThrow(BadRequest);
    await expect(listActivity(pool, { day: '2026-11-05' })).rejects.toThrow(/future/);
  });
});
