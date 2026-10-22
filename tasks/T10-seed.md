# T10 — Seed 10,000 contacts with a consistent past

## Goal

Fill an empty database with 10,000 contacts and a believable history before `SIM_START`: some already emailed, some mid-sequence, some replied, bounced, unsubscribed or deactivated. Every row must obey the rules, and the same `SEED` must produce exactly the same rows every time. Also build `checkInvariants`, the consistency checker the seed, T18 and T20 all use.

## Files

Create: `src/invariants.ts`, `src/seed/seed.ts`, `src/seed/run.ts`. Change: `package.json` (`"seed": "tsx src/seed/run.ts"`; `@faker-js/faker` 10.6.0, pinned exactly, is already installed by the harness engineer).
Tests (written by harness engineer): `tests/db/invariants.test.ts`, `tests/db/seed.test.ts`.

## Part 1 — `src/invariants.ts`

```ts
import type { Queryable } from './clock';
export type Violation = { invariant: number; contactId: number | null; message: string };
export async function checkInvariants(db: Queryable, limit?: number): Promise<Violation[]>;   // [] = consistent; at most `limit` (default 50)
```

Pure SQL queries, one per invariant, read-only. The numbers match `spec/site.md` "Invariants", plus a 7th:

1. **Sends match the status.** A contact's `sends` steps are a prefix of `first, follow_up_1, follow_up_2, follow_up_3` (no gaps, no step twice). The count matches the status: `new` 0, `first_sent` 1, `follow_up_1_sent` 2, `follow_up_2_sent` 3, `follow_up_3_sent` 4, `deactivated` 4; `replied` 1–4; `bounced` 1–4; `unsubscribed` 0–4. No send follows a bounced send.
2. **Bounced.** Status `bounced` ⇔ the contact's last send has `outcome = 'bounced'` **and** a `suppression` row with reason `bounced` exists for its email.
3. **Unsubscribed.** Status `unsubscribed` ⇒ a `suppression` row with reason `unsubscribed` exists for its email.
4. **Next action.** In-sequence ⇔ `next_action` and `next_action_at` are both set. Terminal ⇔ both null. (The T08 CHECKs already enforce this; checked again so the report covers it.)
5. **Replies.** Every reply's `received_at` is after its send's `sent_at`, its send has `outcome = 'accepted'`, and `replies.contact_id = sends.contact_id`.
6. **Event replay.** For each contact, its `status_changed` events in `(occurred_at, id)` order form a chain: the first `from` is `new`, each `from` equals the previous `to`, and the last `to` equals the current status. A contact with no `status_changed` events has status `new`.
7. **Provider agrees.** Every `sends` row has a `mock_outbox` row with the same `idempotency_key` and the same `outcome`.

Each violation names the invariant number, the contact (or `null`) and a readable message.

## Part 2 — `src/seed/seed.ts`

```ts
import type pg from 'pg';
import type { Config } from '../config';
export const STATUS_MIX: Record<Status, number>;   // pinned below
export async function seed(pool: pg.Pool, config: Config): Promise<{ contacts: number }>;   // a pool, because it checks out one client for its transaction
```

### The pinned mix

| Status | Share |
|---|---|
| `new` | 60% |
| `first_sent` | 12% |
| `follow_up_1_sent` | 8% |
| `follow_up_2_sent` | 5% |
| `follow_up_3_sent` | 3% |
| `replied` | 5% |
| `bounced` | 2% |
| `unsubscribed` | 2% |
| `deactivated` | 3% |

Counts for `CONTACT_COUNT = n` are exact, by the largest-remainder method (so they always add up to `n`). For 10,000: 6000 / 1200 / 800 / 500 / 300 / 500 / 200 / 200 / 300. Which contact gets which status is decided by a seeded shuffle.

### Rules

