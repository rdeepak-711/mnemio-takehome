# Mnemio cold-email engine

> **Status: in progress (23 Oct 2026).** Tasks T01–T11 are built and tested: the project setup, the rulebooks, the database, the simulated clock, the 10,000-contact seed and the mock email provider. The engine that sends emails on a schedule (T12–T18), the AI (T16–T17), the report (T19), the full 10,000-contact run (T20) and the dashboard (T21) are next. This README describes what exists today and is completed in T23.

## What the system does

A sales team emails 10,000 prospects: a first email and up to three follow-ups each, a few days apart. This system keeps one record per prospect saying where they are in that sequence and when their next email is due. Each run picks up everyone who is due, writes their email, hands it to a mock email provider, records what happened and books the next step. A reply, bounce or unsubscribe ends the sequence; if nobody answers the last follow-up within its wait, the prospect is deactivated. Emails are never sent for real, time is simulated so weeks play out in minutes, and the AI comes from OpenRouter's free models.

## Run it

Needs Node 22+ and Docker.

```bash
docker compose up -d db          # Postgres 17 on localhost:5433, databases mnemio and mnemio_test
npm install
cp .env.example .env             # the defaults work; the AI key is only needed from T16 on
npm run db:reset                 # build the tables
npm run seed                     # 10,000 contacts with history; prints "invariants: ok"
npm test                         # 534 automated tests
```

`npm run seed` takes about 1 second on a MacBook. Running it twice without `db:reset` is refused.

Coming with the engine: `npm run run` (one tick), `npm run advance -- --days 30`, `npm run report`, and the dashboard.

## Architecture

TypeScript on Node, Postgres as both the database and the work queue, plain SQL with no ORM, Vitest against a real Postgres. Reasons, alternatives and costs for every choice are in [`docs/decisions.md`](docs/decisions.md).

| Layer | Tasks | What it is | Status |
|---|---|---|---|
| 0 Skeleton | T01 | Project, Docker Postgres, test runner, connection pool | built |
| 1 Pure rules | T02–T07 | Settings check, lifecycle rulebook, schedule, templates, segments, reply rules | built |
| 2 Data | T08–T11 | Tables, simulated clock, seed + consistency checker, mock provider | built |
| 3 Engine | T12–T15 | Claim due contacts, send, process replies, deactivate | next |
| 4 AI | T16–T17 | OpenRouter client, sequence writer, reply classifier | planned |
| 5 Whole system | T18–T20 | Tick + advance, report, timed 10,000-contact run | planned |
| 6 Dashboard | T21–T22 | Funnel with day slider, contact timelines; mailbox warm-up bonus | planned |

### Data model

| Table | Holds |
|---|---|
| `contacts` | Each prospect: details, segment, `status`, `next_action` and `next_action_at` |
| `sends` | Every email sent: contact, step, `idempotency_key`, outcome, when |
| `replies` | Every reply: the email it answers, text, our label, the mock's true label |
| `suppression` | Addresses never to email again (unsubscribed or bounced) |
| `events` | An append-only diary of everything that happened to each contact |
| `sim_clock` | The simulation's "now", one row |
| `mock_outbox`, `mock_inbox` | The mock provider's own records: emails received, replies waiting |
| `llm_cache`, `llm_usage` | AI answers kept for reuse, and AI calls used per real day |

The database also refuses impossible records, as a second line of defence behind the code: one row per contact per step (`UNIQUE (contact_id, step)`), a status must match its next action, a segment must equal `role_family:industry`.

## Lifecycle rules

Statuses: `new`, `first_sent`, `follow_up_1_sent`, `follow_up_2_sent`, `follow_up_3_sent` (in sequence) and `replied`, `bounced`, `unsubscribed`, `deactivated` (finished). One function, `transition()` in `src/lifecycle.ts`, decides every change; nothing else changes a status.

