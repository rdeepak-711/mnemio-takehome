import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { createAiClient, RETRY_DELAYS_MS, type AiClientOptions, type AiRequest } from '../../src/ai/client';
import { createLimiter } from '../../src/ai/limiter';
import { cacheKey } from '../../src/ai/cache';

const pool = getPool(process.env.TEST_DATABASE_URL!);
const A = 'vendor/alpha:free';
const B = 'vendor/beta:free';
const DAY = '2026-10-23';

// ---- A fake OpenRouter: per model, a queue of scripted answers; every request is recorded. ----

type Script = { status: number; content?: string; body?: unknown } | { hang: number }; // never answer within the client's timeout

type Seen = { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };

let server: http.Server;
let baseUrl = '';
let seen: Seen[] = [];
let scripts: Record<string, Script[]> = {};

const ok = (value: unknown): Script => ({ status: 200, content: JSON.stringify(value) });
const okText = (content: string): Script => ({ status: 200, content });
const status = (code: number): Script => ({ status: code, body: { error: { code, message: `status ${code}` } } });

function startServer(): Promise<void> {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push({ path: req.url ?? '', headers: req.headers, body });
      const model = String(body.model);
      const next = scripts[model]?.shift() ?? status(500);
      if ('hang' in next) {
        const timer = setTimeout(() => res.end(), next.hang);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      res.writeHead(next.status, { 'Content-Type': 'application/json' });
      const payload =
        next.content !== undefined
          ? { id: 'x', model, choices: [{ message: { role: 'assistant', content: next.content } }] }
          : next.body;
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

// ---- A fake clock and sleep: sleeping moves the clock, nothing waits for real. ----

let clock = 0;
let sleeps: number[] = [];
const now = () => new Date(clock);
const sleep = async (ms: number) => {
  sleeps.push(ms);
  clock += ms;
};
const retrySleeps = () => sleeps.filter((ms) => ms >= 1000);

function client(overrides: Partial<AiClientOptions> = {}) {
  return createAiClient({
    pool,
    apiKey: 'test-key',
    models: [A, B],
    rpm: 60_000, // 1 ms spacing: out of the way unless a test is about spacing
    dailyBudget: 50,
    baseUrl,
    timeoutMs: 2_000,
    sleep,
    now,
    random: () => 0,
    ...overrides,
  });
}

const Labels = z.object({ labels: z.array(z.object({ id: z.number(), label: z.string() })) });
const ANSWER = { labels: [{ id: 1, label: 'interested' }] };

function request(input = 'sounds good', promptVersion = 'v1'): AiRequest<z.infer<typeof Labels>> {
  return {
    kind: 'classification',
    promptVersion,
    input,
    messages: [{ role: 'user', content: `classify: ${input}` }],
    schema: Labels,
  };
}

const requestsTo = (model: string) => seen.filter((s) => s.body.model === model).length;
async function usage(day = DAY): Promise<number> {
  const { rows } = await pool.query<{ calls: number }>('SELECT calls FROM llm_usage WHERE day = $1', [day]);
  return rows[0]?.calls ?? 0;
}

beforeEach(async () => {
  await resetDb(pool);
  if (!server) await startServer();
  seen = [];
  scripts = {};
  clock = Date.parse(`${DAY}T10:00:00Z`);
  sleeps = [];
});

afterEach(() => {
  server.closeAllConnections();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

describe('a successful call', () => {
  it('returns the parsed value, sends the right request, counts one call and saves the answer', async () => {
    scripts[A] = [ok(ANSWER)];
    const result = await client().complete(request());
    expect(result).toEqual({ value: ANSWER, model: A, source: 'ai' });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('/chat/completions');
    expect(seen[0]!.headers.authorization).toBe('Bearer test-key');
    expect(seen[0]!.body).toMatchObject({
      model: A,
      temperature: 0,
      messages: [{ role: 'user', content: 'classify: sounds good' }],
    });
    // JSON is asked for in the prompt, not through JSON mode, which not every free model supports.
    expect(seen[0]!.body).not.toHaveProperty('response_format');

    expect(await usage()).toBe(1);
    const { rows } = await pool.query('SELECT key, kind, response, model FROM llm_cache');
    expect(rows).toEqual([
      { key: cacheKey('classification', 'v1', 'sounds good'), kind: 'classification', response: ANSWER, model: A },
    ]);
  });

  it('accepts an answer wrapped in a ```json code fence', async () => {
    scripts[A] = [okText('```json\n' + JSON.stringify(ANSWER) + '\n```')];
    expect(await client().complete(request())).toEqual({ value: ANSWER, model: A, source: 'ai' });
  });
});

describe('the cache', () => {
  it('a repeated request is answered from the cache: no HTTP call, no budget used', async () => {
    scripts[A] = [ok(ANSWER)];
    await client().complete(request());
    const again = await client().complete(request());
    expect(again).toEqual({ value: ANSWER, model: A, source: 'cache' });
    expect(seen).toHaveLength(1);
    expect(await usage()).toBe(1);
  });

  it('an answer saved from one model is found when another model is first in the list', async () => {
    scripts[A] = [ok(ANSWER)];
    await client({ models: [A, B] }).complete(request());
    const again = await client({ models: [B, A] }).complete(request());
    expect(again).toEqual({ value: ANSWER, model: A, source: 'cache' });
    expect(seen).toHaveLength(1);
  });

  it('a new prompt version is a cache miss', async () => {
    scripts[A] = [ok(ANSWER), ok(ANSWER)];
    await client().complete(request('sounds good', 'v1'));
    expect((await client().complete(request('sounds good', 'v2')))?.source).toBe('ai');
    expect(seen).toHaveLength(2);
  });

  it('a cached answer that no longer fits the schema is ignored and asked again', async () => {
    await pool.query(`INSERT INTO llm_cache (key, kind, response, model) VALUES ($1, 'classification', $2, $3)`, [
      cacheKey('classification', 'v1', 'sounds good'),
      JSON.stringify({ wrong: true }),
      A,
    ]);
    scripts[A] = [ok(ANSWER)];
    expect(await client().complete(request())).toEqual({ value: ANSWER, model: A, source: 'ai' });
    expect(seen).toHaveLength(1);
  });
});

describe('retries and the next model', () => {
  it('429 then success: retried on the same model after 2 s; the failed try is not counted', async () => {
    scripts[A] = [status(429), ok(ANSWER)];
    expect(await client().complete(request())).toEqual({ value: ANSWER, model: A, source: 'ai' });
    expect(requestsTo(A)).toBe(2);
    expect(retrySleeps()).toEqual([RETRY_DELAYS_MS[0]]);
    expect(RETRY_DELAYS_MS).toEqual([2000, 4000]);
    expect(await usage()).toBe(1);
  });

  it('jitter adds up to 500 ms to each retry wait', async () => {
    scripts[A] = [status(503), status(503), ok(ANSWER)];
    await client({ random: () => 0.999 }).complete(request());
    expect(retrySleeps()).toHaveLength(2);
    expect(retrySleeps()[0]).toBeGreaterThanOrEqual(2000);
    expect(retrySleeps()[0]).toBeLessThan(2500);
    expect(retrySleeps()[1]).toBeGreaterThanOrEqual(4000);
    expect(retrySleeps()[1]).toBeLessThan(4500);
  });

  it('three 5xx on the first model (2 s, 4 s waits), then the next model answers', async () => {
    scripts[A] = [status(500), status(502), status(503)];
    scripts[B] = [ok(ANSWER)];
    expect(await client().complete(request())).toEqual({ value: ANSWER, model: B, source: 'ai' });
    expect(requestsTo(A)).toBe(3);
    expect(requestsTo(B)).toBe(1);
    expect(retrySleeps()).toEqual([2000, 4000]);
    expect(await usage()).toBe(1);
  });

  it('a timeout counts as a failure and is retried, then the next model', async () => {
    scripts[A] = [{ hang: 1_000 }, { hang: 1_000 }, { hang: 1_000 }];
    scripts[B] = [ok(ANSWER)];
    const result = await client({ timeoutMs: 100 }).complete(request());
    expect(result).toEqual({ value: ANSWER, model: B, source: 'ai' });
    expect(requestsTo(A)).toBe(3);
  });

  it.each([400, 404])('a %s (dead or refused model) goes straight to the next model, no retry', async (code) => {
    scripts[A] = [status(code)];
    scripts[B] = [ok(ANSWER)];
    expect(await client().complete(request())).toEqual({ value: ANSWER, model: B, source: 'ai' });
    expect(requestsTo(A)).toBe(1);
    expect(retrySleeps()).toEqual([]);
  });

  it.each([401, 403])('a %s (bad key) gives up at once: every model would fail the same way', async (code) => {
    scripts[A] = [status(code)];
    scripts[B] = [ok(ANSWER)];
    expect(await client().complete(request())).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('invalid JSON is a failure of that model: no retry, next model; both answers counted', async () => {
    scripts[A] = [okText('Sure! Here are the labels: interested')];
    scripts[B] = [ok(ANSWER)];
    expect(await client().complete(request())).toEqual({ value: ANSWER, model: B, source: 'ai' });
    expect(requestsTo(A)).toBe(1);
    expect(await usage()).toBe(2);
  });

  it('valid JSON of the wrong shape is a failure of that model, next model', async () => {
    scripts[A] = [ok({ labels: 'interested' })];
    scripts[B] = [ok(ANSWER)];
    expect(await client().complete(request())).toEqual({ value: ANSWER, model: B, source: 'ai' });
    expect(requestsTo(A)).toBe(1);
  });

  it('a 200 with no choices is a failure, next model', async () => {
    scripts[A] = [{ status: 200, body: { error: { message: 'upstream error' } } }];
    scripts[B] = [ok(ANSWER)];
    expect((await client().complete(request()))?.model).toBe(B);
  });

  it('every model failing returns null (the caller falls back); nothing counted, nothing cached', async () => {
    scripts[A] = [status(500), status(500), status(500)];
    scripts[B] = [status(404)];
    expect(await client().complete(request())).toBeNull();
    expect(await usage()).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM llm_cache')).rows[0]).toEqual({ n: 0 });
  });
});

describe('a model that just failed is skipped for a while', () => {
  it('after a model fails, the next request goes straight to the next model, until 5 minutes pass', async () => {
    scripts[A] = [status(404)];
    scripts[B] = [ok(ANSWER), ok(ANSWER), ok(ANSWER)];
    const ai = client();
    await ai.complete(request('one'));
    await ai.complete(request('two'));
    expect(requestsTo(A)).toBe(1);

    clock += 5 * 60 * 1000 + 1;
    scripts[A] = [ok(ANSWER)];
    expect((await ai.complete(request('three')))?.model).toBe(A);
    expect(requestsTo(A)).toBe(2);
  });

  it('when every model is resting, null without any HTTP call', async () => {
    scripts[A] = [status(404)];
    scripts[B] = [status(404)];
    const ai = client();
    await ai.complete(request('one'));
    const before = seen.length;
    expect(await ai.complete(request('two'))).toBeNull();
    expect(seen.length).toBe(before);
  });
});

describe('the daily budget', () => {
  it('with the budget used up, no HTTP call is made and the result is null', async () => {
    await pool.query('INSERT INTO llm_usage (day, calls) VALUES ($1, 2)', [DAY]);
    scripts[A] = [ok(ANSWER)];
    expect(await client({ dailyBudget: 2 }).complete(request())).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it('a budget of 0 never calls', async () => {
    scripts[A] = [ok(ANSWER)];
    expect(await client({ dailyBudget: 0 }).complete(request())).toBeNull();
    expect(seen).toHaveLength(0);
    expect(await usage()).toBe(0);
  });

  it('5 calls at once with a budget of 3: exactly 3 go out', async () => {
    scripts[A] = Array.from({ length: 5 }, () => ok(ANSWER));
    const ai = client({ dailyBudget: 3 });
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((x) => ai.complete(request(x))));
    expect(results.filter((r) => r !== null)).toHaveLength(3);
    expect(seen).toHaveLength(3);
    expect(await usage()).toBe(3);
  });

  it('the count is kept per UTC day', async () => {
    clock = Date.parse('2026-10-23T23:59:00Z');
    scripts[A] = [ok(ANSWER), ok(ANSWER)];
    const ai = client();
    await ai.complete(request('late'));
    clock = Date.parse('2026-10-24T00:01:00Z');
    await ai.complete(request('early'));
    expect(await usage('2026-10-23')).toBe(1);
    expect(await usage('2026-10-24')).toBe(1);
  });
});

describe('no key, no models, paid models', () => {
  it('with no API key: null, no HTTP call', async () => {
    scripts[A] = [ok(ANSWER)];
    expect(await client({ apiKey: null }).complete(request())).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it('with no models: null, no HTTP call', async () => {
    expect(await client({ models: [] }).complete(request())).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it('a cached answer is still used with no key', async () => {
    scripts[A] = [ok(ANSWER)];
    await client().complete(request());
    expect(await client({ apiKey: null }).complete(request())).toEqual({ value: ANSWER, model: A, source: 'cache' });
  });

  it('a model without ":free" is refused when the client is created', () => {
    expect(() => client({ models: [A, 'vendor/paid-model'] })).toThrow(/:free/);
  });
});

describe('createLimiter', () => {
  it('spaces calls at least 60 / rpm seconds apart (rpm 20 → 3 s)', async () => {
    const limiter = createLimiter(pool, { rpm: 20, dailyBudget: 50, now, sleep });
    for (let i = 0; i < 3; i += 1) expect(await limiter.acquire()).not.toBeNull();
    expect(sleeps).toEqual([3000, 3000]);
  });

  it('does not wait when enough time has already passed', async () => {
    const limiter = createLimiter(pool, { rpm: 20, dailyBudget: 50, now, sleep });
    await limiter.acquire();
    clock += 10_000;
    await limiter.acquire();
    expect(sleeps).toEqual([]);
  });

  it('release gives the slot back, and the count never goes below 0', async () => {
    const limiter = createLimiter(pool, { rpm: 60_000, dailyBudget: 1, now, sleep });
    const slot = await limiter.acquire();
    expect(await limiter.acquire()).toBeNull();
    await slot!.release();
    expect(await usage()).toBe(0);
    await slot!.release();
    expect(await usage()).toBe(0);
    expect(await limiter.acquire()).not.toBeNull();
    expect(await limiter.usedToday()).toBe(1);
  });

  it('release after midnight refunds the day the slot was taken from', async () => {
    clock = Date.parse('2026-10-23T23:59:59Z');
    const limiter = createLimiter(pool, { rpm: 60_000, dailyBudget: 5, now, sleep });
    const slot = await limiter.acquire();
    clock = Date.parse('2026-10-24T00:00:05Z');
    await limiter.acquire();
    await slot!.release();
    expect(await usage('2026-10-23')).toBe(0);
    expect(await usage('2026-10-24')).toBe(1);
  });
});
