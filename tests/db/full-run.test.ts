import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { loadConfig, type Config } from '../../src/config';
import { createProvider } from '../../src/mock/provider';
import { createAiClient, type AiClient } from '../../src/ai/client';
import type { Sequence } from '../../src/ai/sequences';
import { fullRun, formatFullRun, DEFAULT_MAX_DAYS, type FullRunResult } from '../../src/full-run';
import type { TickDeps } from '../../src/engine/tick';
import type { Report } from '../../src/report';
import { startFakeOpenRouter, okJson, type FakeOpenRouter } from '../helpers/fake-openrouter';

const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);
const providerPool = new pg.Pool({ connectionString: url });
let fake: FakeOpenRouter;

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: url, SEED: '42', CONTACT_COUNT: '300', ...overrides });
}

function deps(cfg: Config, ai?: AiClient): TickDeps {
  return { pool, provider: createProvider(providerPool, cfg), config: cfg, ai };
}

const SEQUENCE: Sequence = {
  first: {
    subject: 'Follow-ups at {{company}}',
    body: 'Hi {{first_name}},\n\nHow do you track follow-ups?\n\nBest,\nSam',
  },
  follow_up_1: { subject: 'Re: follow-ups', body: 'Hi {{first_name}},\n\nBumping my earlier email.\n\nBest,\nSam' },
  follow_up_2: {
    subject: 'Re: follow-ups',
    body: 'Hi {{first_name}},\n\nOne more useful point on my earlier email.\n\nBest,\nSam',
  },
  follow_up_3: { subject: 'Last note', body: 'Hi {{first_name}},\n\nI will leave it here.\n\nBest,\nSam' },
};

beforeAll(async () => {
  fake = await startFakeOpenRouter();
});

beforeEach(async () => {
  fake.reset();
  await resetDb(pool);
});

afterAll(async () => {
  await resetDb(pool);
  await fake.close();
  await providerPool.end();
  await closePool();
});

describe('fullRun', () => {
  it('300 contacts with no AI: finishes, no violations, nobody in sequence, no orphans', async () => {
    const cfg = config();
    const r = await fullRun(deps(cfg));

    expect(r.finished).toBe(true);
    expect(r.days).toBeGreaterThan(0);
    expect(r.days).toBeLessThanOrEqual(DEFAULT_MAX_DAYS);
    expect(r.violations).toEqual([]);
    expect(r.report.inSequence).toBe(0);
    expect(r.report.orphaned).toBe(0);
    expect(Object.values(r.report.statuses).reduce((a, b) => a + b, 0)).toBe(300);
    for (const phase of ['reset', 'seed', 'warm', 'advance', 'check', 'report'] as const) {
      expect(r.timings[phase]).toBeGreaterThanOrEqual(0);
      expect(r.timings.total).toBeGreaterThanOrEqual(r.timings[phase]);
    }
  });

  it('stops at maxDays with people still in sequence', async () => {
    const r = await fullRun(deps(config()), { maxDays: 2 });
    expect(r.days).toBe(2);
    expect(r.finished).toBe(false);
    expect(r.report.inSequence).toBeGreaterThan(0);
  });

  it('calls onDay once per day advanced', async () => {
    let calls = 0;
    const r = await fullRun(deps(config({ CONTACT_COUNT: '50' })), { maxDays: 3, onDay: () => (calls += 1) });
    expect(calls).toBe(r.days);
  });

  it('keeps a saved AI answer through its reset', async () => {
    await pool.query(
      `INSERT INTO ai.llm_cache (key, kind, response, model) VALUES ('kept', 'sequence', '{}', 'm:free')`,
    );
    await fullRun(deps(config({ CONTACT_COUNT: '50' })), { maxDays: 1 });
    expect((await pool.query(`SELECT 1 FROM ai.llm_cache WHERE key = 'kept'`)).rowCount).toBe(1);
  });

  it('the same seed run twice gives the same outcome', async () => {
    const pick = (r: Report) => ({ statuses: r.statuses, replyRate: r.replyRate, bounceRate: r.bounceRate });
    const a = await fullRun(deps(config({ CONTACT_COUNT: '200' })));
    const b = await fullRun(deps(config({ CONTACT_COUNT: '200' })));
    expect(pick(b.report)).toEqual(pick(a.report));
    expect(b.days).toBe(a.days);
  });

  it('with a working AI, the warm phase writes the 20 sequences and the emails come from the cache', async () => {
    fake.respond = () => okJson(SEQUENCE);
    const ai = createAiClient({
      pool,
      apiKey: 'test-key',
      models: ['vendor/alpha:free'],
      rpm: 60_000,
      dailyBudget: 10_000,
      baseUrl: fake.baseUrl,
      timeoutMs: 2_000,
      sleep: async () => undefined,
      random: () => 0,
    });
    const r = await fullRun(deps(config(), ai), { maxDays: 3 });
    expect(fake.seen.filter((s) => JSON.stringify(s.body).includes('four-email sequence'))).toHaveLength(20);
    expect(r.report.templateSources.cache).toBeGreaterThan(0);
    expect(r.report.templateSources.ai).toBe(0);
  });

  it.each([0, -1, 2.5, 366])('refuses maxDays %s before touching the database', async (maxDays) => {
    await pool.query(`INSERT INTO ai.llm_cache (key, kind, response, model) VALUES ('x', 'sequence', '{}', 'm:free')`);
    await pool.query(`INSERT INTO sim_clock (id, now) VALUES (1, '2030-01-01T00:00:00Z')`);
    await expect(fullRun(deps(config()), { maxDays })).rejects.toThrow(/maxDays/);
    // Still the hand-set clock: no reset or seed ran.
    expect((await pool.query(`SELECT 1 FROM sim_clock WHERE now = '2030-01-01T00:00:00Z'`)).rowCount).toBe(1);
  });
});

function result(overrides: Partial<FullRunResult>, inSequence = 0): FullRunResult {
  return {
    days: 31,
    finished: true,
    timings: { reset: 120, seed: 1234, warm: 0, advance: 62_800, check: 420, report: 95, total: 64_640 },
    violations: [],
    report: { inSequence } as Report,
    ...overrides,
  };
}

describe('formatFullRun', () => {
  it('prints the timings and a finished run', () => {
    expect(formatFullRun(result({}))).toBe(
      [
        'timings: reset 0.1 s · seed 1.2 s · warm 0.0 s · advance 62.8 s · check 0.4 s · report 0.1 s · total 64.6 s',
        'days: 31 (finished: nobody left in sequence)',
      ].join('\n'),
    );
  });

  it('says when it stopped at the limit', () => {
    const text = formatFullRun(result({ days: 60, finished: false }, 12));
    expect(text.split('\n')[1]).toBe('days: 60 (stopped at the limit: 12 still in sequence)');
  });
});
