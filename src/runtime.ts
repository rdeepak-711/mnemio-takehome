import pg from 'pg';
import { createAiClient, type AiClient } from './ai/client';
import { loadConfig, type Config } from './config';
import { closePool, getPool } from './db/pool';
import { createProvider, type Provider } from './mock/provider';

export type Runtime = {
  config: Config;
  pool: pg.Pool;
  providerPool: pg.Pool;
  provider: Provider;
  ai: AiClient;
  close(): Promise<void>;
};

// Everything the CLI and the dashboard need, built one way (D56). A bad config or a paid model (D50) throws before
// the provider pool exists; the shared pool opens no connection until its first query.
export function openRuntime(env: Record<string, string | undefined>): Runtime {
  const config = loadConfig(env);
  const pool = getPool(config.databaseUrl);
  const ai = createAiClient({
    pool,
    apiKey: config.openrouterApiKey,
    models: config.openrouterModels,
    rpm: config.aiRpm,
    dailyBudget: config.dailyAiBudget,
  });
  // The provider gets its own pool, so a send can't share a connection with the engine's transactions (D43).
  const providerPool = new pg.Pool({ connectionString: config.databaseUrl });
  const provider = createProvider(providerPool, config);

  let closed: Promise<void> | null = null;
  return {
    config,
    pool,
    providerPool,
    provider,
    ai,
    // Safe to call twice: the second call waits on the first.
    close() {
      closed ??= (async () => {
        await closePool();
        await providerPool.end();
      })();
      return closed;
    },
  };
}
