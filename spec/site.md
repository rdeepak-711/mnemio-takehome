# Spec — Cold-email outreach engine (Mnemio take-home)

## Goal

A system that runs a 4-email cold sequence (first email + 3 follow-ups) for 10,000 seeded contacts on a simulated clock, never loses track of a contact, and never sends the same step to the same contact twice. Emails are written and replies classified by OpenRouter free models, designed to fit in about 50 AI calls a day, and a Next.js dashboard shows the campaign day by day.

## Out of scope

- Sending real email of any kind (no SMTP, no Gmail, no provider). The mail provider is a mock written in this repo.
- Login or auth on the dashboard (decision in `docs/decisions.md`).
- Real company enrichment (industry is assigned by the seed).
- Paid AI models or paid APIs.
- Deployment. The system runs locally from the README.

## Commands

Test command: `npm test`

Setup command: `npm install --no-audit --no-fund`

Database: `docker compose up -d db` starts Postgres 17 on port 5433 with two databases, `mnemio` (app) and `mnemio_test` (tests). Tests need it running.

Preview command: `npm run db:reset && npm run seed && npm run dev -- -p $PORT`

Preview pages: `/, /journey, /contacts`

CLI (built during the tasks below):

| Command | Does |
|---|---|
| `npm run db:reset` | Drop and re-create all tables from `src/db/migrations/*.sql` |
| `npm run seed` | Create 10,000 contacts with consistent history (fixed seed) |
| `npm run run` | One tick at the current simulated time |
| `npm run advance -- --days 7` | Move the clock forward day by day, running a tick each step |
| `npm run report` | Print the report |

## Stack

TypeScript (strict) on Node 22 · Postgres 17 via Docker Compose · `pg` with raw SQL (no ORM) · plain numbered `.sql` migrations · Vitest against a real Postgres test database · `zod` for config and AI output · `@faker-js/faker` for seed data · `openai` npm SDK pointed at `https://openrouter.ai/api/v1` · Next.js (App Router) for the dashboard in the same package · Anime.js for dashboard animation (version checked at T21) · `tsx` to run the CLI. Reasons for each are in `docs/decisions.md`.

## Files the builder may create or change

