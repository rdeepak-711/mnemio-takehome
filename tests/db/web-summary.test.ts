import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { STATUSES, type Status } from '../../src/lifecycle';
import { campaignDays, summaryAt } from '../../src/web/summary';
import { BadRequest } from '../../src/web/errors';
import { FIXTURE_SIM_START as SIM_START, loadWebFixture } from '../helpers/web-fixture';

const pool = getPool(process.env.TEST_DATABASE_URL!);

// All nine statuses, zero unless given.
function statuses(counts: Partial<Record<Status, number>>): Record<Status, number> {
  return Object.fromEntries(STATUSES.map((s) => [s, counts[s] ?? 0])) as Record<Status, number>;
}

beforeAll(async () => {
  await resetDb(pool);
  await loadWebFixture(pool);
});

afterAll(async () => {
  await resetDb(pool);
  await closePool();
});

describe('campaignDays', () => {
  it('runs from the first event day to the sim clock day', async () => {
    expect(await campaignDays(pool, SIM_START)).toEqual({
      first: '2026-10-30',
      today: '2026-11-04',
      simStart: '2026-11-02',
    });
  });
});

describe('summaryAt (status rebuilt from events, D57)', () => {
  it('before anyone existed: all zero, rates over nothing', async () => {
    const s = await summaryAt(pool, '2026-10-29', SIM_START);
    expect(s).toEqual({
      day: '2026-10-29',
      phase: 'history',
      statuses: statuses({}),
      total: 0,
      active: 0,
      deactivated: 0,
      unsubscribed: 0,
      sent: 0,
      replies: 0,
      bounces: 0,
      replyRate: { count: 0, of: 0 },
      bounceRate: { count: 0, of: 0 },
    });
  });

  it('30 Oct: C is not created yet, and A has not moved', async () => {
    const s = await summaryAt(pool, '2026-10-30', SIM_START);
    expect(s.total).toBe(4);
    expect(s.statuses).toEqual(statuses({ new: 2, first_sent: 2 }));
    expect(s.active).toBe(4);
    expect(s.sent).toBe(2);
    expect(s.replyRate).toEqual({ count: 0, of: 2 });
    expect(s.bounceRate).toEqual({ count: 0, of: 2 });
  });

  it('31 Oct: a move at 23:59:59 counts that day, and a contact created at 00:00 is in', async () => {
    const s = await summaryAt(pool, '2026-10-31', SIM_START);
    expect(s.total).toBe(5);
    expect(s.statuses).toEqual(statuses({ new: 2, first_sent: 2, follow_up_1_sent: 1 }));
    expect(s.sent).toBe(4);
    expect(s.replyRate).toEqual({ count: 0, of: 3 });
  });

  it('1 Nov: a move at 00:00 the next day does not count yet; still history', async () => {
    const s = await summaryAt(pool, '2026-11-01', SIM_START);
    expect(s.phase).toBe('history');
    expect(s.total).toBe(6);
    expect(s.statuses).toEqual(statuses({ new: 2, first_sent: 3, follow_up_2_sent: 1 }));
    expect(s.unsubscribed).toBe(0);
    expect(s.replies).toBe(0);
    expect(s.sent).toBe(6);
    expect(s.bounceRate).toEqual({ count: 0, of: 6 });
  });

  it('2 Nov: first simulated day, with a bounce, an unsubscribe and a reply', async () => {
    const s = await summaryAt(pool, '2026-11-02', SIM_START);
    expect(s).toEqual({
      day: '2026-11-02',
      phase: 'simulated',
      statuses: statuses({ new: 1, first_sent: 2, follow_up_3_sent: 1, bounced: 1, unsubscribed: 1 }),
      total: 6,
      active: 4,
      deactivated: 0,
      unsubscribed: 1,
      sent: 8,
      replies: 1,
      bounces: 1,
      replyRate: { count: 1, of: 4 },
      bounceRate: { count: 1, of: 8 },
    });
  });

  it('3 Nov: E appears, B replied', async () => {
    const s = await summaryAt(pool, '2026-11-03', SIM_START);
    expect(s.total).toBe(7);
    expect(s.statuses).toEqual(
      statuses({ new: 1, first_sent: 2, follow_up_3_sent: 1, replied: 1, bounced: 1, unsubscribed: 1 }),
    );
    expect(s.replies).toBe(2);
    expect(s.replyRate).toEqual({ count: 2, of: 5 });
    expect(s.bounceRate).toEqual({ count: 1, of: 9 });
  });

  it("the clock's own day matches contacts.status exactly", async () => {
    const s = await summaryAt(pool, '2026-11-04', SIM_START);
    const { rows } = await pool.query<{ status: Status; n: number }>(
      'SELECT status, count(*)::int AS n FROM contacts GROUP BY status',
    );
    expect(s.statuses).toEqual(statuses(Object.fromEntries(rows.map((r) => [r.status, r.n]))));
    expect(s.total).toBe(7);
    expect(s.active).toBe(3);
    expect(s.deactivated).toBe(1);
    expect(s.sent).toBe(10);
    expect(s.bounceRate).toEqual({ count: 1, of: 10 });
  });

  it('refuses a day after the sim clock', async () => {
    await expect(summaryAt(pool, '2026-11-05', SIM_START)).rejects.toThrow(BadRequest);
    await expect(summaryAt(pool, '2026-11-05', SIM_START)).rejects.toThrow(/future/);
  });
});
