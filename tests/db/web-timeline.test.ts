import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { setNow } from '../../src/clock';
import { timeline } from '../../src/web/timeline';
import { FIXTURE_SIM_START as SIM_START, loadWebFixture } from '../helpers/web-fixture';

const pool = getPool(process.env.TEST_DATABASE_URL!);

const zero = {
  firstEmails: 0,
  followUps: 0,
  replies: 0,
  bounces: 0,
  unsubscribes: 0,
  deactivated: 0,
  entered: 0,
  left: 0,
};

afterAll(async () => {
  await resetDb(pool);
  await closePool();
});

describe('timeline on the fixed dataset', () => {
  beforeAll(async () => {
    await resetDb(pool);
    await loadWebFixture(pool);
  });

  it('has one entry per day from the first event to the clock, with the numbers worked out by hand', async () => {
    expect(await timeline(pool, SIM_START)).toEqual([
      { ...zero, day: '2026-10-30', phase: 'history', firstEmails: 2, entered: 2 },
      { ...zero, day: '2026-10-31', phase: 'history', firstEmails: 1, followUps: 1, entered: 1 },
      { ...zero, day: '2026-11-01', phase: 'history', firstEmails: 1, followUps: 1, entered: 1 },
      {
        ...zero,
        day: '2026-11-02',
        phase: 'simulated',
        firstEmails: 1, // C's, which bounced: a bounced send is still a send
        followUps: 1,
        replies: 1,
        bounces: 1,
        unsubscribes: 1,
        entered: 1,
        left: 2,
      },
      { ...zero, day: '2026-11-03', phase: 'simulated', firstEmails: 1, replies: 1, entered: 1, left: 1 },
      { ...zero, day: '2026-11-04', phase: 'simulated', followUps: 1, deactivated: 1, left: 1 },
    ]);
  });
});

describe('timeline gaps', () => {
  beforeAll(async () => {
    await resetDb(pool);
    await loadWebFixture(pool);
    // Two quiet days after the last activity.
    await setNow(pool, new Date('2026-11-06T09:00:00Z'));
  });

  it('fills days with no activity with zeros', async () => {
    const days = await timeline(pool, SIM_START);
    expect(days.map((d) => d.day).slice(-3)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
    expect(days.at(-1)).toEqual({ ...zero, day: '2026-11-06', phase: 'simulated' });
    expect(days.at(-2)).toEqual({ ...zero, day: '2026-11-05', phase: 'simulated' });
  });
});

describe('timeline with no events', () => {
  beforeAll(async () => {
    await resetDb(pool);
    await setNow(pool, new Date('2026-11-02T09:00:00Z'));
  });

  it('is just the clock day, all zero', async () => {
    expect(await timeline(pool, SIM_START)).toEqual([{ ...zero, day: '2026-11-02', phase: 'simulated' }]);
  });
});
