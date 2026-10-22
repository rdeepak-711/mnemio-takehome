# Execution flow

**Status: PLANNED, partly built.** T01 (DB pool), T02 (config), T03 (lifecycle), T04 (schedule), T05 (render), T06 (segments) and T07 (rules) exist, so Layer 1 (pure logic) is complete; T08 (schema and migrations) and T09 (simulated clock) have started Layer 2; everything else is still planned. This is the intended flow from `spec/site.md`. Each task updates the section it touches from "planned" to "built", with real line references.

## Entry points

| Entry | File | Calls |
|---|---|---|
| `npm run db:reset` | `src/db/reset.ts` (BUILT T08; moves under `src/cli.ts` in T18 if that's simpler) → `src/db/migrate.ts` `resetDb()` | `DROP SCHEMA public CASCADE`, then `migrate()` runs `src/db/migrations/*.sql` in file-name order |
| `npm run seed` | `src/cli.ts` → `src/seed/seed.ts` `seed()` | `loadConfig()`, Faker, `roleFamily()`, `segmentOf()`, `nextActionAt()`, `setNow()` |
| `npm run run` | `src/cli.ts` → `src/engine/tick.ts` `tick()` | the four tick steps below |
| `npm run advance -- --days N` | `src/cli.ts` → `src/clock.ts` `advance()` + `tick()` N times | |
| `npm run report` | `src/cli.ts` → `src/report.ts` `report()` | read-only SQL |
| Dashboard | `app/**` route handlers `app/api/*/route.ts` | the same `tick()`, `advance()`, `report()` and query functions |

## Startup: settings and the database (built in T01, T02)

Every CLI command and the dashboard will start the same way. Nothing calls these yet; the CLI arrives in T18.

```
cli command (planned, T18)
 ├─ loadConfig(process.env)                      src/config.ts:81       (pure)
 │    ├─ DATABASE_URL required                    src/config.ts:82       throws if missing
 │    ├─ SIM_START must be ISO with a zone        src/config.ts:85-89    regex ISO_WITH_ZONE :34
 │    └─ every other variable:
 │         read(env, NAME, default)              src/config.ts:53       empty or spaces → default
 │         check(NAME, rule, text)               src/config.ts:44       rules: int() :25, rate :36
 │         parseWaitDays / parseReplyMix         src/config.ts:58, :65  REPLY_LABELS from src/labels.ts
 │    → Config object, or an Error naming the bad variable
 └─ getPool(config.databaseUrl)                  src/db/pool.ts:6       [DB] one cached pg.Pool per URL
      ... work ...
    closePool()                                  src/db/pool.ts:17      ends every pool so the process exits
```

Tests call these directly: `tests/unit/config.test.ts` passes made-up env objects to `loadConfig` (it never reads `.env`), and `tests/db/connection.test.ts` uses `getPool(TEST_DATABASE_URL)`. `vitest.config.ts` loads `.env` if present and defaults `TEST_DATABASE_URL`.

## One tick: `src/engine/tick.ts` `tick(db, deps)`

```
tick
 ├─ getNow(db)                                   src/clock.ts:8         [DB] (BUILT T09)
 ├─ deliverReplies(db, now)                      src/engine/replies.ts  [DB]  mock_inbox → replies
 ├─ processReplies(db, now, classifier)          src/engine/replies.ts
 │    ├─ classifyByRules(reply, now)             src/classify/rules.ts:79 (pure, BUILT T07)
 │    ├─ classifyBatch(unclear[])                src/ai/classify.ts     [NETWORK: OpenRouter]
 │    │    ├─ cache.get / cache.set              src/ai/cache.ts        [DB]
 │    │    ├─ limiter.acquire                    src/ai/limiter.ts      [DB: llm_usage]
 │    │    └─ client.chat (retry → next model → fallback)  src/ai/client.ts
 │    └─ apply label → transition(status, event) src/lifecycle.ts       (pure)
 │                     oooReschedule(...)        src/schedule.ts:22     (pure, BUILT T04)
 ├─ deactivateDue(db, now)                       src/engine/deactivate.ts [DB]
 └─ sendDue(db, now, deps)  (loop until none due) src/engine/send.ts
      └─ per batch, ONE TRANSACTION:
           claimDue(client, now, limit)          src/engine/claim.ts    [DB: FOR UPDATE SKIP LOCKED]
           for each contact:
             suppression check                   [DB]
             getSequence(segment)                src/ai/sequences.ts    [cache / NETWORK / fallback]
             render(template, vars)              src/templates/render.ts:22 (pure, BUILT T05)
             checkContent(email)                 src/templates/render.ts:36 (pure, BUILT T05)
             provider.send({idempotencyKey,…})   src/mock/provider.ts   [BOUNDARY: own DB connection = "external"]
             INSERT sends ON CONFLICT DO NOTHING [DB: UNIQUE (contact_id, step)]
             transition(status, sent:<step>)     src/lifecycle.ts:105   (pure, BUILT T03; throws InvalidTransitionError)
             nextActionAt(step, sentAt, waits)   src/schedule.ts:17     (pure, BUILT T04)
             UPDATE contacts; INSERT events      [DB]
           COMMIT
```

## Boundaries

- **Network:** only `src/ai/client.ts` talks to the outside world (OpenRouter). Tests replace it with a fake HTTP server.
- **"External" provider:** `src/mock/provider.ts` writes to `mock_outbox` on its own connection, outside the send transaction, so it behaves like a third-party API that has already happened when our transaction rolls back. That's what the crash test (T13) relies on.
- **Time:** only `src/clock.ts` decides what "now" is. `llm_usage` is the single place that uses real time (OpenRouter counts real days).
- **No auth, no tenants.** Single local user.

## Touched so far

- **T01:** `src/db/pool.ts` (`getPool`, `closePool`), `vitest.config.ts`, Docker Postgres on `localhost:5433` (databases `mnemio` and `mnemio_test`).
- **T02:** `src/labels.ts`, `src/config.ts` (`loadConfig`). Pure logic, no boundary crossed. Not yet called from anywhere except tests.
- **T03:** `src/lifecycle.ts`: `transition` (:105) switches on the event; replies go to `applyReply` (:84); `expectedStep` (:62) reads the `EXPECTED_STEP` table (:42); a valid send copies its row from `AFTER_SENT` (:55). Imports only `./labels`. Planned callers: `src/engine/send.ts` (T13) after each send, `src/engine/replies.ts` (T14) after a reply is labelled, `src/engine/deactivate.ts` (T15). Not called from anywhere except tests yet.
- **T04:** `src/schedule.ts`: `nextActionAt` (:17) picks the wait for the step from `WAIT_INDEX` (:6) and adds it with `addDays` (:13); `oooReschedule` (:22) picks `returnDate + 1 day` if that's after `now`, else `now + defaultDays`, then takes the later of that and the current due date. Imports only `type Step`. Never reads the real clock (a test checks the source). Planned callers: `src/engine/send.ts` (T13) after a send, `src/engine/replies.ts` (T14) for out-of-office. Not called from anywhere except tests yet.
- **T05:** `src/templates/render.ts`: `render` (:22) fills `{{slot}}`s in one `replace` pass using `SLOT_PATTERN` (:12), throwing on an unknown slot or an empty value; `findSlots` (:31) lists slot names; `checkContent` (:36) returns every problem (leftover braces, empty or long subject, long body, spam words via `SPAM_PATTERNS` :19). Imports only `escapeRegExp` from `src/regex.ts`. Planned callers: `src/engine/send.ts` (T13) renders then checks each email before `provider.send`; `src/ai/sequences.ts` (T17) uses `findSlots` + `checkContent` to vet AI-written templates. Not called from anywhere except tests yet.
- **T06:** `src/segments.ts`: `roleFamily` (:45) tries each rule in `RULES` (:32) in order via the regexes in `PATTERNS` (:40), defaulting to `ops_finance`; `segmentOf` (:50) builds `'<family>:<industry>'`; `allSegments` (:54) lists all 20; `ROLE_TITLES` (:8) is the pool the seed draws from. Imports only `escapeRegExp` from `src/regex.ts`. Planned callers: `src/seed/seed.ts` (T10) sets each contact's `role_family` and `segment`; `src/ai/sequences.ts` (T17) asks the AI for one sequence per segment. Not called from anywhere except tests yet.
- **T07:** `src/classify/rules.ts`: `classifyByRules` (:79) normalises apostrophes (`normalise` :31), then checks `headerIsAuto` (:35), the unsubscribe and negation patterns, then the out-of-office phrase and denials; returns `null` for anything else. `findReturnDate` (:67) runs one combined `RETURN_DATE` regex (:16) and validates every date with `utcDate` (:41). No imports. Planned caller: `src/engine/replies.ts` (T14) `processReplies` tries the rules first and sends only the `null`s to `classifyBatch` (T17). Not called from anywhere except tests yet.
- **T08:** `src/db/migrations/001_init.sql` creates the 11 tables; the constraints are the second line of defence (D32): `sends_contact_id_step_key` is the double-send guard, `contacts_status_next_action_check` refuses a status with the wrong next action. `src/db/migrate.ts` `migrate` (:12) applies each unrecorded `.sql` file in its own transaction together with its `schema_migrations` row; `resetDb` (:43) drops the schema and calls `migrate`. `src/db/reset.ts` is the `npm run db:reset` entry: `.env` → `loadConfig` → `getPool` → `resetDb` → `closePool` [DB]. The mock tables (`mock_outbox`, `mock_inbox`) have no foreign keys and key everything by `idempotency_key` (D31): they belong to the "outside service", not to us. Planned callers of `resetDb`: every DB test's `beforeEach`, and T10's seed.
- **T09:** `src/clock.ts`: `getNow` (:8) reads the one `sim_clock` row and throws `sim_clock is not set; run npm run seed` if it's missing; `setNow` (:15) upserts it; `advance` (:22) moves it forward in a single `UPDATE … RETURNING` so simultaneous calls can't lose a day. All take a `Queryable` (a pool or a transaction's client) [DB]. `tests/unit/no-real-clock.test.ts` fails if any file under `src/` outside `src/ai/` reads the real clock. Planned callers: the seed (T10) calls `setNow(SIM_START)`, every tick (T18) starts with `getNow`, and the `advance` CLI loops `advance(1)` + tick.
- **T10:** `npm run seed` → `src/seed/run.ts`: `.env` → `loadConfig` → `getPool` → `seed` → `checkInvariants` → print → `closePool`. `src/seed/seed.ts` `seed` (:324) takes one client from the pool and, inside `BEGIN … COMMIT` [DB]: refuses if `contacts` has a row; `reserveIds` (:235) takes the next N contact ids from the sequence; `plan` (:245) does every random draw from one Faker seeded with `SEED` (companies, the status shuffle from `statusCounts` :78, the role-family shuffle, then per contact name, company, role, timezone and `planHistory` :113); `planHistory` walks the contact from `new` through `transition()` (`src/lifecycle.ts:105`), dating sends with `nextActionAt` (`src/schedule.ts:17`); then send and reply ids are reserved, rows are built in memory and written by `insertRows` (:219) in batches of 1,000 (contacts, sends, mock_outbox, replies, suppression, events); finally `setNow(SIM_START)` (`src/clock.ts`). Any error → `ROLLBACK`, nothing kept. `src/invariants.ts` `checkInvariants` (:138) runs seven read-only queries in order and stops at `limit` violations. Planned callers of `checkInvariants`: T18 after a run, T20 after the full 10k run.
- **T11:** `src/mock/provider.ts` `createProvider(pool, config)` returns `send({ idempotencyKey, to, subject, body, now })`. Each send: `draw(seed, 'bounce', to)` decides the outcome, then on its own client from the pool [BOUNDARY: own connection = "outside service"] `BEGIN` → `INSERT mock_outbox … ON CONFLICT DO NOTHING RETURNING` → if nothing inserted, `SELECT` the stored outcome, `COMMIT`, return it → else, if accepted, `planReply` decides reply / label / text / delay / OOO header and return date, each from its own `draw` keyed by the idempotency key, and `INSERT mock_inbox` → `COMMIT`. A reply to `follow_up_3` is late 10% of the time (`LATE_REPLY_SHARE`): it arrives `waitDays[3] + 1` to `+ 14` days later, after deactivation (D44). `src/mock/replies.ts` holds `draw` (SHA-256 → [0, 1)), `REPLY_BANK` and `formatReturnDate`. Planned callers: `src/engine/send.ts` (T13) calls `send` between claiming a contact and inserting `sends`, with the provider on its own pool (D43); `src/engine/replies.ts` (T14) `deliverReplies` reads due `mock_inbox` rows into `replies`.
- **T12:** `src/engine/claim.ts` `claimDue(client, now, limit)` (:38) runs `CLAIM_SQL` (:23) on the caller's client inside the caller's transaction [DB]: in-sequence status, a sending `next_action`, `next_action_at <= now`, `ORDER BY next_action_at, id LIMIT limit FOR UPDATE SKIP LOCKED`. Locked rows stay locked until that transaction ends; other workers' claims skip them. Uses the partial index `contacts_next_action_at_idx` (1.6 ms for a batch of 200 on the 10,000 seed). Planned caller: `src/engine/send.ts` `sendDue` (T13), which opens the transaction, claims, sends each contact and commits.
- **T13:** `src/engine/send.ts` `sendDue(pool, now, deps)` (:164) takes one client from the engine pool and loops: `BEGIN` → `claimDue` (T12) → for each claimed contact `handle` (:108) → `COMMIT`; it stops when a claim returns nothing, and any error rolls back the whole batch and is rethrown. `handle`: `SELECT reason FROM suppression` → if found, `transition(status, suppressed)` and a `status_changed` event, no email. Otherwise `writeEmail` (:58) uses `deps.getTemplate` (T17 plugs in here) and falls back to `FALLBACK_TEMPLATES` (`src/templates/fallback.ts`), filling slots from `contactVars` (:37: braces removed, trimmed, stand-ins for empty values, industry as text) → `render` + `checkContent` (T05) → `deps.provider.send` [BOUNDARY: provider on its own pool, D43] → plain `INSERT sends` [DB: UNIQUE (contact_id, step)] → `sent` event → accepted: `transition(sent)` + `nextActionAt` (T04); bounced: `transition(bounced)` + `INSERT suppression` → `UPDATE contacts` + `status_changed` event. Measured: day 1 of the 10,000 seed, 4 workers, 1,883 emails in 1.6 s, `checkInvariants` clean. Planned caller: `src/engine/tick.ts` (T18), after replies (T14) and deactivation (T15).

