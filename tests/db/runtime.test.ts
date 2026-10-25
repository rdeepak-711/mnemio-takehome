import { describe, it, expect, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { openRuntime } from '../../src/runtime';

const url = process.env.TEST_DATABASE_URL!;
const ENV = { DATABASE_URL: url, SEED: '7', CONTACT_COUNT: '123', OPENROUTER_API_KEY: '' };

afterAll(async () => {
  await closePool();
});

describe('openRuntime', () => {
  it('builds config, the shared pool, a separate provider pool, the provider and the AI client from env', async () => {
    const rt = openRuntime(ENV);
    try {
      expect(rt.config.databaseUrl).toBe(url);
      expect(rt.config.contactCount).toBe(123);
      expect(rt.config.openrouterApiKey).toBeNull();
      expect(rt.pool).toBe(getPool(url));
      expect(rt.providerPool).not.toBe(rt.pool); // D43
      expect(typeof rt.provider.send).toBe('function');
      expect(typeof rt.ai.complete).toBe('function');
      const { rows } = await rt.pool.query<{ one: number }>('SELECT 1 AS one');
      expect(rows[0]!.one).toBe(1);
      await rt.providerPool.query('SELECT 1');
    } finally {
      await rt.close();
    }
  });

  it('close() can be called twice', async () => {
    const rt = openRuntime(ENV);
    await rt.close();
    await expect(rt.close()).resolves.toBeUndefined();
  });

  it('refuses a model that is not free, like createAiClient', () => {
    expect(() => openRuntime({ ...ENV, OPENROUTER_MODELS: 'vendor/paid-model' })).toThrow(/:free/);
  });

  it('refuses a bad config, like loadConfig', () => {
    expect(() => openRuntime({ ...ENV, CONTACT_COUNT: 'many' })).toThrow(/CONTACT_COUNT/);
  });
});
