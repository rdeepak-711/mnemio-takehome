import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from '../config';
import { MIGRATIONS_DIR, resetDb } from './migrate';
import { closePool, getPool } from './pool';

// `npm run db:reset`: drop and rebuild the database named by DATABASE_URL, keeping the ai schema (D52).
// dotenv never overrides variables already set, so DATABASE_URL from the shell wins over .env.
if (existsSync('.env')) loadEnv({ path: '.env', quiet: true });

try {
  const config = loadConfig(process.env);
  const pool = getPool(config.databaseUrl);
  await resetDb(pool, MIGRATIONS_DIR, { keepAi: true });
  // resetDb starts from an empty schema, so every recorded migration was applied by this run.
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations');
  console.log(`database reset: ${rows[0]?.n ?? 0} migration(s) applied`);
  // "Today" is the UTC date, as in src/ai/limiter.ts; Postgres supplies it so no real clock is read here.
  const { rows: kept } = await pool.query<{ answers: number; calls: number }>(
    `SELECT (SELECT count(*) FROM ai.llm_cache)::int AS answers,
            COALESCE((SELECT calls FROM ai.llm_usage WHERE day = (now() AT TIME ZONE 'UTC')::date), 0)::int AS calls`,
  );
  console.log(`AI cache kept: ${kept[0]?.answers ?? 0} saved answer(s), ${kept[0]?.calls ?? 0} call(s) counted today`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await closePool();
}
