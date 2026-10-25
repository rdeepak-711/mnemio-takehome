import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { loadConfig, type Config } from '../../src/config';
import { getNow } from '../../src/clock';
import { createProvider } from '../../src/mock/provider';
import { createAiClient, type AiClient } from '../../src/ai/client';
import type { Sequence } from '../../src/ai/sequences';
import { checkInvariants } from '../../src/invariants';
import { seed } from '../../src/seed/seed';
import { runTick, advanceDays, type TickDeps } from '../../src/engine/tick';
import { startFakeOpenRouter, okJson, type FakeOpenRouter, type Script } from '../helpers/fake-openrouter';

const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);
// The provider's own pool (D43).
const providerPool = new pg.Pool({ connectionString: url });
const DAY_MS = 24 * 60 * 60 * 1000;

let fake: FakeOpenRouter;

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: url, SEED: '42', CONTACT_COUNT: '500', DELIVERABILITY: 'off', ...overrides });
}

function deps(cfg: Config, ai?: AiClient): TickDeps {
  return { pool, provider: createProvider(providerPool, cfg), config: cfg, ai };
}

// restMs 0: a model that failed is tried again at once, so only the writer decides whether a segment is re-asked.
function fakeAi(): AiClient {
  return createAiClient({
    pool,
    apiKey: 'test-key',
    models: ['vendor/alpha:free'],
    rpm: 60_000,
    dailyBudget: 10_000,
    baseUrl: fake.baseUrl,
    timeoutMs: 2_000,
    restMs: 0,
    sleep: async () => undefined,
    random: () => 0,
  });
}

const AI_SEQUENCE: Sequence = {
  first: {
    subject: 'Follow-ups at {{company}}',
    body: 'Hi {{first_name}},\n\nHow does {{company}} keep track of follow-up emails today?\n\nBest,\nSam',
  },
  follow_up_1: {
    subject: 'Re: Follow-ups at {{company}}',
    body: 'Hi {{first_name}},\n\nBumping my earlier note in case it slipped past.\n\nBest,\nSam',
  },
  follow_up_2: {
    subject: 'Re: Follow-ups at {{company}}',
    body: 'Hi {{first_name}},\n\nOther {{industry}} teams use this to stop replies falling through.\n\nBest,\nSam',
  },
  follow_up_3: {
    subject: 'Last note, {{first_name}}',
    body: 'Hi {{first_name}},\n\nI will leave it here. Reply any time if it becomes useful.\n\nBest,\nSam',
  },
};

// Answers a sequence request with AI_SEQUENCE and a classification request with "interested" for every id.
function workingAi(body: Record<string, unknown>): Script {
  const messages = (body.messages ?? []) as { role: string; content: string }[];
  const user = messages.at(-1)?.content ?? '';
  if (user.startsWith('Label each reply')) {
    const items = JSON.parse(user.split('\n')[1] ?? '[]') as { id: number }[];
    return okJson({ labels: items.map((item) => ({ id: item.id, label: 'interested' })) });
  }
  return okJson(AI_SEQUENCE);
}

async function n(sql: string): Promise<number> {
  return (await pool.query<{ n: number }>(`SELECT (${sql})::int AS n`)).rows[0]!.n;
}

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

describe('runTick', () => {
  it('refuses to run before the database is seeded', async () => {
    await expect(runTick(deps(config()))).rejects.toThrow(/npm run seed/);
  });

  it('handles replies before sends: a reply arriving with a due follow-up stops it', async () => {
    const cfg = config();
    await seed(pool, cfg);
    const { rows } = await pool.query<{ id: number; key: string }>(
      `SELECT c.id, s.idempotency_key AS key FROM contacts c JOIN sends s ON s.contact_id = c.id AND s.step = 'first'
        WHERE c.status = 'first_sent' ORDER BY c.id LIMIT 1`,
    );
    const target = rows[0]!;
    await pool.query('UPDATE contacts SET next_action_at = $2 WHERE id = $1', [target.id, cfg.simStart]);
    await pool.query(
      `INSERT INTO mock_inbox (idempotency_key, body, true_label, deliver_at) VALUES ($1, 'Please remove me from your list.', 'unsubscribe', $2)`,
      [target.key, cfg.simStart],
    );

    await runTick(deps(cfg));

    expect(await n(`SELECT count(*) FROM sends WHERE contact_id = ${target.id} AND step = 'follow_up_1'`)).toBe(0);
    expect(await n(`SELECT count(*) FROM contacts WHERE id = ${target.id} AND status = 'unsubscribed'`)).toBe(1);
  });

  it('a second run at the same time does nothing', async () => {
    const cfg = config();
    await seed(pool, cfg);
    const first = await runTick(deps(cfg));
    expect(first.sent.sent).toBeGreaterThan(0);
    const sendsBefore = await n('SELECT count(*) FROM sends');
    const eventsBefore = await n('SELECT count(*) FROM events');

    const second = await runTick(deps(cfg));
    expect(second.now.getTime()).toBe(first.now.getTime());
    expect(second.delivered).toBe(0);
    expect(second.labelled.processed).toBe(0);
    expect(second.deactivated).toBe(0);
    expect(second.sent).toMatchObject({ sent: 0, bounced: 0, suppressed: 0 });
    expect(await n('SELECT count(*) FROM sends')).toBe(sendsBefore);
    expect(await n('SELECT count(*) FROM events')).toBe(eventsBefore);
  });

  it('two runs in parallel at the same time send each email once', async () => {
    const cfg = config();
    await seed(pool, cfg);
    const sendsBefore = await n('SELECT count(*) FROM sends');
    const [a, b] = await Promise.all([runTick(deps(cfg)), runTick(deps(cfg))]);

    const created = (await n('SELECT count(*) FROM sends')) - sendsBefore;
    expect(created).toBeGreaterThan(0);
    expect(a.sent.sent + a.sent.bounced + b.sent.sent + b.sent.bounced).toBe(created);
    expect(await n('SELECT count(*) FROM (SELECT 1 FROM sends GROUP BY contact_id, step HAVING count(*) > 1) d')).toBe(
      0,
    );
    expect(await checkInvariants(pool)).toEqual([]);
  });
});

