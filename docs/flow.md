# Execution flow

**Status: PLANNED.** No code exists yet. This is the intended flow from `spec/site.md`. Each task updates the section it touches from "planned" to "built", with real line references.

## Entry points

| Entry | File | Calls |
|---|---|---|
| `npm run db:reset` | `src/cli.ts` → `src/db/migrate.ts` `resetDb()` | runs `src/db/migrations/*.sql` in order |
| `npm run seed` | `src/cli.ts` → `src/seed/seed.ts` `seed()` | `loadConfig()`, Faker, `roleFamily()`, `segmentOf()`, `nextActionAt()`, `setNow()` |
| `npm run run` | `src/cli.ts` → `src/engine/tick.ts` `tick()` | the four tick steps below |
| `npm run advance -- --days N` | `src/cli.ts` → `src/clock.ts` `advance()` + `tick()` N times | |
| `npm run report` | `src/cli.ts` → `src/report.ts` `report()` | read-only SQL |
| Dashboard | `app/**` route handlers `app/api/*/route.ts` | the same `tick()`, `advance()`, `report()` and query functions |

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
 │                     oooReschedule(...)        src/schedule.ts        (pure)
 ├─ deactivateDue(db, now)                       src/engine/deactivate.ts [DB]
 └─ sendDue(db, now, deps)  (loop until none due) src/engine/send.ts
      └─ per batch, ONE TRANSACTION:
           claimDue(client, now, limit)          src/engine/claim.ts    [DB: FOR UPDATE SKIP LOCKED]
           for each contact:
             suppression check                   [DB]
             getSequence(segment)                src/ai/sequences.ts    [cache / NETWORK / fallback]
             render(template, vars)              src/templates/render.ts (pure)
             checkContent(text)                  src/templates/render.ts (pure)
             provider.send({idempotencyKey,…})   src/mock/provider.ts   [BOUNDARY: own DB connection = "external"]
             INSERT sends ON CONFLICT DO NOTHING [DB: UNIQUE (contact_id, step)]
             transition(status, sent:<step>)     src/lifecycle.ts       (pure)
             nextActionAt(step, sentAt, waits)   src/schedule.ts        (pure)
             UPDATE contacts; INSERT events      [DB]
           COMMIT
```

## Boundaries

- **Network:** only `src/ai/client.ts` talks to the outside world (OpenRouter). Tests replace it with a fake HTTP server.
- **"External" provider:** `src/mock/provider.ts` writes to `mock_outbox` on its own connection, outside the send transaction, so it behaves like a third-party API that has already happened when our transaction rolls back. That's what the crash test (T13) relies on.
- **Time:** only `src/clock.ts` decides what "now" is. `llm_usage` is the single place that uses real time (OpenRouter counts real days).
- **No auth, no tenants.** Single local user.

## Touched this session

Nothing yet. Documents only.
