# T15 — Deactivation

## Goal

A contact who got all four emails and stayed silent for the last wait (`WAIT_DAYS` D) is closed as `deactivated`. Runs in each tick after replies (T14) and before sending (T13), so a reply that arrived in time always wins.

## Files

Create: `src/engine/deactivate.ts`.
Tests (written by harness engineer): `tests/db/deactivate.test.ts`.

## Interface

```ts
import type pg from 'pg';
export const DEACTIVATE_BATCH_SIZE = 500;
export async function deactivateDue(pool: pg.Pool, now: Date): Promise<{ deactivated: number }>;
```

## Behaviour (D49)

- One client from the pool; loop of batches, one transaction each: `BEGIN` → `SELECT id, status FROM contacts WHERE next_action = 'deactivate' AND next_action_at <= now ORDER BY next_action_at, id LIMIT 500 FOR UPDATE SKIP LOCKED` → for each, `transition(status, { type: 'deactivate_due' })` (the rulebook decides, D25) → update `status`, `next_action` null, `next_action_at` null, `updated_at = now` → event `status_changed` `{ from, to, reason: 'deactivate_due' }` with `occurred_at = now` → `COMMIT`. Stop when a batch is empty. Any error: `ROLLBACK`, release (with the error if the rollback fails, like `sendDue`), rethrow.
- Bulk writes per batch are fine (one `UPDATE … WHERE id = ANY($1)` and one multi-row events insert), as long as every new status comes from `transition`.
- No suppression check: deactivating sends nothing.
- Reads no real clock.

## Edge cases (each one a test)

Due → `deactivated` with one event, invariants clean; due exactly at `now` vs 1 ms later; other statuses never touched even when overdue (rows and events unchanged); second run deactivates 0; 537 due → all done across batches; 4 parallel calls over 1,200 → each exactly once; a reply processed in the same tick wins (`replied`); an out-of-office-pushed deactivation waits until its new date, then happens.

Expected failure before the build: `Cannot find module '../../src/engine/deactivate'`.

## Explain-back

1. Why does deactivation go through `transition()` instead of one `UPDATE … SET status = 'deactivated'`?
2. Why must deactivation run after replies in a tick?

## Done when

All tests pass, `npm run typecheck` and `npm run format:check` are clean.
