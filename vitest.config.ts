import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Load .env when present; a fresh clone has none and still works.
if (existsSync('.env')) {
  loadEnv({ path: '.env', quiet: true });
}

// Same value as .env.example, so `npm test` runs with no .env at all.
process.env.TEST_DATABASE_URL ??= 'postgres://mnemio:mnemio@localhost:5433/mnemio_test';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // DB test files share one database; run test files one at a time so they cannot race.
    fileParallelism: false,
  },
});
