import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { createAiClient, type AiClient } from '../../src/ai/client';
import type { Sequence } from '../../src/ai/sequences';
import { allSegments } from '../../src/segments';
import { warmSequences } from '../../src/ai/warm';
import { startFakeOpenRouter, okJson, type FakeOpenRouter } from '../helpers/fake-openrouter';

const pool = getPool(process.env.TEST_DATABASE_URL!);
let fake: FakeOpenRouter;

function ai(): AiClient {
  return createAiClient({
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
  await closePool();
});

describe('warmSequences', () => {
  it('asks once per segment, in allSegments() order, and reports each as ai', async () => {
    fake.respond = () => okJson(SEQUENCE);
    const results = await warmSequences(ai());
    expect(results).toEqual(allSegments().map((segment) => ({ segment, source: 'ai' })));
    expect(results).toHaveLength(20);
    expect(fake.seen).toHaveLength(20);
  });

  it('a second warm, even with a new client, reads all 20 from the cache with no call', async () => {
    fake.respond = () => okJson(SEQUENCE);
    await warmSequences(ai());
    const calls = fake.seen.length;

    const again = await warmSequences(ai());
    expect(again.map((r) => r.source)).toEqual(Array(20).fill('cache'));
    expect(fake.seen).toHaveLength(calls);
  });

  it('with no good answer, every segment is reported as fallback and nothing throws', async () => {
    const results = await warmSequences(ai());
    expect(results.map((r) => r.source)).toEqual(Array(20).fill('fallback'));
  });
});
