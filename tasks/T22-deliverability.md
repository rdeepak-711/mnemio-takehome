# T22 — Deliverability bonus

## Goal

The brief's bonus list, on the engine: mailboxes with a daily warm-up limit and auto-pause on bounce rate, send windows in the prospect's timezone, a per-domain daily cap, and `List-Unsubscribe` headers with an unsubscribe link. All of it sits behind `DELIVERABILITY` (on by default). With it off, the engine behaves exactly as before T22. Decisions: D64 (the switch), D65 (hourly ticks), D66 (mailboxes and warm-up), D67 (auto-pause), D68 (send windows), D69 (domain cap), D70 (List-Unsubscribe). Read all seven before starting.

## Files

Create:
- `src/db/migrations/003_deliverability.sql`
- `src/delivery/rules.ts` (pure, no DB)
- `src/delivery/mailboxes.ts` (DB helpers used by the send step)
- `src/delivery/report.ts`

Change:
- `src/config.ts`: `Delivery`, `Config.delivery`.
- `src/clock.ts`: `advanceHours`.
- `src/engine/claim.ts`: the optional filter, `mailboxId` on `ClaimedContact`.
- `src/engine/send.ts`: the deliverability path.
- `src/engine/tick.ts`: hourly ticks when deliverability is on.
- `src/mock/provider.ts`: `SendInput` gains `from?` and `headers?` (the mock ignores both).
- `src/invariants.ts`: invariants 8–12.
- `src/full-run.ts`, `src/main.ts`, `src/web/sim.ts`: pass the config to `checkInvariants`. `npm run report` prints the deliverability block.
- `.env.example`: the nine new variables, with the values from `spec/site.md`.

Tests (written by the harness engineer, do not edit):
- `tests/unit/delivery-rules.test.ts`
- `tests/unit/config.test.ts` (new cases)
- `tests/db/clock.test.ts` (`advanceHours`)
- `tests/db/delivery-send.test.ts`
- `tests/db/delivery-invariants.test.ts`
- `tests/db/delivery-tick.test.ts`

The core engine tests (`send`, `tick`, `replies`, `full-run`, `ai-prompts`) now set `DELIVERABILITY=off` (D64) and must stay green unchanged. `web-sim` and `cli-run` run with it on.

No new dependency. No dashboard or README changes in this task.

## Part 1 — config (D64)

```ts
export type Delivery = {
  mailboxCount: number;                               // MAILBOX_COUNT, integer 1–1000, default 50
  warmup: { start: number; step: number; max: number }; // WARMUP_START ≥ 1 (20), WARMUP_STEP ≥ 0 (10), WARMUP_MAX ≥ 1 (80)
  pauseBounceRate: number;                            // PAUSE_BOUNCE_RATE, rate 0–1, default 0.10
  pauseDays: number;                                  // PAUSE_DAYS, integer ≥ 1, default 3
  sendWindow: { startHour: number; endHour: number }; // SEND_WINDOW "H-H", default "9-17"
  domainDailyCap: number;                             // DOMAIN_DAILY_CAP, integer ≥ 1, default 10
};
// Config gains: delivery: Delivery | null
```

- `DELIVERABILITY`: trimmed, case-insensitive `on` or `off`; empty or unset means `on`; anything else throws naming `DELIVERABILITY`.
- The eight settings are parsed and validated even when it is off; `delivery` is then `null`.
- `WARMUP_START > WARMUP_MAX` throws naming `WARMUP_START`.
- `SEND_WINDOW`: two whole numbers joined by `-`, spaces allowed around each (`' 0 - 24 '` is valid), with `0 ≤ start < end ≤ 24`. Anything else throws naming `SEND_WINDOW`.
- Use the existing `int`, `rate`, `check` and `read` helpers so the messages look like the other variables'.

## Part 2 — `src/delivery/rules.ts` (pure)

```ts
export const PAUSE_SAMPLE = 100;
export const PAUSE_MIN_SENDS = 50;
export const UNSUBSCRIBE_MAILTO = 'unsubscribe@mnemio.example';
export const UNSUBSCRIBE_BASE_URL = 'https://mnemio.example/unsubscribe';

export function warmupLimit(ageDays: number, warmup: Delivery['warmup']): number;
export function inSendWindow(at: Date, timeZone: string, window: Delivery['sendWindow']): boolean;
export function shouldPause(sample: { sends: number; bounced: number }, rate: number): boolean;
export function mailboxAddress(id: number): string;
export function recipientDomain(email: string): string;
export function unsubscribeToken(seed: number, contactId: number): string;
export function unsubscribeLink(seed: number, contactId: number): string;
export function unsubscribeHeaders(seed: number, contactId: number): {
  'List-Unsubscribe': string;
  'List-Unsubscribe-Post': string;
};
export function withUnsubscribeFooter(body: string, link: string): string;
```

