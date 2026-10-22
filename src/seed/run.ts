import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from '../config';
import { checkInvariants } from '../invariants';
import { closePool, getPool } from '../db/pool';
import { seed } from './seed';

// `npm run seed`: fill the empty database named by DATABASE_URL, then check it.
// dotenv never overrides variables already set, so DATABASE_URL from the shell wins over .env.
if (existsSync('.env')) loadEnv({ path: '.env', quiet: true });

try {
  const config = loadConfig(process.env);
  const pool = getPool(config.databaseUrl);
  const { contacts } = await seed(pool, config);
  console.log(`seeded ${contacts} contacts`);
  const violations = await checkInvariants(pool);
  if (violations.length === 0) {
    console.log('invariants: ok');
  } else {
    for (const v of violations) console.error(`invariant ${v.invariant} (contact ${v.contactId ?? '-'}): ${v.message}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await closePool();
}
