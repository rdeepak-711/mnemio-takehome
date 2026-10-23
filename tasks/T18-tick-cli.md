# T18 — Tick, advance and the CLI

## Goal

One tick runs everything built so far, in the spec's order, at the simulated "now": deliver due replies (T14), label them (T14, with the T17 classifier when there is an AI client), deactivate (T15), send (T13, with the T17 sequence writer). `advance` moves the clock one day and ticks, N times. A command line wraps it: `npm run tick`, `npm run advance -- --days N`, and `npm run ai:warm`, which writes all 20 sequences up front so later ticks read them from the cache (D53).

## Files

Create: `src/engine/tick.ts`, `src/ai/warm.ts`, `src/cli.ts` (exports only, no side effects), `src/main.ts` (the entry point). Change: `package.json` (three scripts only).
Tests (written by harness engineer): `tests/unit/cli.test.ts`, `tests/db/tick.test.ts`, `tests/db/warm.test.ts`, `tests/db/cli-run.test.ts`; helper change in `tests/helpers/fake-openrouter.ts` (`respond`).

## Part 1 — `src/engine/tick.ts`

```ts
import type pg from 'pg';
import type { Config } from '../config';
import type { Provider } from '../mock/provider';
import type { AiClient } from '../ai/client';
import type { ProcessSummary } from './replies';
import type { SendSummary } from './send';
export const MAX_ADVANCE_DAYS = 365;
export type TickDeps = { pool: pg.Pool; provider: Provider; config: Config; ai?: AiClient | null };
export type TickSummary = {
  now: Date;
  delivered: number;
  labelled: ProcessSummary; // { processed, rule, ai, fallback }
  deactivated: number;
  sent: SendSummary; // { sent, bounced, suppressed, batches }
};
export async function runTick(deps: TickDeps): Promise<TickSummary>;
export async function advanceDays(
  deps: TickDeps,
  days: number,
  onDay?: (summary: TickSummary) => void,
): Promise<TickSummary[]>;
```

**`runTick(deps)`:** `now = getNow(pool)` (throws "… run npm run seed" when the clock isn't set; don't catch it). Then, in this order and each awaited before the next: `deliverReplies(pool, now)` → `processReplies(pool, now, { config, classify })` → `deactivateDue(pool, now)` → `sendDue(pool, now, { provider, config, getTemplate })`. With `deps.ai` set, this tick builds a **new** `createSequenceWriter(ai)` and `createClassifier(pool, ai)` and passes `writer.getTemplate` and the classifier; without it, both are left out (fallback emails, rules then `needs_review`). A new writer per tick means a segment whose AI answer failed today is asked again tomorrow (D51, D53). Errors from any step propagate.

**`advanceDays(deps, days, onDay?)`:** `days` must be an integer from 1 to `MAX_ADVANCE_DAYS`; otherwise throw an error whose message contains `days` **before touching the database**. Then `days` times: `advance(pool, 1)` (src/clock.ts), `runTick(deps)`, call `onDay` with the summary. Returns the summaries in order.

## Part 2 — `src/ai/warm.ts`

```ts
import type { AiClient } from './client';
export type WarmResult = { segment: string; source: 'ai' | 'cache' | 'fallback' };
export async function warmSequences(ai: AiClient): Promise<WarmResult[]>;
```

One `createSequenceWriter(ai)`; for each segment of `allSegments()`, **in that order, one at a time**, `getTemplate(segment, 'first')`; `null` → `'fallback'`, else the template's `source`. Never throws (the writer already doesn't).

## Part 3 — `src/cli.ts` and `src/main.ts`

```ts
import type { TickSummary } from './engine/tick';
export type Command = { command: 'run' } | { command: 'advance'; days: number } | { command: 'ai:warm' };
export function parseArgs(argv: string[]): Command;
export function formatTick(summary: TickSummary, callsToday: number, budget: number): string;
```

**`parseArgs(argv)`** (argv as after `process.argv.slice(2)`): `['run']`, `['ai:warm']`, `['advance', '--days', 'N']`. N must be written as a plain whole number (`/^\d+$/`) from 1 to `MAX_ADVANCE_DAYS`. Throws an error whose message contains `usage:` for: no command, an unknown command, extra arguments, `advance` without `--days`, and a bad N (`0`, `-3`, `2.5`, `abc`, `366`, `1e2`, empty).

