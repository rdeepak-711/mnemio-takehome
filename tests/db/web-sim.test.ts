import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { loadConfig, type Config } from '../../src/config';
import { getNow } from '../../src/clock';
import { createProvider } from '../../src/mock/provider';
import { seed } from '../../src/seed/seed';
import type { TickDeps } from '../../src/engine/tick';
import { simAdvance, simReset } from '../../src/web/sim';
import { BadRequest, SimBusy } from '../../src/web/errors';

const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);
const providerPool = new pg.Pool({ connectionString: url });
const DAY_MS = 24 * 60 * 60 * 1000;

// No API key: every sequence and label uses the fallback, so no network is touched.
const config: Config = loadConfig({ DATABASE_URL: url, SEED: '42', CONTACT_COUNT: '200' });
const deps: TickDeps = { pool, provider: createProvider(providerPool, config), config, ai: null };

async function n(sql: string): Promise<number> {
  return (await pool.query<{ n: number }>(`SELECT (${sql})::int AS n`)).rows[0]!.n;
}

beforeEach(async () => {
  await resetDb(pool);
  await seed(pool, config);
});

afterAll(async () => {
  await resetDb(pool);
  await closePool();
  await providerPool.end();
});

describe('simAdvance', () => {
  it('moves the clock exactly N days and returns each day plus the invariant check', async () => {
    const before = await getNow(pool);
    const result = await simAdvance(deps, 2);
    expect((await getNow(pool)).getTime() - before.getTime()).toBe(2 * DAY_MS);
    expect(result.days).toHaveLength(2);
    expect(result.days[1]!.now).toEqual(await getNow(pool));
    expect(result.violations).toEqual([]);
  });

  it.each([0, -1, 1.5, 366, Number.NaN])('refuses %s days before the clock moves', async (days) => {
    const before = await getNow(pool);
    await expect(simAdvance(deps, days)).rejects.toThrow(BadRequest);
    expect(await getNow(pool)).toEqual(before);
  });
});

describe('the one-at-a-time lock (D58)', () => {
  it('a second call while one runs is refused at once and changes nothing', async () => {
    const before = await getNow(pool);
    const first = simAdvance(deps, 1);
    await expect(simAdvance(deps, 1)).rejects.toThrow(SimBusy);
    await expect(simReset(pool, config)).rejects.toThrow(SimBusy);
    await first;
    expect((await getNow(pool)).getTime() - before.getTime()).toBe(DAY_MS);
  });

  it('is released after a call fails', async () => {
    const broken = { ...deps, pool: { query: () => Promise.reject(new Error('boom')) } as unknown as pg.Pool };
    await expect(simAdvance(broken, 1)).rejects.toThrow('boom');
    await expect(simAdvance(deps, 1)).resolves.toMatchObject({ days: [expect.anything()] });
  });

  it('is released after a call succeeds', async () => {
    await simAdvance(deps, 1);
    await expect(simReset(pool, config)).resolves.toEqual({ contacts: 200 });
  });
});

describe('simReset', () => {
  it('wipes the run, keeps saved AI answers, and seeds CONTACT_COUNT contacts at SIM_START', async () => {
    await pool.query(
      `INSERT INTO ai.llm_cache (key, kind, response, model) VALUES ('kept', 'sequence', '{"a":1}', 'vendor/alpha:free')`,
    );
    await simAdvance(deps, 3);
    expect(await n('SELECT count(*) FROM sends')).toBeGreaterThan(0);
    expect(await simReset(pool, config)).toEqual({ contacts: 200 });
    expect(await n('SELECT count(*) FROM contacts')).toBe(200);
    expect(await getNow(pool)).toEqual(config.simStart);
    expect(await n(`SELECT count(*) FROM ai.llm_cache WHERE key = 'kept'`)).toBe(1);
  });
});
