# T09 — Simulated clock

## Goal

One small module that owns "now". The simulation's time lives in the single `sim_clock` row; every part of the system reads it from here and never from the computer's clock. Moving it forward a day is how weeks of a campaign play out in seconds.

## Files

Create: `src/clock.ts`.
Tests (written by harness engineer): `tests/db/clock.test.ts`, `tests/unit/no-real-clock.test.ts`.

## Behaviour

```ts
import type pg from 'pg';
export type Queryable = Pick<pg.Pool, 'query'>;          // a pool or a client inside a transaction
export async function getNow(db: Queryable): Promise<Date>;
export async function setNow(db: Queryable, t: Date): Promise<void>;
export async function advance(db: Queryable, days: number): Promise<Date>;   // returns the new now
```

- `getNow` reads `sim_clock.now`. If there is no row, it throws an `Error` whose message says the clock isn't set and to run the seed (`sim_clock is not set; run npm run seed`).
- `setNow` writes the row with `id = 1`, inserting it the first time and updating it after (`INSERT … ON CONFLICT (id) DO UPDATE`). There is never more than one row.
- `advance` moves `now` forward by whole days in one statement (`UPDATE sim_clock SET now = now + make_interval(days => $1) WHERE id = 1 RETURNING now`), so two callers can't both read the old value and write the same new one. `days` must be an integer ≥ 1, otherwise it throws naming `days`. If the clock isn't set, it throws the same error as `getNow`.
- All three take a `Queryable`, so they work on the pool or inside a transaction's client.
- `advance` moves the clock only; it doesn't run a tick. The `advance` CLI (T18) loops "advance 1 day, run a tick" N times.

### No real clock anywhere in `src/`

`tests/unit/no-real-clock.test.ts` reads every `.ts` file under `src/` and fails if one contains `new Date()` with no arguments or `Date.now(`. The only exception is `src/ai/` (T16–T17): OpenRouter's daily quota counts real days, so `llm_usage` uses the real date. This replaces the spec's narrower check of only `src/engine` and `src/mock`, and makes the per-file checks in the schedule and rules tests a special case of it.

## Edge cases (each one a test)

- `getNow` before `setNow` → throws, message mentions the seed.
- `setNow(t)` then `getNow()` → the same instant (millisecond precision).
- `setNow` twice → one row, holding the second value.
- `advance(1)` → exactly 24 hours later, same time of day; returns the new value and `getNow` agrees.
- `advance(7)` across a month end (2026-11-28 → 2026-12-05) and a year end (2026-12-29 → 2027-01-05).
- `advance(0)`, `advance(-1)`, `advance(1.5)` → throw naming `days`; the clock doesn't move.
- `advance` before `setNow` → throws the "not set" error.
- Ten `advance(1)` calls at the same time (`Promise.all`) → the clock ends exactly 10 days later (no lost update).
- Works inside a transaction: `setNow` on a client after `BEGIN`, then `ROLLBACK` → the clock keeps its old value.
- The time is stored and returned in UTC whatever the machine's timezone.
- No file under `src/` outside `src/ai/` calls the real clock.

## Tests that prove it

`tests/db/clock.test.ts` (against `TEST_DATABASE_URL`, `resetDb` before each test) and `tests/unit/no-real-clock.test.ts`.

Expected failure before the build: `Cannot find module '../../src/clock'` (the no-real-clock test already passes today and must keep passing).

## Explain-back

1. Why does the time live in a database row instead of a variable in the program?
2. Why is `advance` one `UPDATE … RETURNING` instead of "read now, add a day, write it back"?
3. Why is `src/ai/` the one place allowed to use the real clock?

## Done when

All tests pass (`npm test`, Docker DB up), `npm run typecheck` and `npm run format:check` are clean, and `src/clock.ts` is the only new file.
