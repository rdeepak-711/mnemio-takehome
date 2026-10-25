# T20 — The full 10,000-contact run, timed

## Goal

One command does the whole thing the brief asks to see: reset (keeping the AI cache), seed 10,000 contacts, write the 20 sequences, advance day by day until nobody is left in the sequence (or 60 days), check every invariant, print the report and the wall-clock time of each phase. The measured numbers go into the README (D55).

## Files

Create: `src/full-run.ts`. Change: `src/cli.ts` (a `full-run` command), `src/main.ts` (run it), `package.json` (one script).
Tests (written by harness engineer): `tests/db/full-run.test.ts`, new cases in `tests/unit/cli.test.ts` and `tests/db/cli-run.test.ts`.

The spec names `scripts/full-run.ts`. It's a `src/main.ts` command instead, so it shares the pools, the AI client and the printing with `tick` and `advance`, with no second copy of that set-up (D55).

## Part 1 — `src/full-run.ts`

```ts
import type { TickDeps, TickSummary } from './engine/tick';
import type { Violation } from './invariants';
import type { Report } from './report';
export const DEFAULT_MAX_DAYS = 60;
export type Timings = { reset: number; seed: number; warm: number; advance: number; check: number; report: number; total: number }; // ms
export type FullRunResult = { days: number; finished: boolean; timings: Timings; violations: Violation[]; report: Report };
export async function fullRun(
  deps: TickDeps & { timer?: () => number }, // default performance.now; wall-clock timing only, never business time
  opts?: { maxDays?: number; onDay?: (summary: TickSummary) => unknown },
): Promise<FullRunResult>;
export function formatFullRun(r: FullRunResult): string;
```

**`fullRun`:** `maxDays` (default 60) must be an integer from 1 to `MAX_ADVANCE_DAYS`, checked before any query (error message contains `maxDays`). Then, each phase timed with `timer()` before and after:
1. **reset**: `resetDb(pool, MIGRATIONS_DIR, { keepAi: true })`.
2. **seed**: `seed(pool, config)`.
3. **warm**: `warmSequences(ai)` when `deps.ai` is set; otherwise nothing (still timed, near 0).
4. **advance**: until no contact is in an in-sequence status, at most `maxDays` days: `advanceDays(deps, 1, opts.onDay)` per day. Count the in-sequence contacts before each day. `days` = days advanced; `finished` = none left in sequence at the end.
5. **check**: `checkInvariants(pool)` → `violations`.
6. **report**: `report(pool, { simStart: config.simStart, dailyAiBudget: config.dailyAiBudget })`.
`total` = from before reset to after report.

**`formatFullRun(r)`**, exactly two lines (seconds with one decimal):
```
timings: reset 0.1 s · seed 1.2 s · warm 0.0 s · advance 62.8 s · check 0.4 s · report 0.1 s · total 64.6 s
days: 31 (finished: nobody left in sequence)
```
or, when stopped at the limit: `days: 60 (stopped at the limit: 12 still in sequence)` (the number from `report.inSequence`).

## Part 2 — CLI

`parseArgs(['full-run'])` → `{ command: 'full-run' }` (extra arguments refused; usage names it). `src/main.ts`: `full-run` prints each day's `formatTick` line as it goes (the same `onDay` as `advance`), then `formatFullRun`, then `invariants: ok` or the violations (stderr), then `formatReport`. Exit 1 when there is any violation or `report.orphaned > 0` (a clean run has none, D35). `package.json`: `"full-run": "tsx src/main.ts full-run"`.

## Edge cases (each one a test)

A 300-contact run with no AI finishes inside 60 days: no violations, nobody in sequence, 0 orphaned, every contact counted, each timing a number ≥ 0 and `total` ≥ every phase. `maxDays: 2` stops at 2 with people still in sequence. A saved AI answer survives the run's reset. The same seed run twice gives the same statuses and rates (the mock decides by hash, D-T11). With a working fake AI, the warm phase writes the 20 sequences and the run's emails come from the cache. A bad `maxDays` is refused before the database is touched. `formatFullRun`: both lines, both endings. CLI: `full-run` parses; `CONTACT_COUNT=100 npm run full-run` exits 0 and prints `timings:`, `invariants: ok` and `Report for`.

Expected failure before the build: `Cannot find module '../../src/full-run'`, and the new CLI cases.

## Explain-back

1. Why does the run stop when nobody is in sequence, not after a fixed 30 days?
2. Why does the full run keep the AI cache through its reset?
3. Why does a non-zero orphan count fail the run?

## Done when

All tests pass, typecheck and format are clean; then the harness runs `npm run full-run` on 10,000 contacts and puts the measured numbers in the README.