- `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `next.config.ts`, `docker-compose.yml`, `docker/`, `.env.example`, `.gitignore`
- `src/**` (engine, CLI, AI, mock provider, DB)
- `app/**`, `components/**`, `lib/web/**` (dashboard, T21 only)
- `tests/**` only when the task file says so (tests are written by the harness engineer first)
- `README.md` (T23 only)

Never: `.env` (secrets), `spec/**`, `tasks/**`, `docs/decisions.md` (harness engineer owns these).

## Environment variables (`.env.example`)

```
DATABASE_URL=postgres://mnemio:mnemio@localhost:5433/mnemio
TEST_DATABASE_URL=postgres://mnemio:mnemio@localhost:5433/mnemio_test
SEED=42
CONTACT_COUNT=10000
SIM_START=2026-11-02T09:00:00Z
WAIT_DAYS=3,5,7,7
BOUNCE_RATE=0.03
REPLY_RATE=0.08
REPLY_MIX=interested:0.30,not_interested:0.35,out_of_office:0.20,unsubscribe:0.15
OOO_DEFAULT_DAYS=7
SEND_BATCH_SIZE=200
OPENROUTER_API_KEY=
OPENROUTER_MODELS=
AI_RPM=20
DAILY_AI_BUDGET=45
```

The system must run end to end with `OPENROUTER_API_KEY` empty: every AI step falls back (hand-written templates, rule-only classification, `needs_review`). An evaluator without a key still gets a working run.

## Data model

All times are simulated time from `sim_clock`, except `llm_usage.day`, which is the real calendar day (OpenRouter counts real days).

```sql
contacts      id serial PK · first_name · last_name · email UNIQUE · company · industry · role · role_family · timezone
              · segment ('<role_family>:<industry>', e.g. 'founder:saas') · priority bool default false
              · status text CHECK in the 9 statuses
              · next_action text NULL CHECK in ('first','follow_up_1','follow_up_2','follow_up_3','deactivate')
              · next_action_at timestamptz NULL · created_at · updated_at
              INDEX on (next_action_at) WHERE next_action_at IS NOT NULL

sends         id · contact_id FK · step CHECK in ('first','follow_up_1','follow_up_2','follow_up_3')
              · idempotency_key text UNIQUE ("<contact_id>:<step>") · outcome ('accepted'|'bounced')
              · subject · body · template_source ('cache'|'ai'|'fallback') · sent_at
              UNIQUE (contact_id, step)                         ← the double-send guard

replies       id · contact_id FK · send_id FK · body · headers jsonb · received_at
              · true_label (mock ground truth, never read by the classifier)
              · label NULL ('interested'|'not_interested'|'out_of_office'|'unsubscribe'|'needs_review')
              · label_source NULL ('rule'|'ai'|'fallback') · return_date date NULL · classified_at NULL

suppression   email PK · reason ('unsubscribed'|'bounced') · added_at
              every insert is ON CONFLICT (email) DO NOTHING (first reason wins)

events        id bigserial · contact_id · type (one of the event types below) · data jsonb · occurred_at (sim time)   ← append-only; drives timeline + slider

sim_clock     id int PK CHECK (id = 1) · now timestamptz

mock_outbox   idempotency_key PK · outcome · received_at    ← the mock provider's own memory (written on its own connection)
mock_inbox    id · idempotency_key · body · headers jsonb · true_label · deliver_at · delivered bool   ← no FKs; the send is found via sends.idempotency_key (D31)

llm_cache     key PK · kind ('sequence'|'classification') · response jsonb · model · created_at
llm_usage     day date PK (real day) · calls int
```

### Event types (the only values of `events.type`)

| `type` | `data` | Written when |
|---|---|---|
| `status_changed` | `{ from, to, reason }` | every status change (`reason`: `sent`, `bounced`, `reply`, `unsubscribe`, `suppressed`, `deactivate_due`) |
| `sent` | `{ step, outcome, send_id }` | every provider call that produced a `sends` row |
| `reply_received` | `{ reply_id, label, label_source }` | a reply is classified |
| `rescheduled` | `{ from, to, cause: 'ooo' }` | an out-of-office reply moves `next_action_at` |

The seed writes the same events, with past timestamps, for the history it creates, so the slider shows a real day 0.

### Invariants (checked by T10 on the seed, T18 after a run, T20 after the 10k run)

1. A contact's `sends` are contiguous steps from `first`, at most 4, and match its status (`new` 0, `first_sent` 1, … `follow_up_3_sent` 4). `replied`, `unsubscribed`, `deactivated` have the sends they had when they left the sequence.
2. `bounced` ⇔ the contact's last send has `outcome = 'bounced'` and a suppression row with reason `bounced` exists.
3. `unsubscribed` ⇔ a suppression row exists, and the contact has a reply labelled `unsubscribe` or was suppressed before being claimed.
4. In-sequence ⇔ `next_action` and `next_action_at` are not null. Terminal ⇔ both are null.
5. Every reply's `received_at` is after its send's `sent_at`, and every reply belongs to an accepted send.
6. Replaying a contact's `status_changed` events in order ends at its current status.
7. Every send has a `mock_outbox` row with the same `idempotency_key` and outcome (added in T10, D38).

All seven are checked by `checkInvariants` in `src/invariants.ts`. Invariant 3 is checked one way (unsubscribed ⇒ suppression row), because a suppression row alone doesn't say which way the contact got there.

## Lifecycle rules

| From | Event | To | next_action |
|---|---|---|---|
| `new` | first email accepted | `first_sent` | `follow_up_1` at sent + A |
| `first_sent` | FU1 accepted | `follow_up_1_sent` | `follow_up_2` at sent + B |
| `follow_up_1_sent` | FU2 accepted | `follow_up_2_sent` | `follow_up_3` at sent + C |
| `follow_up_2_sent` | FU3 accepted | `follow_up_3_sent` | `deactivate` at sent + D |
| `follow_up_3_sent` | deactivate time reached | `deactivated` | none |
| any in-sequence | send bounced | `bounced` (+ suppression, reason bounced) | none |
| any in-sequence | reply: interested / not_interested / needs_review | `replied` | none |
| any state | reply: unsubscribe | `unsubscribed` (+ suppression) | none |
| any in-sequence | reply: out_of_office | unchanged | same action, moved to max(current due, return_date + 1 day or now + OOO_DEFAULT_DAYS) |
| `deactivated` | reply (non-unsubscribe, non-OOO) | `replied` | none |
| `replied` / `bounced` / `unsubscribed` | any reply | unchanged (reply recorded) except unsubscribe → `unsubscribed` | none |

Waits A, B, C, D come from `WAIT_DAYS`. D (after FU3, before deactivation) is not in the PDF's example and is added on purpose.

Before every send: the address must not be in `suppression`, the contact must still be in an in-sequence status, and its `next_action_at` must be ≤ now. A reply that arrives before a due send wins, because a tick processes replies before sends.

## One tick (`run`), in this order

1. Deliver due mock replies (`mock_inbox.deliver_at <= now`) into `replies`, joining `mock_inbox.idempotency_key` to `sends.idempotency_key` for `send_id` and `contact_id`. A due row with no matching `sends` row (its send was rolled back by a crash) stays undelivered and is picked up on a later tick, once the retried send has committed (D35).
2. Classify unlabelled replies: rules → cache → AI in batches of 25 → fallback `needs_review`. Apply each label's action (table above).
3. Deactivate contacts whose `next_action = 'deactivate'` is due.
4. Send, in batches. One transaction per batch:
   - Claim: `SELECT … FROM contacts WHERE status IN (in-sequence) AND next_action IN ('first','follow_up_1','follow_up_2','follow_up_3') AND next_action_at <= now ORDER BY next_action_at, id FOR UPDATE SKIP LOCKED LIMIT SEND_BATCH_SIZE`.
   - Per claimed contact: if the address is in `suppression`, apply `transition(status, { type: 'suppressed', reason })` (status becomes `bounced` or `unsubscribed`, no next action), append `status_changed` with reason `suppressed`, and don't send (D34). Otherwise render the email; if `checkContent` finds problems with an AI template, use the fallback template; if the fallback fails too, throw (it's a bug in a hand-written template, so the run stops loudly). Then call the mock provider with the idempotency key → insert `sends` (`ON CONFLICT DO NOTHING`) → update the contact through `transition` → append events.
   - Commit. Any other error rolls back the whole batch and is rethrown.
   - Repeat until a batch claims 0 contacts.

`advance --days N` sets `now += 1 day` and runs a tick, N times.

## Build order (bottom up — a layer starts only when the one below is green)

Each task has its own file `tasks/T0x-*.md`, written by the harness engineer with failing tests before the junior starts. Files for later layers are written when that layer starts, from this spec.

### Layer 0 — Skeleton

**T01 Repo skeleton.** `package.json` scripts `test` and `typecheck` only (each later task adds its own script), strict `tsconfig.json`, `vitest.config.ts` (DB test files run one at a time), `docker-compose.yml` (Postgres 17, port 5433, creates `mnemio` and `mnemio_test`), `.env.example`, `.gitignore`, `src/db/pool.ts` exporting `getPool(url)` and `closePool()`. Tests: `tests/unit/smoke.test.ts` (Vitest runs), `tests/db/connection.test.ts` (connects to `TEST_DATABASE_URL`, `SELECT 1`).

### Layer 1 — Pure logic (no DB, no network)

**T02 Config.** `src/config.ts` exports `loadConfig(env)` → typed config. Parses `WAIT_DAYS` into 4 positive integers, rates into 0–1 numbers, `REPLY_MIX` into a map that sums to 1 (±0.001). Edge cases: wrong count of waits, negative or zero wait, rate > 1, mix not summing to 1, unknown mix label, missing optional values get defaults. Bad input throws an error naming the variable.

**T03 State machine.** `src/lifecycle.ts` exports `STATUSES`, `type Status`, `IN_SEQUENCE`, `TERMINAL`, and `transition(status, event)` → `{ status, nextAction }`, where `event` is the `LifecycleEvent` union defined in `tasks/T03-lifecycle.md`. Encodes the lifecycle table exactly. Edge cases: sending a step out of order throws; any event on `unsubscribed` except a reply is rejected; unsubscribe from every state; OOO keeps status.

**T04 Schedule.** `src/schedule.ts` exports `nextActionAt(step, sentAt, waits)` and `oooReschedule(currentDue, now, returnDate | null, defaultDays)`. Edge cases: returnDate in the past; returnDate earlier than the current due date (keep the later); null returnDate uses the default; month and year rollover.

**T05 Template render + content check.** `src/templates/render.ts` exports `render(template, vars)` and `checkContent(text)`. `render` fills `{{slot}}` slots; an unknown slot throws. `checkContent` returns a list of problems: leftover `{{…}}`, empty subject, body over 1,200 characters, banned spam words from a small list. Edge cases: repeated slot, slot with spaces `{{ first_name }}`, no slots.

**T06 Segments.** `src/segments.ts` exports `roleFamily(title)` → `founder | sales | ops_finance | tech`, and `segmentOf(roleFamily, industry)`. Case-insensitive keyword rules; an unknown title maps to a defined default (`ops_finance`) and the test pins that choice. Exports `INDUSTRIES` (5) and `ROLE_FAMILIES` (4).

**T07 Rule classifier.** `src/classify/rules.ts` exports `classifyByRules({ body, headers })` → `{ label, returnDate } | null`. Out-of-office only when the `auto-submitted` header is present, or when the out-of-office phrase is present **and** the text doesn't negate it (the "Out of office? No, I'm here" case returns null). Unsubscribe phrases. `findReturnDate(text, now)` parses "until 3 Nov", "back on 2026-11-03", "returning Monday". Edge cases listed in the task file, each a test.

### Layer 2 — Database

**T08 Schema + migrations.** `src/db/migrations/001_init.sql` (the data model above), `src/db/migrate.ts` (`resetDb(pool)`, `migrate(pool)`), `npm run db:reset`. Tests: tables exist; inserting a second `sends` row for the same `(contact_id, step)` fails; invalid status is rejected by the CHECK.

**T09 Simulated clock.** `src/clock.ts`: `getNow(db)`, `setNow(db, t)`, `advance(db, days)`. No code outside this file may call `new Date()` for business time (a test greps `src/engine` and `src/mock` for `new Date()` and `Date.now()`).

**T10 Seed.** `src/seed/seed.ts` `seed(pool, config)`. 10,000 contacts, Faker seeded with `SEED`, emails on `.example` domains, unique. Weighted status mix (percentages pinned in `tasks/T10-seed.md`). History consistent with status (sends dated by the waits, replies after a send, suppression rows for unsubscribed and bounced, `next_action_at` set for in-sequence contacts, some already due at `SIM_START`), plus the matching `events`. Tests: same seed → identical rows (hash); every invariant in "Invariants" across all rows; runs in under 30 seconds.

**T11 Mock provider.** `src/mock/provider.ts` `send({ idempotencyKey, to, subject, body })` → `{ outcome }`. Every random choice for a send (bounce at `BOUNCE_RATE`, whether a reply comes, its label, delay and text) comes from `hash(SEED, idempotencyKey)`, not from a shared sequential RNG, so the result doesn't depend on which worker sends first. Records every key in `mock_outbox` on its own connection; a repeated key returns the first outcome and creates nothing new. On accept, may schedule a reply in `mock_inbox` (chance `REPLY_RATE`, label from `REPLY_MIX`, delay 0.5–3 days, OOO replies carry the header and a return date) from a bank of reply texts including deliberately ambiguous ones. Tests: rates within tolerance over 10,000 sends; same key twice → one outbox row; same seed + same keys sent in a shuffled order → identical outcomes.

### Layer 3 — Engine

**T12 Claim.** `src/engine/claim.ts` `claimDue(client, now, limit)` using `FOR UPDATE SKIP LOCKED`. Uses the claim query from "One tick" step 4. Tests: two concurrent transactions get disjoint sets; terminal contacts never returned; `next_action = 'deactivate'` never returned; not-yet-due never returned; a suppressed in-sequence contact *is* returned (the send step handles it).

**T13 Send step.** `src/engine/send.ts` `sendDue(db, now, deps)`: the per-contact transaction from "One tick" step 4. Tests: running it twice at the same time sends nothing new the second time; 4 parallel workers over 2,000 due contacts → exactly 2,000 sends, zero duplicates; a crash after the provider call and before commit, then a re-run → one `mock_outbox` row and one `sends` row; a suppressed address is skipped and its status changes through `transition`'s `suppressed` event; bounce → `bounced` + suppression. T13 also adds the `suppressed` event to `src/lifecycle.ts` (D34), with its own tests in `tests/unit/lifecycle.test.ts`. The mock provider gets its own `pg.Pool`, separate from the engine's (D43); test: more workers than the engine pool has connections still finishes, with no hang.

**T14 Reply processing.** `src/engine/replies.ts` `deliverReplies(db, now)` and `processReplies(db, now, classifier)`. Tests: each label's action from the lifecycle table; OOO moves the next send, doesn't stop it; a reply delivered at the same tick as a due follow-up stops the follow-up; a due `mock_inbox` row whose `idempotency_key` has no `sends` row is not delivered and stays `delivered = false`, and is delivered on the tick after that send commits (D35). T19's report counts mock replies still undelivered after their `deliver_at` with no matching send ("orphaned"); after a clean run it's 0.

**T15 Deactivation.** `src/engine/deactivate.ts`. Tests: due → `deactivated` with an event; not due → unchanged; OOO-pushed deactivation respected.

### Layer 4 — AI

**T16 OpenRouter client.** `src/ai/client.ts` (OpenAI SDK, `baseURL` OpenRouter, models from `OPENROUTER_MODELS` in order), `src/ai/limiter.ts` (calls spaced at least `60 / AI_RPM` seconds apart; daily count in `llm_usage`, refuse at `DAILY_AI_BUDGET`), `src/ai/cache.ts` (key = sha256 of kind + input + prompt version + model; input is the segment for sequences and the normalised reply body — lowercase, whitespace collapsed — for classifications). Retries: on 429/5xx/timeout, up to 2 retries with backoff 2s, 4s plus jitter, then next model, then fallback. Tests use a fake HTTP server, never the real API: 429 then success; all models fail → fallback; budget exhausted → no HTTP call made; cache hit → no HTTP call; invalid JSON → treated as failure. Picking the 2 free models from the live list happens here and is logged in `docs/decisions.md`.

**T17 Sequence writer + AI classifier.** `src/ai/sequences.ts` `getSequence(segment)`: cache → one AI call returns all 4 steps as JSON validated by zod (must contain the allowed slots only) → fallback hand-written sequence per role family in `src/templates/fallback.ts`. `src/ai/classify.ts` `classifyBatch(replies)`: cache lookup per reply first, then the uncached distinct bodies go to the AI up to 25 per call, zod-validated, a missing or invalid item becomes `needs_review`. Tests with the fake server.

### Layer 5 — Whole system

**T18 Tick + advance.** `src/engine/tick.ts` and the `run` / `advance` CLI. Tests: a 30-day advance on a 500-contact seed ends with every contact in a valid state; no contact has more than 4 sends; no step duplicated; re-running `run` at the same time is a no-op.

**T19 Report.** `src/report.ts` and `npm run report`: counts per status, sent today, due today, due tomorrow, reply rate (contacts with a reply ÷ contacts with an accepted send), bounce rate (bounced sends ÷ all sends), deactivated count, AI calls used today vs budget, template sources (cache/ai/fallback), classifier accuracy against `true_label` split by rule vs AI. Tests on a small fixed dataset with known answers.

**T20 Full 10k run.** `scripts/full-run.ts`: reset → seed 10,000 → advance until no contact is in sequence (or 60 days) → report, with wall-clock timings per phase. The real numbers go into the README. Test: the e2e invariants hold after the run.

### Layer 6 — Dashboard (spec in `spec/dashboard.md`)

**T21a Core dashboard.** Overview KPIs, funnel with a day slider (state on day D is computed from `events` up to D, never stored separately), contact journey that animates on advance, contact list with a detail timeline, simulation controls (advance 1 / 7 days, reset) that call the same engine functions through route handlers. Funnel details (Deepak, 23 Oct): days are labelled from Day 1 (= `SIM_START`); the funnel shows the three starting groups separately (seeded `new`, seeded part-way, seeded finished), and the finished group's line stays flat across all days; each stage shows people who moved on and people who dropped out there (reply, bounce, unsubscribe); clicking a stage opens a pop-up with 5 example contacts and their timelines. **T21b Extras** only if time: classifier view, activity log page, extra charts.

### Layer 7 — Bonus and delivery

**T22 Bonus** (only after T20 is green): mailboxes with ramping daily limits and auto-pause on bounce rate, sending windows by prospect timezone, per-domain caps, `List-Unsubscribe` header and unsubscribe link in rendered emails.

**T23 README.** The 7 sections the PDF asks for, measured numbers from T20, and a clean-clone run-through that was actually done.

## Done means

- `npm test` green, `npm run typecheck` clean.
- On a fresh clone: `docker compose up -d db`, `npm install`, `npm run db:reset`, `npm run seed`, `npm run advance -- --days 30`, `npm run report` all work, with and without an OpenRouter key.
- Zero duplicate `(contact_id, step)` rows after any sequence of runs, including parallel workers and a simulated crash.
- Every contact is in exactly one of the 9 statuses with history that matches it.
- README contains the measured 10k run time and final counts.