**`formatTick(s, callsToday, budget)`**, exactly:
`2026-11-03  delivered 12 · labelled 12 (rule 9, ai 2, fallback 1) · deactivated 4 · sent 310 (bounced 6, suppressed 1) · AI calls today 3/50`
The date is `s.now`'s UTC calendar day. Two spaces after the date; ` · ` between parts.

**`src/main.ts`** loads `.env` like `src/db/reset.ts` (shell variables win), then:
1. `parseArgs(process.argv.slice(2))`. A bad command prints the message to stderr and exits 1 without opening a pool.
2. `loadConfig(process.env)`; `pool = getPool(config.databaseUrl)`; a **separate** `new pg.Pool({ connectionString: config.databaseUrl })` for `createProvider` (D43); `ai = createAiClient({ pool, apiKey: config.openrouterApiKey, models: config.openrouterModels, rpm: config.aiRpm, dailyBudget: config.dailyAiBudget })`.
3. `run` → one `runTick`, print `formatTick`. `advance` → `advanceDays` with `onDay` printing `formatTick` per day. Both then run `checkInvariants(pool)`: none → print `invariants: ok`; otherwise print each to stderr (`invariant N (contact id): message`) and exit 1.
4. `ai:warm` → with no key, first print `no OPENROUTER_API_KEY: every sequence uses the fallback`. Then `warmSequences(ai)`, one line per result `<segment>  <source>`, then `warmed 20 segments: A ai, C cache, F fallback`.
5. "AI calls today" = `calls` in `ai.llm_usage` for `(now() AT TIME ZONE 'UTC')::date`, 0 when there's no row (same query as `src/db/reset.ts`; no real clock read in TypeScript).
6. Any error → message to stderr, exit 1 (e.g. `sim_clock is not set; run npm run seed`). Always end both pools in `finally` (`closePool()` and the provider pool's `end()`).

`package.json` scripts: `"tick": "tsx src/main.ts run"`, `"advance": "tsx src/main.ts advance"`, `"ai:warm": "tsx src/main.ts ai:warm"`. `npm run advance -- --days 30` passes `--days 30` through.

## Edge cases (each one a test)

Unit: every good and bad argv above; `formatTick` exact string, and the UTC date near midnight.
Tick: order (a reply and a due follow-up at the same tick → the reply wins, no send); a second `runTick` at the same time does nothing (all counts 0, no new rows); two `runTick` in parallel at the same time → no duplicate `(contact_id, step)`, invariants hold, and the two `sent` counts add up to the new `sends` rows; 30 days on a 500-contact seed → invariants hold, no contact over 4 sends, the clock moved exactly 30 days, 30 summaries a day apart, some `deactivated`; bad `days` rejected with the clock unchanged; no clock → rejects with "npm run seed".
AI: with a working fake AI, AI emails are sent (`template_source = 'ai'`) and replies are labelled by the AI (`label_source = 'ai'`); an AI that always fails → the run still finishes on fallbacks, invariants hold; failing on day 1, working on day 2 → day 2 sends AI emails (new writer per tick).
Warm: 20 results in `allSegments()` order, all `ai`, 20 sequence calls; again with a new client → all `cache`, no call; failing AI → all `fallback`.
CLI (as a child process, no key): `advance --days 2` exits 0, two day lines, `invariants: ok`, clock +2 days; `advance --days 0` exits 1, `usage:` on stderr, clock unchanged; `tick` on an unseeded database exits 1 with "npm run seed"; `ai:warm` with no key exits 0 with 20 `fallback` lines; the three npm scripts exist.

Expected failure before the build: `Cannot find module '../../src/engine/tick'` (and `cli`, `ai/warm`), and the child-process tests fail because `src/main.ts` doesn't exist.

## Explain-back

1. Why does a tick deliver and label replies before it sends?
2. Why is a new sequence writer made each tick, not once for the whole run?
3. Two people run `npm run tick` at the same moment. Why does nobody get the same email twice?

## Done when

All tests pass, `npm run typecheck` and `npm run format:check` are clean, and the 30-day test's time is reported.