describe('advanceDays', () => {
  it('30 days on a 500-contact seed: every contact valid, at most 4 sends, no step twice', async () => {
    const cfg = config();
    await seed(pool, cfg);
    const summaries = await advanceDays(deps(cfg), 30);

    expect(summaries).toHaveLength(30);
    summaries.forEach((s, i) => expect(s.now.getTime()).toBe(cfg.simStart.getTime() + (i + 1) * DAY_MS));
    expect((await getNow(pool)).getTime()).toBe(cfg.simStart.getTime() + 30 * DAY_MS);
    expect(await checkInvariants(pool)).toEqual([]);
    expect(
      await n('SELECT coalesce(max(c), 0) FROM (SELECT count(*) AS c FROM sends GROUP BY contact_id) x'),
    ).toBeLessThanOrEqual(4);
    expect(await n('SELECT count(*) FROM (SELECT 1 FROM sends GROUP BY contact_id, step HAVING count(*) > 1) d')).toBe(
      0,
    );
    expect(summaries.reduce((total, s) => total + s.sent.sent, 0)).toBeGreaterThan(0);
    expect(summaries.reduce((total, s) => total + s.deactivated, 0)).toBeGreaterThan(0);
    expect(summaries.reduce((total, s) => total + s.labelled.processed, 0)).toBeGreaterThan(0);
  });

  it('calls onDay once per day with that day’s summary', async () => {
    const cfg = config({ CONTACT_COUNT: '50' });
    await seed(pool, cfg);
    const seen: Date[] = [];
    const summaries = await advanceDays(deps(cfg), 3, (s) => seen.push(s.now));
    expect(seen).toEqual(summaries.map((s) => s.now));
    expect(seen).toHaveLength(3);
  });

  it('waits for an async onDay before moving the clock again', async () => {
    const cfg = config({ CONTACT_COUNT: '50' });
    await seed(pool, cfg);
    const clockSeen: number[] = [];
    await advanceDays(deps(cfg), 3, async (s) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      clockSeen.push((await getNow(pool)).getTime() - s.now.getTime());
    });
    // 0 each time: the next day's advance had not started while onDay ran.
    expect(clockSeen).toEqual([0, 0, 0]);
  });

  it.each([0, -1, 2.5, 366, Number.NaN])('refuses %s days and leaves the clock alone', async (days) => {
    const cfg = config({ CONTACT_COUNT: '50' });
    await seed(pool, cfg);
    await expect(advanceDays(deps(cfg), days)).rejects.toThrow(/days/);
    expect((await getNow(pool)).getTime()).toBe(cfg.simStart.getTime());
  });

  it('checks the number of days before touching the database', async () => {
    // Not seeded: a database call would fail with "npm run seed" instead.
    await expect(advanceDays(deps(config()), 0)).rejects.toThrow(/days/);
  });
});

describe('with an AI client', () => {
  it('sends AI-written emails and lets the AI label the replies the rules leave', async () => {
    const cfg = config();
    await seed(pool, cfg);
    fake.respond = workingAi;
    await runTick(deps(cfg, fakeAi()));
    await advanceDays(deps(cfg, fakeAi()), 6);

    expect(await n(`SELECT count(*) FROM sends WHERE template_source = 'ai'`)).toBeGreaterThan(0);
    expect(
      await n(
        `SELECT count(*) FROM replies WHERE label_source = 'ai' AND classified_at >= '${cfg.simStart.toISOString()}'`,
      ),
    ).toBeGreaterThan(0);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('an AI that always fails changes nothing but the source: the run finishes on fallbacks', async () => {
    const cfg = config();
    await seed(pool, cfg);
    // No respond and no scripts: every request gets a 500.
    await runTick(deps(cfg, fakeAi()));
    await advanceDays(deps(cfg, fakeAi()), 3);

    expect(fake.seen.length).toBeGreaterThan(0);
    expect(await n(`SELECT count(*) FROM sends WHERE sent_at >= '${cfg.simStart.toISOString()}'`)).toBeGreaterThan(0);
    expect(await n(`SELECT count(*) FROM sends WHERE template_source <> 'fallback'`)).toBe(0);
    expect(
      await n(
        `SELECT count(*) FROM replies WHERE label_source = 'ai' AND classified_at >= '${cfg.simStart.toISOString()}'`,
      ),
    ).toBe(0);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('a new writer each tick: failing on day 1, the AI is asked again on day 2', async () => {
    const cfg = config();
    await seed(pool, cfg);
    const ai = fakeAi(); // one client for the whole run, as the CLI has

    fake.respond = () => ({ status: 500, body: { error: { code: 500 } } });
    await runTick(deps(cfg, ai));
    expect(await n(`SELECT count(*) FROM sends WHERE template_source = 'ai'`)).toBe(0);

    fake.respond = workingAi;
    await advanceDays(deps(cfg, ai), 1);
    expect(await n(`SELECT count(*) FROM sends WHERE template_source = 'ai'`)).toBeGreaterThan(0);
  });
});
