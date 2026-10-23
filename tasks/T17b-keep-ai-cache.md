# T17b — Keep the AI cache and the call count through a reset

## Goal

`npm run db:reset` drops the whole `public` schema, which takes `llm_cache` and `llm_usage` with it. Every fresh demo then pays again for the 20 email sequences, and the day's call count restarts at 0 while OpenRouter's count doesn't, so the budget check stops protecting us. Move both tables into their own `ai` schema that `db:reset` keeps (D52).

## Files

Create: `src/db/migrations/002_ai_schema.sql`. Change: `src/db/migrate.ts` (`resetDb`), `src/db/reset.ts`, `src/ai/cache.ts`, `src/ai/limiter.ts` (table names only).
Tests (written by harness engineer): `tests/db/reset-keeps-ai.test.ts`; updated table names in `tests/db/schema.test.ts`, `tests/db/seed.test.ts`, `tests/db/ai-client.test.ts`, `tests/db/ai-prompts.test.ts`.

## Behaviour

**`002_ai_schema.sql`** (must be safe to run again after every reset, when `ai` already exists and `001` has just recreated the public tables):
1. `CREATE SCHEMA IF NOT EXISTS ai;`
2. `CREATE TABLE IF NOT EXISTS ai.llm_cache` and `ai.llm_usage` with the same columns, defaults and checks as in `001_init.sql` (constraint names may stay the same; they are per schema).
3. Copy any rows from `public.llm_cache` (`ON CONFLICT (key) DO NOTHING`) and `public.llm_usage` (`ON CONFLICT (day) DO UPDATE SET calls = GREATEST(ai.llm_usage.calls, EXCLUDED.calls)`, so a kept count is never lowered).
4. `DROP TABLE public.llm_cache, public.llm_usage;`
Don't edit `001_init.sql` (databases have already applied it).

**`resetDb(pool, dir = MIGRATIONS_DIR, opts: { keepAi?: boolean } = {})`:** drops and recreates `public` as now; unless `keepAi`, also `DROP SCHEMA IF EXISTS ai CASCADE`; then `migrate`. Default is a full wipe, so tests still start from nothing.

**`src/db/reset.ts`** (`npm run db:reset`) calls `resetDb(pool, MIGRATIONS_DIR, { keepAi: true })` and prints, after the migration line, `AI cache kept: <n> saved answer(s), <m> call(s) counted today` (today = UTC date).

**`src/ai/cache.ts`, `src/ai/limiter.ts`:** every query uses `ai.llm_cache` / `ai.llm_usage`.

## Edge cases (each one a test)

Tables are in `ai`, none in `public`; checks still enforced; `keepAi` keeps the cache and count while contacts are wiped, also twice in a row; default reset wipes them; a database built with only `001` and AI rows in `public` upgrades with `002`, the rows move, the public tables are gone; a kept count is never lowered.

Expected failure before the build: `relation "ai.llm_cache" does not exist`.

## Explain-back

1. Why did a reset make the budget check lie?

## Done when

All tests pass, `npm run typecheck` and `npm run format:check` are clean, and `npm run db:reset` on the dev database prints the kept line.