- `warmupLimit`: a non-integer `ageDays` throws naming `ageDays`. Negative gives 0. Otherwise `min(max, start + step × ageDays)`.
- `inSendWindow`: true when, in `timeZone`, the weekday is Monday to Friday and `startHour ≤ hour < endHour`. Read the weekday and the hour with `Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' })` and `formatToParts`. Never call `new Date()` without arguments.
- `shouldPause`: `sends >= PAUSE_MIN_SENDS && bounced / sends > rate`.
- `mailboxAddress(id)`: `outreach-<id, at least 2 digits>@mail<((id - 1) % 5) + 1>.mnemio.example`. An `id` that isn't an integer ≥ 1 throws naming `id`.
- `recipientDomain`: the text after the last `@`, lower-cased. An email with no `@`, or nothing after it, throws naming `email`.
- `unsubscribeToken`: `createHash('sha256').update(\`unsubscribe:${seed}:${contactId}\`).digest('hex').slice(0, 16)`.
- `unsubscribeLink`: `${UNSUBSCRIBE_BASE_URL}/${contactId}/${token}`.
- `unsubscribeHeaders`:
  - `'List-Unsubscribe'`: `<mailto:${UNSUBSCRIBE_MAILTO}?subject=unsubscribe%20${contactId}-${token}>, <${link}>`
  - `'List-Unsubscribe-Post'`: `'List-Unsubscribe=One-Click'`
- `withUnsubscribeFooter`: `${body.trimEnd()}\n\n--\nNot interested? Unsubscribe here: ${link}`.

## Part 3 — migration `003_deliverability.sql`

```sql
CREATE TABLE mailboxes (
  id int PRIMARY KEY,
  address text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,          -- sim time of creation = the first warm-up start
  warmup_started_at timestamptz NOT NULL,   -- moves to resume_at at each pause (D67)
  paused_until timestamptz NULL
);

CREATE TABLE mailbox_pauses (
  id serial PRIMARY KEY,
  mailbox_id int NOT NULL REFERENCES mailboxes (id),
  paused_at timestamptz NOT NULL,
  resume_at timestamptz NOT NULL,
  bounce_rate real NOT NULL,
  sample int NOT NULL
);

ALTER TABLE contacts ADD COLUMN mailbox_id int NULL REFERENCES mailboxes (id);

ALTER TABLE sends
  ADD COLUMN mailbox_id int NULL REFERENCES mailboxes (id),
  ADD COLUMN recipient_domain text NULL,
  ADD COLUMN headers jsonb NOT NULL DEFAULT '{}';

CREATE INDEX sends_mailbox_day_idx ON sends (mailbox_id, sent_at) WHERE mailbox_id IS NOT NULL;
CREATE INDEX sends_domain_day_idx ON sends (recipient_domain, sent_at) WHERE mailbox_id IS NOT NULL;
```

The seed doesn't change. Seeded history keeps `mailbox_id`, `recipient_domain` = NULL and `headers` = `{}`.

## Part 4 — clock and claim

`src/clock.ts`:

```ts
export async function advanceHours(db: Queryable, hours: number): Promise<Date>;
```

It works like `advance`, but uses `make_interval(hours => $1)`. A non-integer or `< 1` throws naming `hours` before any query. An unset clock gives the same "not set" error.

`src/engine/claim.ts`:

```ts
export type ClaimFilter = {
  mailboxId?: number;                      // only contacts whose mailbox_id is NULL or this
  window?: Delivery['sendWindow'];         // only contacts inside their local window at `now` (D68)
  skip?: number[];                         // contact ids to leave out
};
export async function claimDue(client: pg.PoolClient, now: Date, limit: number, filter?: ClaimFilter): Promise<ClaimedContact[]>;
// ClaimedContact gains mailboxId: number | null
```

- Add each condition only when it is given, so the query with no filter is the T12 query.
- The window condition is:

  ```sql
  extract(isodow FROM ($1::timestamptz AT TIME ZONE timezone)) <= 5
  AND extract(hour FROM ($1::timestamptz AT TIME ZONE timezone)) >= <start>
  AND extract(hour FROM ($1::timestamptz AT TIME ZONE timezone)) < <end>
  ```

- `ORDER BY next_action_at, id` and `FOR UPDATE SKIP LOCKED` stay as they are.

## Part 5 — the send step with `config.delivery` set

`SendDeps.config` becomes `Pick<Config, 'waitDays' | 'sendBatchSize'> & { delivery?: Delivery | null; seed?: number }`. If `delivery` is set but `seed` is missing, throw naming `seed`. When `delivery` is null or absent, run today's code path unchanged.

