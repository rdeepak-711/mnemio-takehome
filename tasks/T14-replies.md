# T14 — Reply delivery and processing

## Goal

Every tick, before anything is sent: move the replies the mock has ready into our `replies` table, label each one (rules first, then the AI, then `needs_review`), and move its contact on through `transition()`. A reply that arrives before a due follow-up stops that follow-up, because replies are handled first.

## Files

Create: `src/engine/replies.ts`. Change: `src/invariants.ts` (invariants 2 and 3, Part 3).
Tests (written by harness engineer): `tests/db/replies.test.ts`, new cases in `tests/db/invariants.test.ts`.

## Interface

```ts
import type pg from 'pg';
import type { Config } from '../config';
import type { Label } from '../labels';
export const REPLY_BATCH_SIZE = 25;
export type ClassifyItem = { id: number; body: string };                       // never the true label
export type Classifier = (items: ClassifyItem[]) => Promise<Map<number, Label>>; // T17 plugs in here
export type ReplyDeps = { config: Pick<Config, 'oooDefaultDays'>; classify?: Classifier | undefined };
export type ProcessSummary = { processed: number; rule: number; ai: number; fallback: number };
export async function deliverReplies(pool: pg.Pool, now: Date): Promise<{ delivered: number }>;
export async function processReplies(pool: pg.Pool, now: Date, deps: ReplyDeps): Promise<ProcessSummary>;
```

## Part 1 — `deliverReplies`

- Due rows are `mock_inbox` rows with `NOT delivered AND deliver_at <= now` whose `idempotency_key` matches a `sends.idempotency_key` (D31). Each becomes one `replies` row: `contact_id` and `send_id` from the send, `body`, `headers`, `true_label` copied, `label`, `label_source`, `return_date`, `classified_at` null.
- `received_at` = `deliver_at` if it is after the send's `sent_at`, otherwise `now`. (After a crash the retried send can be dated after the mock's delivery time; a reply must never be dated before its email — invariant 5.)
- Marking `delivered = true` and inserting the reply happen in one statement or one transaction, with the inbox rows locked `FOR UPDATE SKIP LOCKED`, so parallel calls deliver each row exactly once.
- A due row with no matching send is left alone (`delivered` stays false) and is delivered on a later call once the send exists (D35).

## Part 2 — `processReplies`

**Loop:** batches of `REPLY_BATCH_SIZE`, one transaction each: `BEGIN` → select unlabelled replies (`label IS NULL`) `ORDER BY received_at, id LIMIT 25 FOR UPDATE SKIP LOCKED` → label them → apply each → `COMMIT`; stop when a batch is empty. Any database error: `ROLLBACK`, release, rethrow.

**Labelling, per batch:**
1. `classifyByRules({ body, headers }, received_at)` for each reply. A result → that label, source `rule`.
2. The rest go to `deps.classify` in **one** call (`{ id, body }` only). A returned label that is in `LABELS` → source `ai`.
3. No classifier, the classifier throws, the id is missing from the answer, or the label is not in `LABELS` → `needs_review`, source `fallback`. The run never stops because of the classifier.
4. `return_date` for an `out_of_office` label: the rule's `returnDate`, or for an AI label `findReturnDate(body, received_at)`. The date is read from **when the reply arrived**, not from `now`. Stored as a date (UTC day).

**Applying, per reply, in `received_at, id` order** (re-read the contact `FOR UPDATE` each time, so two replies from one contact in a batch see each other's effect):
- Update the reply: `label`, `label_source`, `return_date`, `classified_at = now`. Event `reply_received` `{ reply_id, label, label_source }`.
- `transition(status, { type: 'reply', label })`:
  - status changes → update `status`, `next_action` null, `next_action_at` null, `updated_at = now`; event `status_changed` `{ from, to, reason }` with reason `unsubscribe` for the unsubscribe label, otherwise `reply`.
  - label `unsubscribe` → also `INSERT INTO suppression (email, 'unsubscribed', now) ON CONFLICT DO NOTHING` (a bounced row already there stays: first reason wins).
  - `out_of_office` on an in-sequence contact → `next_action_at = oooReschedule(current, now, returnDate, oooDefaultDays)`; only if it changed: update `next_action_at`, `updated_at = now`, event `rescheduled` `{ from, to, cause: 'ooo' }` with ISO strings. Applies to `follow_up_3_sent` too (deactivation is pushed back).
  - nothing changes (OOO on a finished contact, another reply from a `replied` contact) → the contact row is not touched, only the reply and its `reply_received` event.
- Events use `occurred_at = now`, written `reply_received` first.
- Summary counts the replies processed and how many had each source.

## Part 3 — invariants 2 and 3 in `src/invariants.ts` (D48)

A late "unsubscribe" to an earlier email can arrive after a later email bounced; unsubscribe wins (Deepak, 23 Oct). The suppression row keeps its first reason, `bounced`.
- **Invariant 2:** `bounced` still needs last send bounced and a bounced row. `unsubscribed` is allowed with last send bounced **only together with** a bounced row (both or neither). Any other status with either sign is still a break.
- **Invariant 3:** `unsubscribed` needs an `unsubscribed` suppression row, **or** a `bounced` row with its last send bounced.

## Edge cases (each one a test in `tests/db/replies.test.ts`)

Delivery: field copy and `delivered = true`; due exactly at `now` vs 1 ms later; second run delivers 0; no send yet → waits, then delivered with `received_at = now` after the send commits, invariants clean; 4 parallel calls over 200 rows → 200 replies, no duplicates.
Labels: interested from every sent status → `replied` with both events; not interested; AI sees only rule-less replies and only `{ id, body }`; no classifier / throwing classifier / missing answer / unknown label → `needs_review` fallback; unsubscribe by rule → `unsubscribed` + suppression, AI not called; unsubscribe after a bounce → `unsubscribed`, bounced row stays, invariants clean; `replied` then unsubscribe → `unsubscribed`.
Out of office: dated → next email the day after the return date, `rescheduled` event; undated → now + 7 days; "returning Friday" read from the arrival day; AI-labelled OOO gets its date from the text; never earlier, no event when unchanged; `follow_up_3_sent` deactivation pushed back; a reply in the same tick as a due follow-up stops it (`sendDue` sends 0).
Finished contacts: deactivated + interested → `replied` (D44); deactivated + OOO → nothing changes, contact row untouched; deactivated + unsubscribe → `unsubscribed`; replied + not interested → unchanged.
Order and batches: OOO then interested from one contact in one tick → `replied`; interested then OOO → `replied`, no reschedule; 60 replies → AI calls of at most 25, counts match; second run processes 0 and writes no events; already-labelled (seeded) replies are left alone.

Expected failure before the build: `Cannot find module '../../src/engine/replies'`, and one invariants test (unsubscribed after a bounce reported as 2 and 3).

## Explain-back

1. Why does `deliverReplies` leave a reply undelivered when it can't find its send, instead of dropping it?
2. Why is an out-of-office reply's return date read from when the reply arrived, not from today?
3. Why does a reply have to be processed before the send step in the same tick?

## Done when

All tests pass, `npm run typecheck` and `npm run format:check` are clean.