- **Refuses to run on a non-empty database:** if `contacts` has any row, throw `database already seeded; run npm run db:reset first`.
- **One transaction** on one client from `pool.connect()` (`BEGIN` … `COMMIT`, `ROLLBACK` on any error). Either the whole seed lands or nothing does.
- **Deterministic.** `faker.seed(config.seed)` once at the start; every random choice (names, companies, statuses, dates) comes from that one Faker instance, drawn in a fixed order. No `Math.random`, no real clock. Rows are inserted in a fixed order so serial ids match between runs.
- **People.** `first_name`, `last_name` from Faker. Companies: a pool of `max(50, n / 12)` companies (`faker.company.name()`), each assigned one of the 5 industries, rotating through them in order so every industry has companies. Each contact picks a company. `role_family`: each of the 4 families for a quarter of contacts (seeded shuffle); `role` is a title from `ROLE_TITLES[family]`; `segment = segmentOf(family, industry)`. `timezone` from a fixed list of 8 IANA zones (`America/New_York`, `America/Chicago`, `America/Los_Angeles`, `Europe/London`, `Europe/Berlin`, `Asia/Kolkata`, `Asia/Singapore`, `Australia/Sydney`). `priority = false`.
- **Emails.** `<first>.<last>.<id>@<company-slug>.example`, lowercased, letters and digits only in each part (accents and punctuation stripped). Unique by the id. Always on `.example`.
- **History is made by the rulebook.** Each contact starts at `new` and is walked through `transition()` from `src/lifecycle.ts` until it reaches its target status. Every `transition` call writes a `status_changed` event (`{ from, to, reason }`). The engine's rules and the seed's rules can't disagree, because they're the same function.
  - **Sends** go out at 09:00 UTC plus a seeded 0–59 minutes, spaced by `WAIT_DAYS` (`nextActionAt`). Each send writes a `sends` row (`template_source = 'fallback'`, a short placeholder subject and body), a matching `mock_outbox` row, and a `sent` event.
  - **In-sequence contacts** (`first_sent` … `follow_up_3_sent`): the last send is placed so that `next_action_at = nextActionAt(lastStep, lastSent, waits)` falls between `SIM_START − 2 days` and `SIM_START + wait` for that step. About a third are already due at `SIM_START` (`next_action_at ≤ SIM_START`). Earlier sends are back-dated by the waits.
  - **`new` contacts**: `next_action = 'first'`, `next_action_at` in daily waves of 1,000: the first 1,000 (in id order) at `SIM_START`, the next 1,000 at `SIM_START + 1 day`, and so on.
  - **`replied`**: 1–4 accepted sends (seeded), then one reply 0.5–3 days after the last send, before `SIM_START`, labelled `interested` or `not_interested` (seeded, `true_label = label`, `label_source = 'ai'`, `classified_at = received_at`), a `reply_received` event, then `transition(…, reply)`.
  - **`unsubscribed`**: 1–4 accepted sends, then a reply labelled `unsubscribe` (`label_source = 'rule'`), a `suppression` row (`unsubscribed`, `added_at = received_at`), then `transition(…, reply: unsubscribe)`.
  - **`bounced`**: exactly one send, `first`, with `outcome = 'bounced'` (in both `sends` and `mock_outbox`), a `suppression` row (`bounced`, `added_at = sent_at`), then `transition('new', bounced)`.
  - **`deactivated`**: all 4 accepted sends, then `transition(…, deactivate_due)` at `nextActionAt('follow_up_3', …)`, which must be before `SIM_START`.
  - Every timestamp in the history is before `SIM_START`, except `next_action_at` for in-sequence contacts.
- **Clock.** Finally `setNow(db, config.simStart)`.
- **Speed.** Rows go in batched multi-row `INSERT`s (around 1,000 rows per statement) inside the one transaction; the full 10,000 must take under 30 seconds.

### `src/seed/run.ts` and `npm run seed`

Same shape as `src/db/reset.ts`: load `.env` if present, `loadConfig(process.env)`, `seed(getPool(databaseUrl), config)`, print `seeded <n> contacts`, then run `checkInvariants` and print `invariants: ok` or each violation (exit 1 if any), close the pool.

### A note for T19

Seeded replies happened before `SIM_START`. T19's classifier-accuracy figure counts only replies with `received_at ≥ SIM_START`, so the seed's labels don't inflate it.

## Edge cases (each one a test)

**`checkInvariants`** (on a small hand-built dataset, then broken one way at a time — each break must be reported with the right invariant number):
- A clean hand-built dataset (a `new`, a `first_sent` with its send and outbox row, a `bounced` with its suppression row) → `[]`.
- `first_sent` with no sends → 1. A `follow_up_1` send with no `first` → 1.
- `bounced` without a suppression row → 2. A suppression `bounced` row for a contact that isn't `bounced` → 2.
- `unsubscribed` without a suppression row → 3.
- A reply received before its send → 5. A reply to a bounced send → 5.
- A `status_changed` chain that ends at a different status than the contact's → 6. A `first_sent` contact with no events → 6.
- A send with no `mock_outbox` row, and one whose outbox outcome differs → 7.
- `limit` caps the number returned.

**`seed`** (with `CONTACT_COUNT = 1000` unless stated; `resetDb` before each test):
- Creates exactly `CONTACT_COUNT` contacts, and status counts match the largest-remainder split of `STATUS_MIX` (pinned tables for 1000, 13 and 10,000).
- `checkInvariants` returns `[]` afterwards.
- Same seed twice (reset in between) → identical rows in every table except `llm_*` and `schema_migrations` (compared by a hash of each table's rows ordered by primary key). A different seed → different contacts.
- A second `seed` without a reset → throws "already seeded", and the row counts don't change.
- All emails unique, on `.example`, matching `^[a-z0-9]+\.[a-z0-9]+\.[0-9]+@[a-z0-9-]+\.example$`.
- Every segment is `role_family:industry`, every role maps back to its family through `roleFamily`, and all 5 industries and 4 families appear.
- The clock reads `SIM_START`.
- Every history timestamp (`sends.sent_at`, `replies.received_at`, `suppression.added_at`, `events.occurred_at`) is before `SIM_START`.
- Some in-sequence contacts are due at `SIM_START` (`next_action_at ≤ SIM_START`) and some are not.
- `new` contacts: exactly `min(1000, count)` due at `SIM_START`, and none later than `SIM_START + ceil(new / 1000) − 1` days.
- `bounced` contacts have exactly one send, `first`, bounced.
- **10,000 contacts** (the real count) → finishes in under 30 seconds, and `checkInvariants` is `[]`.

## Tests that prove it

`tests/db/invariants.test.ts` and `tests/db/seed.test.ts`, against `TEST_DATABASE_URL`.

Expected failure before the build: `Cannot find module '../../src/invariants'` and `'../../src/seed/seed'`.

## Explain-back

1. Why is the seed's history produced by walking each contact through `transition()`, not by writing the statuses directly?
2. Why must the same seed produce identical rows, down to the ids?
3. Why does `checkInvariants` have its own tests that break the data on purpose?

## Done when

All tests pass, `npm run db:reset && npm run seed` prints `seeded 10000 contacts` and `invariants: ok`, `npm run typecheck` and `npm run format:check` are clean.