- Emails go strictly in order; recording a step out of order is refused.
- Default waits are 3, 5 and 7 days between emails, and 7 more days after follow-up 3 before deactivation (`WAIT_DAYS=3,5,7,7`).
- A reply (interested, not interested, or one the classifier isn't sure about) ends the sequence: `replied`.
- A bounce ends it: `bounced`, and the address is suppressed.
- An unsubscribe ends it from any status: `unsubscribed`, and the address is suppressed.
- An out-of-office reply only delays the next email, to the day after the stated return date (or 7 days if none), and never brings it forward.
- A deactivated prospect who replies late becomes `replied` (or `unsubscribed`); a late out-of-office changes nothing.

## How double sends are stopped

Four layers, the first three built:

1. **The mock provider remembers every email by its key** (`"<contact_id>:<step>"`). Sending the same key again returns the first answer and creates nothing new, so a retry after a crash is harmless.
2. **The provider writes on its own connection**, like a real outside service: if our transaction rolls back, its record of the email survives.
3. **The database allows one row per contact per step** (`UNIQUE (contact_id, step)` on `sends`).
4. *(T12–T13)* **Workers claim due contacts with `FOR UPDATE SKIP LOCKED`**, so two workers never work on the same contact at once, and each contact's send, record and status change commit together.

## Seed data

`npm run seed` creates 10,000 contacts with a fixed random seed (`SEED=42`), each with a random status and the matching history, as the brief asks: a contact on follow-up 2 has its first email and follow-up 1, spaced by the real waits.

| Status | Contacts | History created |
|---|---|---|
| `new` | 6,000 | none; first emails due in waves of 1,000 a day |
| `first_sent` … `follow_up_3_sent` | 1,200 / 800 / 500 / 300 | 1–4 past emails; about a third are due on day one |
| `replied` | 500 | 1–4 emails and an interested or not-interested reply |
| `bounced` | 200 | one bounced first email, address suppressed |
| `unsubscribed` | 200 | 1–4 emails and an unsubscribe reply, address suppressed |
| `deactivated` | 300 | all 4 emails, then deactivated after the last wait |

Every history is produced by walking the contact through the same `transition()` the engine uses, and dated before the simulation start. The whole seed is one transaction. Afterwards `checkInvariants` (`src/invariants.ts`) checks seven rules across every row, for example "a bounced contact has a bounced last email and a suppression entry" and "replaying a contact's status changes ends at its current status". The same seed produces identical rows, ids included.

## Mock email provider

`src/mock/provider.ts` stands in for a real email service. Every decision comes from a hash of the seed and the email's key (or address), not from a shared random generator, so results don't depend on which worker sends first.

- **Bounces:** 3% of addresses (`BOUNCE_RATE`), decided per address, so a dead address bounces every time.
- **Replies:** 8% of accepted emails (`REPLY_RATE`), split by `REPLY_MIX` (interested 30%, not interested 35%, out of office 20%, unsubscribe 15%), arriving 12–72 hours later.
- **Reply texts:** written texts per kind, including deliberately ambiguous ones for the AI. A test ensures the simple rules never give any of them a wrong label.
- **Out of office:** 75% carry an `Auto-Submitted` header; most give a return date the rules can read; some give none.
- **Late replies:** 10% of replies to follow-up 3 arrive 8–21 days later, after the contact has been deactivated, so the late-reply rule is exercised in every run.

## AI (planned, T16–T17)

The free models allow roughly 45 calls a day. The design: the AI writes one 4-email sequence per segment (20 segments = 4 role families × 5 industries), and code fills in each contact's details; replies are first sorted by plain rules (auto-reply header, "unsubscribe", "out of office"), and only unclear ones go to the AI, 25 per call. Answers are cached; on failure or an exhausted budget, a hand-written template or a `needs_review` label takes over so the system never stops.

## Known limitations so far

- The engine, AI, report, dashboard and the timed 10,000-contact run are not built yet; no run results exist yet.
- Late replies are only simulated for follow-up 3; replies to earlier emails always arrive within 12–72 hours.
- The mock provider and the engine currently share one connection pool; T13 gives the provider its own (D43), because a probe showed the provider waits forever when engine workers hold every connection.

## Where to read more

- [`docs/plain-guide-t01-t11.md`](docs/plain-guide-t01-t11.md): every task so far, in plain words.
- [`docs/mental-model.md`](docs/mental-model.md): how the system works, as a whole.
- [`docs/flow.md`](docs/flow.md): which function calls which, file by file.
- [`docs/decisions.md`](docs/decisions.md): every decision with its alternatives and cost (D01–D44).
- [`spec/site.md`](spec/site.md) and [`tasks/`](tasks/): the spec and each task's contract.