With delivery on, `sendDue(pool, now, deps)` does the following:

1. **`ensureMailboxes(pool, now, delivery.mailboxCount)`**, every call, before anything else. It runs `INSERT INTO mailboxes (id, address, created_at, warmup_started_at) SELECT g, <mailboxAddress(g)>, $now, $now FROM generate_series(1, $count) g ON CONFLICT (id) DO NOTHING`. Build the addresses in TS and pass them as an array. If Postgres says the table is missing (error code `42P01`), throw: `mailboxes table is missing (migration 003); run npm run db:reset && npm run seed`.
2. **Loop, one transaction per batch.** Keep two lists across the whole call: `tried` (mailbox ids) and `skip` (contact ids).
   - **Lock one mailbox.** Lock the first mailbox that is usable and has due work:

     ```sql
     SELECT m.id, m.address, m.warmup_started_at, m.paused_until FROM mailboxes m
      WHERE m.id <= $count AND (m.paused_until IS NULL OR m.paused_until <= $now)
        AND NOT (m.id = ANY($tried))
        AND EXISTS (SELECT 1 FROM contacts c WHERE <the claim's due + window conditions>
                      AND (c.mailbox_id IS NULL OR c.mailbox_id = m.id) AND NOT (c.id = ANY($skip)))
      ORDER BY m.id FOR UPDATE OF m SKIP LOCKED LIMIT 1
     ```

     If no row comes back, COMMIT and return.
   - **Resume a finished pause.** If `paused_until` is set and `≤ now`, set it to NULL.
   - **Work out today's capacity.** `capacity = warmupLimit(age, warmup) − sentToday`.
     - `age` is the whole UTC days from the date of `warmup_started_at` to the date of `now`. Compute it in SQL: `(($now AT TIME ZONE 'UTC')::date - (warmup_started_at AT TIME ZONE 'UTC')::date)`.
     - `sentToday` is that mailbox's `sends` rows whose `sent_at` falls on now's UTC day.
     - If `capacity ≤ 0`, push the mailbox to `tried`, COMMIT, and continue.
   - **Claim.** Call `claimDue(client, now, min(sendBatchSize, capacity), { mailboxId, window, skip })`. If it returns nothing, push the mailbox to `tried`, COMMIT, and continue.
   - **Handle each claimed contact in order:**
     - **Suppressed address:** same as today (no mailbox use).
     - **Domain gate (D69):**
       - Take `SELECT pg_try_advisory_xact_lock(hashtext('mnemio:domain:' || $domain))`.
       - If it returns false, push the contact to `skip` and go to the next contact.
       - Count today's engine sends to that domain: `recipient_domain = $domain AND mailbox_id IS NOT NULL`, on now's UTC day. If the count is already `≥ domainDailyCap`, push the contact to `skip` and go to the next contact.
     - **Write the email** as today (AI template or fallback, `checkContent` on the template text). Then:
       - `body = withUnsubscribeFooter(body, unsubscribeLink(seed, id))`
       - `headers = unsubscribeHeaders(seed, id)`
     - **Send.** Call `provider.send({ idempotencyKey, to, subject, body, now, from: mailbox.address, headers })`.
     - **Record it.**
       - Insert the `sends` row with `mailbox_id`, `recipient_domain` and `headers` (JSON).
       - Set `contacts.mailbox_id = COALESCE(mailbox_id, $mailbox)`, in the same UPDATE as the status change or a separate one.
       - Write the events exactly as today.
     - **On a bounce, check for a pause (D67).**
       - Read the mailbox's last `PAUSE_SAMPLE` sends with `sent_at >= warmup_started_at`, ordered by `sent_at DESC, id DESC`. They include this transaction's own rows.
       - If `shouldPause({ sends, bounced }, pauseBounceRate)`:
         - `UPDATE mailboxes SET paused_until = now + pauseDays, warmup_started_at = now + pauseDays`
         - insert `mailbox_pauses (mailbox_id, paused_at = now, resume_at = now + pauseDays, bounce_rate = bounced / sends, sample = sends)`
         - stop handling this batch: the remaining claimed contacts are left as they are and stay due.
   - COMMIT.
   - Errors roll back the batch and rethrow, as today.
3. `SendSummary` keeps its shape. `sent`, `bounced` and `suppressed` count as today, and a skipped contact counts in none of them.

Keep the per-mailbox and per-domain SQL in `src/delivery/mailboxes.ts`. Keep `handle()` readable: one helper for the domain gate and one for the pause check.

## Part 6 — hourly ticks (D65)

