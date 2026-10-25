import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { getNow, setNow, advance, advanceHours } from '../../src/clock';

const pool = getPool(process.env.TEST_DATABASE_URL!);
const at = (iso: string) => new Date(iso);

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await closePool();
});

describe('getNow / setNow', () => {
  it('getNow before the clock is set throws, pointing at the seed', async () => {
    await expect(getNow(pool)).rejects.toThrow(/sim_clock.*not set.*seed/i);
  });

  it('setNow then getNow returns the same instant, to the millisecond', async () => {
    await setNow(pool, at('2026-11-02T09:00:00.123Z'));
    expect((await getNow(pool)).toISOString()).toBe('2026-11-02T09:00:00.123Z');
  });

  it('setNow twice keeps one row with the second value', async () => {
    await setNow(pool, at('2026-11-02T09:00:00Z'));
    await setNow(pool, at('2026-11-05T09:00:00Z'));
    const { rows } = await pool.query('SELECT id, now FROM sim_clock');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect((await getNow(pool)).toISOString()).toBe('2026-11-05T09:00:00.000Z');
  });

  it('stores and returns UTC whatever the session timezone is', async () => {
    const client = await pool.connect();
    try {
      await client.query("SET TIME ZONE 'Asia/Kolkata'");
      await setNow(client, at('2026-11-02T09:00:00Z'));
      expect((await getNow(client)).toISOString()).toBe('2026-11-02T09:00:00.000Z');
    } finally {
      await client.query('RESET TIME ZONE');
      client.release();
    }
    expect((await getNow(pool)).toISOString()).toBe('2026-11-02T09:00:00.000Z');
  });
});

describe('advance', () => {
  it('advance(1) moves exactly 24 hours, returns the new now, and getNow agrees', async () => {
    await setNow(pool, at('2026-11-02T09:00:00Z'));
    const next = await advance(pool, 1);
    expect(next.toISOString()).toBe('2026-11-03T09:00:00.000Z');
    expect((await getNow(pool)).toISOString()).toBe('2026-11-03T09:00:00.000Z');
  });

  it('crosses a month end', async () => {
    await setNow(pool, at('2026-11-28T09:00:00Z'));
    expect((await advance(pool, 7)).toISOString()).toBe('2026-12-05T09:00:00.000Z');
  });

  it('crosses a year end', async () => {
    await setNow(pool, at('2026-12-29T09:00:00Z'));
    expect((await advance(pool, 7)).toISOString()).toBe('2027-01-05T09:00:00.000Z');
  });

  it.each([0, -1, 1.5, Number.NaN])('advance(%s) throws naming days and does not move the clock', async (days) => {
    await setNow(pool, at('2026-11-02T09:00:00Z'));
    await expect(advance(pool, days)).rejects.toThrow(/days/);
    expect((await getNow(pool)).toISOString()).toBe('2026-11-02T09:00:00.000Z');
  });

  it('advance before the clock is set throws the "not set" error', async () => {
    await expect(advance(pool, 1)).rejects.toThrow(/sim_clock.*not set.*seed/i);
  });

  it('ten advance(1) calls at the same time move the clock exactly 10 days (no lost update)', async () => {
    await setNow(pool, at('2026-11-02T09:00:00Z'));
    await Promise.all(Array.from({ length: 10 }, () => advance(pool, 1)));
    expect((await getNow(pool)).toISOString()).toBe('2026-11-12T09:00:00.000Z');
  });
});

describe('inside a transaction', () => {
  it('setNow on a client is undone by ROLLBACK', async () => {
    await setNow(pool, at('2026-11-02T09:00:00Z'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setNow(client, at('2026-12-25T09:00:00Z'));
      expect((await getNow(client)).toISOString()).toBe('2026-12-25T09:00:00.000Z');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await getNow(pool)).toISOString()).toBe('2026-11-02T09:00:00.000Z');
  });
});

// T22 (D65): hourly ticks.
describe('advanceHours', () => {
  it('advanceHours(1) moves exactly one hour and returns the new now', async () => {
    await setNow(pool, at('2026-11-02T09:00:00Z'));
    expect((await advanceHours(pool, 1)).toISOString()).toBe('2026-11-02T10:00:00.000Z');
    expect((await getNow(pool)).toISOString()).toBe('2026-11-02T10:00:00.000Z');
  });

  it('24 hours across the US daylight-saving change is exactly one UTC day', async () => {
    await setNow(pool, at('2026-10-31T09:00:00Z'));
    expect((await advanceHours(pool, 24)).toISOString()).toBe('2026-11-01T09:00:00.000Z');
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'advanceHours(%s) throws naming hours and does not move the clock',
    async (hours) => {
      await setNow(pool, at('2026-11-02T09:00:00Z'));
      await expect(advanceHours(pool, hours)).rejects.toThrow(/hours/);
      expect((await getNow(pool)).toISOString()).toBe('2026-11-02T09:00:00.000Z');
    },
  );

  it('advanceHours before the clock is set throws the "not set" error', async () => {
    await expect(advanceHours(pool, 1)).rejects.toThrow(/sim_clock.*not set.*seed/i);
  });
});
