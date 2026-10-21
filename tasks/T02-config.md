# T02 — Config loader

## Goal

Read settings from environment variables once, check them, and hand the rest of the code a typed object. Bad settings fail loudly at start, naming the variable, instead of causing strange behaviour later.

## Files

Create: `src/config.ts`, `src/labels.ts`. Add dependency `zod`.
Tests: `tests/unit/config.test.ts`.

## Behaviour

`loadConfig(env: Record<string, string | undefined>): Config`. It takes the env as an argument (not `process.env` directly) so tests can pass their own.

| Variable | Type in `Config` | Default | Rule |
|---|---|---|---|
| `DATABASE_URL` | `databaseUrl: string` | none, required | non-empty |
| `SEED` | `seed: number` | 42 | integer |
| `CONTACT_COUNT` | `contactCount: number` | 10000 | integer 1–1,000,000 |
| `SIM_START` | `simStart: Date` | `2026-11-02T09:00:00Z` | valid ISO date |
| `WAIT_DAYS` | `waitDays: [number, number, number, number]` | `3,5,7,7` | exactly 4 integers, each ≥ 1 |
| `BOUNCE_RATE` | `bounceRate: number` | 0.03 | 0 ≤ x ≤ 1 |
| `REPLY_RATE` | `replyRate: number` | 0.08 | 0 ≤ x ≤ 1 |
| `REPLY_MIX` | `replyMix: Record<ReplyLabel, number>` | `interested:0.30,not_interested:0.35,out_of_office:0.20,unsubscribe:0.15` | labels from the 4 allowed, each 0–1, sum = 1 ± 0.001 |
| `OOO_DEFAULT_DAYS` | `oooDefaultDays: number` | 7 | integer ≥ 1 |
| `SEND_BATCH_SIZE` | `sendBatchSize: number` | 200 | integer ≥ 1 |
| `OPENROUTER_API_KEY` | `openrouterApiKey: string \| null` | null | empty string → null |
| `OPENROUTER_MODELS` | `openrouterModels: string[]` | `[]` | comma list, trimmed, empties dropped |
| `AI_RPM` | `aiRpm: number` | 20 | integer ≥ 1 |
| `DAILY_AI_BUDGET` | `dailyAiBudget: number` | 45 | integer ≥ 0 |

Reply labels are defined once, in `src/labels.ts`, and imported by `config.ts`, `lifecycle.ts` (T03) and `classify/rules.ts` (T07):

```ts
export const REPLY_LABELS = ['interested','not_interested','out_of_office','unsubscribe'] as const;  // what the mock can send
export type ReplyLabel = typeof REPLY_LABELS[number];
export const LABELS = [...REPLY_LABELS, 'needs_review'] as const;   // what a classifier can return
export type Label = typeof LABELS[number];
```

Errors: throw an `Error` whose message contains the variable name, e.g. `WAIT_DAYS: expected 4 values, got 3`.

## Edge cases

- `WAIT_DAYS=3,5,7` (3 values) → throws naming `WAIT_DAYS`.
- `WAIT_DAYS=3,0,7,7` or `3,-1,7,7` or `3,x,7,7` → throws.
- `WAIT_DAYS= 3 , 5 ,7,7` (spaces) → accepted.
- `BOUNCE_RATE=1.5` → throws.
- `REPLY_MIX` summing to 0.9 → throws. Unknown label `maybe:0.1` → throws. A label missing from the mix → treated as 0 (still has to sum to 1).
- `OPENROUTER_API_KEY=""` → `null`.
- Missing `DATABASE_URL` → throws.
- All optional variables missing → defaults above.

## Tests that prove it

One test per edge case above, plus "defaults when only `DATABASE_URL` is set" (deep-equals the full default object).

Expected failure before the build: `Cannot find module '../../src/config'`.

## Explain-back

1. Why does `loadConfig` take `env` as a parameter instead of reading `process.env` inside?
2. What would go wrong later if `WAIT_DAYS` had 3 values and we didn't check?
3. Why does an empty API key become `null` rather than `""`?

## Done when

All tests in `tests/unit/config.test.ts` pass and `npm run typecheck` is clean.
