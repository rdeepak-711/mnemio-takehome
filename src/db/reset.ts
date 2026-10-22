import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from '../config';
import { resetDb } from './migrate';
import { closePool, getPool } from './pool';

// `npm run db:reset`: drop and rebuild the database named by DATABASE_URL.
// dotenv never overrides variables already set, so DATABASE_URL from the shell wins over .env.
if (existsSync('.env')) loadEnv({ path: '.env', quiet: true });

try {
  const config = loadConfig(process.env);
  const pool = getPool(config.databaseUrl);
  await resetDb(pool);
  // resetDb starts from an empty schema, so every recorded migration was applied by this run.
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations');
  console.log(`database reset: ${rows[0]?.n ?? 0} migration(s) applied`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await closePool();
}
