# T13 — Send step

## Goal

The heart of the engine. Repeatedly claim a batch of due contacts (T12), and for each one either close it (address on the do-not-email list) or write its email, hand it to the mock provider, record the send, move the contact on through `transition()` and write the diary. Each batch commits as one transaction, so a crash leaves nothing half-done, and a re-run never sends the same step twice.

## Files

Create: `src/engine/send.ts`, `src/templates/fallback.ts`. Change: `src/lifecycle.ts` (add the `suppressed` event).
Tests (written by harness engineer): `tests/db/send.test.ts`, `tests/unit/fallback.test.ts`, new cases in `tests/unit/lifecycle.test.ts`.

## Part 1 — `suppressed` event in `src/lifecycle.ts` (D34)

- `LifecycleEvent` gains `{ type: 'suppressed'; reason: 'bounced' | 'unsubscribed' }`.
- From any in-sequence status: status becomes the reason (`bounced` or `unsubscribed`), `nextAction: null`.
- From a terminal status: throws `InvalidTransitionError`.
- `describeEvent` gives `suppressed:<reason>`.

## Part 2 — `src/templates/fallback.ts`

```ts
import type { Step } from '../lifecycle';
export const FALLBACK_TEMPLATES: Record<Step, { subject: string; body: string }>;
```

Four hand-written emails, one per step, using only the allowed slots (`{{first_name}}`, `{{company}}`, `{{role}}`, `{{industry}}`, `{{last_name}}`). Each must pass `checkContent` after `render` with ordinary values. Plain, short, no spam words; follow-ups refer back to the earlier email.

## Part 3 — `src/engine/send.ts`

```ts
import type pg from 'pg';
import type { Config } from '../config';
import type { Step } from '../lifecycle';
import type { Provider } from '../mock/provider';
import type { ClaimedContact } from './claim';
export type Template = { subject: string; body: string; source: 'ai' | 'cache' };
export type SendDeps = {
  provider: Provider;                                   // built on its OWN pool (D43)
  config: Pick<Config, 'waitDays' | 'sendBatchSize'>;
  getTemplate?: (segment: string, step: Step) => Promise<Template | null>;   // T17 plugs in here; absent → fallback
  afterProviderCall?: (contact: ClaimedContact) => void | Promise<void>;     // test hook for the crash test
};
export type SendSummary = { sent: number; bounced: number; suppressed: number; batches: number };
export function contactVars(c: ClaimedContact): Record<'first_name' | 'last_name' | 'company' | 'role' | 'industry', string>;
export async function sendDue(pool: pg.Pool, now: Date, deps: SendDeps): Promise<SendSummary>;
```

**Loop:** `pool.connect()` → `BEGIN` → `claimDue(client, now, config.sendBatchSize)` → if 0 claimed, `COMMIT`, stop → otherwise handle each claimed contact in order → `COMMIT` → next batch. Any error: `ROLLBACK` the batch, release the client, rethrow. `batches` counts batches that claimed at least one contact. All writes in the batch use the batch's client.

**Per contact:**
1. **Suppressed?** `SELECT reason FROM suppression WHERE email = $1`. If found: `transition(status, { type: 'suppressed', reason })`; update the contact (status, `next_action` and `next_action_at` null, `updated_at = now`); one `status_changed` event `{ from, to, reason: 'suppressed' }`. No email, no provider call, no `sends` row. Counts as `suppressed`.
2. **Write the email.** `step = contact.nextAction`. `vars = contactVars(contact)`: the five slot values with every `{` and `}` removed (so a company called `{{evil}}` can't break a template; D46). If `getTemplate` exists and returns a template, render it; if rendering throws or `checkContent` finds any problem, use the fallback instead. With the fallback, `template_source = 'fallback'`; if the fallback itself throws or fails `checkContent`, throw (a bug in our own template; the run stops loudly).
3. **Hand it over.** `provider.send({ idempotencyKey: '<id>:<step>', to: email, subject, body, now })`. Then `await deps.afterProviderCall?.(contact)`.
4. **Record the send.** Plain `INSERT INTO sends (contact_id, step, idempotency_key, outcome, subject, body, template_source, sent_at = now) RETURNING id` — no `ON CONFLICT`: a duplicate can only mean a bug got past the lock, and it must fail loudly, not leave the contact due forever (D46). Event `sent` `{ step, outcome, send_id }`.
5. **Move the contact on.**
   - `accepted`: `transition(status, { type: 'sent', step })`; `next_action_at = nextActionAt(step, now, waitDays)`; event `status_changed` `{ from, to, reason: 'sent' }`. Counts as `sent`.
   - `bounced`: `transition(status, { type: 'bounced' })` (a bounced first email goes `new → bounced`); `INSERT INTO suppression (email, 'bounced', now) ON CONFLICT DO NOTHING`; event `status_changed` `{ from, to, reason: 'bounced' }`. Counts as `bounced`.
   - Update the contact: status, `next_action`, `next_action_at`, `updated_at = now`. Events use `occurred_at = now`.

## Edge cases (each one a test)

**Unit:** `suppressed` from every in-sequence status (both reasons) and the throw from every terminal status; every fallback template renders and passes `checkContent`, uses only allowed slots, and differs per step.

**DB (`tests/db/send.test.ts`):**
- A due `new` contact → one `sends` row (`first`, `accepted`, fallback, rendered with the contact's name and company, `sent_at = now`, key `<id>:first`), status `first_sent`, next `follow_up_1` at now + 3 days, `updated_at = now`, a `sent` event and a `status_changed` event, one `mock_outbox` row.
- `follow_up_2_sent` → sends `follow_up_3`; next action `deactivate` at now + 7 days.
- Not-yet-due, terminal and `follow_up_3_sent` contacts are untouched.
- `BOUNCE_RATE=1` → `sends.outcome = 'bounced'`, status `bounced`, no next action, a `bounced` suppression row, events with reason `bounced`.
- Suppressed address (each reason) → status equals the reason, no send, no outbox row, one `status_changed` event with reason `suppressed`, no `sent` event.
- Run twice at the same `now` → the second run returns all zeros and nothing changes.
- The summary counts match the rows.
- `sendBatchSize = 7` over 20 due → all 20 handled in at least 3 batches.
- 4 `sendDue` calls in parallel over 2,000 due contacts → exactly 2,000 `sends`, 2,000 distinct keys, 2,000 outbox rows, and `checkInvariants` is `[]`.
- 12 workers in parallel on an engine pool of 10 connections, with the provider on its own pool → finishes (no hang) with every contact sent once.
- Crash: `afterProviderCall` throws on the 3rd contact → `sendDue` rejects with that error; no `sends` rows and no contact changes are kept; `mock_outbox` keeps the 3 rows. A re-run without the hook → every contact sent once, and the outbox has exactly one row per contact (the repeated keys returned their first answers).
- Company `{{evil}} Ltd` → the email is sent and its body contains `evil Ltd` and no braces.
- `getTemplate` returns a valid template → it is used, `template_source` is its `source`; one with a spam word, or an unknown slot → the fallback is used; `null` → the fallback.
- On a 1,000-contact seed, one `sendDue` at `SIM_START` → no sending contact is still due, and `checkInvariants` is `[]`.

## Explain-back

1. Why is each batch one transaction, and what is undone if it fails?
2. After a crash between the provider call and the commit, why does the re-run not send a second email?
3. Why is a suppressed contact closed through `transition()` instead of just skipped?

## Done when

All tests pass, `npm run typecheck` and `npm run format:check` are clean.
