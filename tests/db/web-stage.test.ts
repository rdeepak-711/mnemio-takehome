import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { STATUSES } from '../../src/lifecycle';
import { stageAt } from '../../src/web/stage';
import { summaryAt } from '../../src/web/summary';
import { BadRequest } from '../../src/web/errors';
import { FIXTURE_SIM_START as SIM_START, loadWebFixture, type FixtureIds } from '../helpers/web-fixture';

const pool = getPool(process.env.TEST_DATABASE_URL!);
let ids: FixtureIds;

beforeAll(async () => {
  await resetDb(pool);
  ids = await loadWebFixture(pool);
});

afterAll(async () => {
  await resetDb(pool);
  await closePool();
});

describe('stageAt (D62)', () => {
  it('lists who was in a stage at the end of the day, most recent entry first, with from and reason', async () => {
    const s = await stageAt(pool, '2026-11-02', 'first_sent', {});
    expect(s).toEqual({
      day: '2026-11-02',
      status: 'first_sent',
      page: 1,
      pageSize: 50,
      total: 2,
      rows: [
        {
          id: ids.B,
          name: 'B Fixture',
          email: 'b@fixture.example',
          company: 'Company B',
          since: new Date('2026-11-01T08:00:00Z'),
          from: 'new',
          reason: 'sent',
        },
        {
          id: ids.A,
          name: 'A Fixture',
          email: 'a@fixture.example',
          company: 'Company A',
          since: new Date('2026-10-31T23:59:59Z'),
          from: 'new',
          reason: 'sent',
        },
      ],
    });
  });

  it('a contact still new with no events has no since, from or reason, and comes last by id', async () => {
    const s = await stageAt(pool, '2026-10-30', 'new', {});
    expect(s.rows.map((r) => [r.id, r.since, r.from, r.reason])).toEqual([
      [ids.A, null, null, null],
      [ids.B, null, null, null],
    ]);
  });

  it('says why a contact stopped', async () => {
    const s = await stageAt(pool, '2026-11-04', 'deactivated', {});
    expect(s.rows.map((r) => [r.id, r.from, r.reason])).toEqual([[ids.G, 'follow_up_3_sent', 'deactivate_due']]);
    const u = await stageAt(pool, '2026-11-04', 'unsubscribed', {});
    expect(u.rows.map((r) => [r.id, r.from, r.reason])).toEqual([[ids.F, 'first_sent', 'unsubscribe']]);
  });

  it.each(['2026-10-30', '2026-11-01', '2026-11-02', '2026-11-04'])(
    'on %s every stage total equals the funnel count',
    async (day) => {
      const summary = await summaryAt(pool, day, SIM_START);
      for (const status of STATUSES) {
        const s = await stageAt(pool, day, status, {});
        expect(s.total, status).toBe(summary.statuses[status]);
        expect(s.rows, status).toHaveLength(Math.min(50, summary.statuses[status]));
      }
    },
  );

  it('a page past the end is empty but keeps the total', async () => {
    const s = await stageAt(pool, '2026-11-02', 'first_sent', { page: 2 });
    expect(s.rows).toEqual([]);
    expect(s.total).toBe(2);
  });

  it('refuses a bad status, a bad page and a future day', async () => {
    await expect(stageAt(pool, '2026-11-02', 'nope', {})).rejects.toThrow(BadRequest);
    await expect(stageAt(pool, '2026-11-02', 'new', { page: 0 })).rejects.toThrow(BadRequest);
    await expect(stageAt(pool, '2026-11-05', 'new', {})).rejects.toThrow(/future/);
  });
});
