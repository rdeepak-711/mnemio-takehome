# Execution flow

**Status: PLANNED, partly built.** T01 (DB pool), T02 (config), T03 (lifecycle), T04 (schedule) and T05 (render) exist; everything else is still planned. This is the intended flow from `spec/site.md`. Each task updates the section it touches from "planned" to "built", with real line references.

## Entry points

| Entry | File | Calls |
|---|---|---|
| `npm run db:reset` | `src/cli.ts` → `src/db/migrate.ts` `resetDb()` | runs `src/db/migrations/*.sql` in order |
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
 ├─ getNow(db)                                   src/clock.ts           [DB]
 ├─ deliverReplies(db, now)                      src/engine/replies.ts  [DB]  mock_inbox → replies
 ├─ processReplies(db, now, classifier)          src/engine/replies.ts
 │    ├─ classifyByRules(reply)                  src/classify/rules.ts  (pure)
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
             render(template, vars)              src/templates/render.ts:24 (pure, BUILT T05)
             checkContent(email)                 src/templates/render.ts:38 (pure, BUILT T05)
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
- **T05:** `src/templates/render.ts`: `render` (:24) fills `{{slot}}`s in one `replace` pass using `SLOT_PATTERN` (:10), throwing on an unknown slot or an empty value; `findSlots` (:33) lists slot names; `checkContent` (:38) returns every problem (leftover braces, empty or long subject, long body, spam words via `SPAM_PATTERNS` :21). No imports. Planned callers: `src/engine/send.ts` (T13) renders then checks each email before `provider.send`; `src/ai/sequences.ts` (T17) uses `findSlots` + `checkContent` to vet AI-written templates. Not called from anywhere except tests yet.
