# T01 — Repo skeleton

## Goal

An empty but working TypeScript project: `npm test` runs Vitest, and one test can talk to a real Postgres started by Docker Compose. Nothing about emails yet.

## Files

Create: `package.json`, `package-lock.json` (made by `npm install`), `tsconfig.json`, `vitest.config.ts`, `docker-compose.yml`, `docker/init.sql`, `.env.example`, `.gitignore`, `src/db/pool.ts`.
Tests (written by harness engineer): `tests/unit/smoke.test.ts`, `tests/db/connection.test.ts`.

## Behaviour

- `package.json`: `"type": "module"`, Node ≥ 22. Scripts: `test` (`vitest run`), `typecheck` (`tsc --noEmit`). Placeholder scripts for later tasks are **not** added yet. Each task adds its own.
- Dev dependencies: `typescript`, `vitest`, `tsx`, `@types/node`, `@types/pg`. Dependencies: `pg`, `dotenv`.
- `tsconfig.json`: `strict: true`, `noUncheckedIndexedAccess: true`, `module: "ESNext"`, `moduleResolution: "Bundler"` (allows extensionless relative imports like `'../../src/db/pool'`, which the tests use, and is what Next.js wants later), target ES2022, `include` covers `src` and `tests`.
- `vitest.config.ts`: loads `.env` via `dotenv/config` if the file exists. If `TEST_DATABASE_URL` is still unset, it falls back to `postgres://mnemio:mnemio@localhost:5433/mnemio_test` (the `.env.example` value), so `npm test` works on a fresh clone with no `.env`. Files under `tests/db/**` must not run in parallel with each other (`fileParallelism: false`, or a separate project with `poolOptions.threads.singleThread`).
- `docker-compose.yml`: service `db`, image `postgres:17-alpine`, user/password `mnemio`/`mnemio`, host port **5433** → 5432, a named volume, a healthcheck (`pg_isready`), and `docker/init.sql` mounted into `/docker-entrypoint-initdb.d/` that creates database `mnemio_test` (the default DB is `mnemio`).
- `.env.example`: the full variable list from `spec/site.md`, with `OPENROUTER_API_KEY` empty.
- `.gitignore`: `node_modules`, `.env`, `.next`, `coverage`, `*.log`.
- `src/db/pool.ts`: exports `getPool(url: string): pg.Pool` (one pool per URL, cached) and `closePool(): Promise<void>` (ends all pools).

## Edge cases

- `getPool` called twice with the same URL returns the same pool object.
- `closePool()` when no pool exists does not throw.

## Tests that prove it

- `tests/unit/smoke.test.ts`: `1 + 1 === 2` (proves Vitest and TS run).
- `tests/db/connection.test.ts`: with `TEST_DATABASE_URL`, `SELECT 1 AS ok` returns `ok = 1`; same URL → same pool; `closePool()` twice doesn't throw.

Expected failure before the build: `Cannot find module '../../src/db/pool'` (and Vitest not installed).

## Explain-back (Deepak answers before ✅)

1. Why is Postgres on port 5433 and not 5432?
2. Why do the DB test files run one at a time while the unit tests can run in parallel?
3. What is `.env.example` for, and why is `.env` in `.gitignore`?

## Done when

`docker compose up -d db && npm install && npm test` is green, `npm run typecheck` is clean, and no file outside the list above was created.
