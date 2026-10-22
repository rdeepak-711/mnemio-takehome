# T12 — Claim due contacts with SKIP LOCKED

## Goal

The first half of "never send the same step twice". Before a worker sends anything, it claims a batch of due contacts by locking their rows. Another worker running at the same moment skips the locked rows and takes different ones, so two workers can never work on the same contact at the same time. The lock lasts until the worker's transaction ends.

## Files

Create: `src/engine/claim.ts`.
Tests (written by harness engineer): `tests/db/claim.test.ts`.

## Behaviour

```ts
import type pg from 'pg';
import type { Status, Step } from '../lifecycle';
import type { Industry, RoleFamily } from '../segments';
export type ClaimedContact = {
  id: number; email: string; firstName: string; lastName: string; company: string; industry: Industry;
  role: string; roleFamily: RoleFamily; timezone: string; segment: string;
  status: Status; nextAction: Step; nextActionAt: Date;
};
export async function claimDue(client: pg.PoolClient, now: Date, limit: number): Promise<ClaimedContact[]>;
```

- One query, from `spec/site.md` "One tick" step 4:
  `SELECT … FROM contacts WHERE status IN ('new','first_sent','follow_up_1_sent','follow_up_2_sent','follow_up_3_sent') AND next_action IN ('first','follow_up_1','follow_up_2','follow_up_3') AND next_action_at <= $now ORDER BY next_action_at, id LIMIT $limit FOR UPDATE SKIP LOCKED`.
- Takes a **client** (one connection), not the pool: the caller has already run `BEGIN` on it, and the locks last until that transaction commits or rolls back. Calling it on a client outside a transaction is a caller bug (the lock would end with the statement); the send step (T13) is the only caller.
- `limit` must be an integer ≥ 1, otherwise it throws naming `limit`.
- Returns rows in camelCase, in claim order (oldest due first, then lowest id).
- A due contact whose address is in `suppression` **is** returned; the send step decides what to do with it (D34). `follow_up_3_sent` contacts are never returned (their next action is `deactivate`, handled by T15).
- Reads only; changes nothing.

## Edge cases (each one a test)

- Returns due contacts at every in-sequence step (`new` … `follow_up_2_sent`), with the right fields.
- `next_action_at` exactly equal to `now` is due; one millisecond later is not.
- Terminal contacts (`replied`, `bounced`, `unsubscribed`, `deactivated`) are never returned.
- `follow_up_3_sent` (next action `deactivate`) is never returned, even when due.
- A due contact whose email is suppressed is returned.
- `limit` caps the batch; order is `next_action_at`, then `id`.
- `limit` of 0, -1 or 1.5 throws naming `limit`.
- Two transactions at the same time, each `limit 5`, over 8 due contacts: the first gets 5, the second gets the other 3 — no overlap — and the second does not wait for the first.
- After the first transaction rolls back, its contacts can be claimed again.
- 4 transactions at the same time over 100 due contacts, each claiming `limit 30`: the sets don't overlap and together cover all 100 (30 + 30 + 30 + 10).
- Nothing in the table changes.

## Tests that prove it

`tests/db/claim.test.ts`, against `TEST_DATABASE_URL`, `resetDb` before each test, contacts inserted directly.

Expected failure before the build: `Cannot find module '../../src/engine/claim'`.

## Explain-back

1. What does `SKIP LOCKED` do that plain `FOR UPDATE` doesn't?
2. Why must `claimDue` run inside a transaction on one client?
3. If the lock already stops two workers, why do we still need the database's UNIQUE rule on `(contact_id, step)`?

## Done when

All tests pass, `npm run typecheck` and `npm run format:check` are clean.