`advanceDays(deps, days, onDay)`, when `deps.config.delivery` is set: for each day, run 24 times `advanceHours(pool, 1)` then `runTick(deps)`, then call `onDay` once with the day's summary, and push it. The day's summary is:
- `now`: the last tick's `now`;
- `delivered`, `deactivated`: summed;
- `labelled.*`: summed;
- `sent.*`: summed, `batches` included.

When `delivery` is null, today's loop runs unchanged (`advance(pool, 1)` + one tick). `runTick` itself does not change.

## Part 7 — invariants 8–12

```ts
export async function checkInvariants(
  db: Queryable,
  limit = 50,
  config?: Pick<Config, 'delivery' | 'seed'>,
): Promise<Violation[]>;
```

Run 8–12 only when `config?.delivery` is set, after 1–7, within the same `limit`. "Engine send" means `sends.mailbox_id IS NOT NULL`. UTC day means `(sent_at AT TIME ZONE 'UTC')::date`.

| # | Violation when | `contactId` | Message must name |
|---|---|---|---|
| 8 | For a (mailbox, UTC day), the count of engine sends is above `LEAST(max, start + step × age)`. Here `age` = day − the UTC date of the effective warm-up start. The effective start is `GREATEST(mailboxes.created_at, the latest mailbox_pauses.resume_at whose UTC date ≤ day)`. | null | the mailbox address and the day |
| 9 | For a (recipient_domain, UTC day), the count of engine sends is above `domainDailyCap`. | null | the domain and the day |
| 10 | An engine send whose `sent_at`, in its contact's timezone, is outside the window. Use the same SQL condition as the claim. | the contact | the send's idempotency key |
| 11 | An engine send with a pause on its mailbox where `paused_at < sent_at < resume_at` (strict on both sides). | the contact | the idempotency key |
| 12 | An engine send whose `headers->>'List-Unsubscribe'` or `headers->>'List-Unsubscribe-Post'` differs from `unsubscribeHeaders(seed, contact_id)`, or whose body doesn't end with `unsubscribeLink(seed, contact_id)`. | the contact | the idempotency key |

For 12, compute the expected values in SQL with `left(encode(sha256(convert_to('unsubscribe:' || $seed || ':' || s.contact_id, 'UTF8')), 'hex'), 16)`. The rules test pins that this equals the TS token.

The callers pass the config:
- `fullRun` passes `config`.
- `main.ts` (`run`, `advance`) passes `config` wherever it checks invariants.
- `src/web/sim.ts` passes `deps.config`.

## Part 8 — `src/delivery/report.ts` and `npm run report`

```ts
export type DeliveryReport = {
  mailboxes: number;      // rows in mailboxes with id ≤ mailboxCount
  pausedNow: number;      // paused_until > now
  pauses: number;         // rows in mailbox_pauses
  sentToday: number;      // engine sends on now's UTC day
  capacityToday: number;  // sum of warmupLimit(age today) over mailboxes not paused now
  busiestDomainToday: { domain: string; sent: number } | null;
};
export async function deliveryReport(db: Queryable, now: Date, delivery: Delivery): Promise<DeliveryReport>;
export function formatDelivery(r: DeliveryReport, delivery: Delivery): string;
```

`formatDelivery` gives exactly these lines:

```
Deliverability
  mailboxes: 4 (1 paused now, 1 pause so far)          ← "pauses so far" when not 1
  engine sends today: 57 of 90 capacity
  busiest domain today: acme.example (7 of cap 10)     ← "busiest domain today: none" when null
  send window: 9:00–17:00 local, Monday to Friday
```

`npm run report` prints it after the existing report, with a blank line between them, when `config.delivery` is set.

## Rules

- No `new Date()` without arguments and no `Date.now()` in `src/` outside `src/ai/` (the existing test checks `src/delivery/` too).
- Every number in SQL is a parameter. No string-built SQL from contact data.
- The `delivery` path must keep the T13 guarantees:
  - one `sends` row per (contact, step);
  - a crash after the provider call and before commit still leaves one outbox row;
  - parallel workers never send the same contact.
- Run `npm test`, `npm run typecheck` and `npx prettier --check .` before reporting.

## Done when

- All tests above pass, every existing test is still green, typecheck and format are clean.
- `npm run advance -- --days 3` against a scratch database you seeded yourself (not the `.env` one) prints daily summaries.
- `npm run report` there ends with the Deliverability block.

## Explain-back questions (for Deepak, after review)

1. At 09:00 UTC, why can a contact in Los Angeles never be emailed if the clock moves one day at a time, and what did we change so that it can?
2. Two workers send at the same time. Why can't they both use the last 5 sends of mailbox 3 today, and why can't they deadlock over a domain?
3. A mailbox pauses after 50 bounced sends. Three days later it starts again. Why doesn't its next bounce pause it straight away?
