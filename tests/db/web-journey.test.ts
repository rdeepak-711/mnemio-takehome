import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { movesOn } from '../../src/web/journey';
import { BadRequest } from '../../src/web/errors';
import { loadWebFixture, type FixtureIds } from '../helpers/web-fixture';

const pool = getPool(process.env.TEST_DATABASE_URL!);
let ids: FixtureIds;

beforeAll(async () => {
  await resetDb(pool);
  ids = await loadWebFixture(pool);
  // Journey-only extras on 3 Nov: two more first_sent→replied moves, so the larger group sorts first even though
  // its `from` comes after `new` in STATUSES.
  for (const id of [ids.A, ids.D]) {
    await pool.query(
      `INSERT INTO events (contact_id, type, data, occurred_at)
       VALUES ($1, 'status_changed', '{"from":"first_sent","to":"replied","reason":"extra"}', '2026-11-03T15:00:00Z')`,
      [id],
    );
  }
});

afterAll(async () => {
  await resetDb(pool);
  await closePool();
});

describe('movesOn', () => {
  it('groups the status changes of that day by from → to', async () => {
    expect(await movesOn(pool, '2026-10-30')).toEqual([{ from: 'new', to: 'first_sent', count: 2 }]);
  });

  it('sorts equal counts by from, then to, in STATUSES order', async () => {
    expect(await movesOn(pool, '2026-11-02')).toEqual([
      { from: 'new', to: 'bounced', count: 1 },
      { from: 'first_sent', to: 'unsubscribed', count: 1 },
      { from: 'follow_up_2_sent', to: 'follow_up_3_sent', count: 1 },
    ]);
  });

  it('puts the largest group first', async () => {
    expect(await movesOn(pool, '2026-11-03')).toEqual([
      { from: 'first_sent', to: 'replied', count: 3 },
      { from: 'new', to: 'first_sent', count: 1 },
    ]);
  });

  it('ignores sent and reply_received events, and is empty on a quiet day', async () => {
    expect(await movesOn(pool, '2026-10-29')).toEqual([]);
  });

  it('refuses a day after the sim clock', async () => {
    await expect(movesOn(pool, '2026-11-05')).rejects.toThrow(BadRequest);
  });
});
