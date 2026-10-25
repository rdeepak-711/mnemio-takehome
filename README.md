# Mnemio cold-email engine

> **Status: in progress (23 Oct 2026).** Tasks T01–T13 are built and tested: the project setup, the rulebooks, the database, the simulated clock, the 10,000-contact seed and the mock email provider. The engine that sends emails on a schedule (T12–T18), the AI (T16–T17), the report (T19), the full 10,000-contact run (T20) and the dashboard (T21) are next. This README describes what exists today and is completed in T23.

## What the system does

A sales team emails 10,000 prospects: a first email and up to three follow-ups each, a few days apart. This system keeps one record per prospect saying where they are in that sequence and when their next email is due. Each run picks up everyone who is due, writes their email, hands it to a mock email provider, records what happened and books the next step. A reply, bounce or unsubscribe ends the sequence; if nobody answers the last follow-up within its wait, the prospect is deactivated. Emails are never sent for real, time is simulated so weeks play out in minutes, and the AI comes from OpenRouter's free models.

## Run it

Needs Node 22+ and Docker.

```bash
docker compose up -d db          # Postgres 17 on localhost:5433, databases mnemio and mnemio_test
npm install
cp .env.example .env             # the defaults work; the AI key is only needed from T16 on
npm run db:reset                 # build the tables (keeps saved AI answers)
npm run seed                     # 10,000 contacts with history; prints "invariants: ok"
npm test                         # 812 automated tests
```

`npm run seed` takes about 1 second on a MacBook. Running it twice without `db:reset` is refused.

Run the engine:

```bash
npm run ai:warm                  # optional, with a key: write the 20 email sequences once (cached after)
npm run tick                     # one tick at the current simulated time
npm run advance -- --days 30     # move the clock a day and tick, 30 times; ends with "invariants: ok"
npm run report                   # where things stand: statuses, rates, template sources, classifier accuracy
npm run full-run                 # reset (keeps the AI cache) → seed → warm → advance until done → check → report, timed
```

### Measured: the full 10,000-contact run (23 Oct 2026, MacBook, Postgres 17 in Docker)

`npm run full-run` with no OpenRouter key. The AI cache held 1 sequence and 13 reply labels from earlier runs, which were used; everything else fell back to the hand-written emails and to "needs review".

| Phase | Time |
|---|---|
| reset | 0.1 s |
| seed 10,000 contacts | 1.1 s |
| warm the 20 sequences | 0.0 s (no key) |
| advance 40 simulated days, until nobody was left in sequence | 54.1 s |
| check the 7 invariants | 0.1 s (all hold) |
| report | 0.0 s |
| **total** | **55.6 s** |

Final state: 1,883 replied, 454 bounced, 503 unsubscribed, 7,160 deactivated, 0 still in sequence. Reply rate 28.8% (2,769 of 9,615 contacts with an accepted send); bounce rate 1.3% (454 of 35,245 sends, seed included). 26,595 emails sent by the engine: 1,339 from the cached AI sequence, 25,256 fallback. Replies: rules labelled 640 (all correct against the mock's true label), cached AI labels 1,454 (1,324 correct, 91.1%), 12 fell back; 142 need review, 0 unlabelled, 0 orphaned. A second run on the same seed gave identical numbers. A run with a key adds the AI's minutes to "warm" (about 28 s per sequence on the free models, once; cached after).

A step-by-step tour, including clearing the AI cache, is in [`docs/try-it.md`](docs/try-it.md).

### Dashboard

A browser view onto the same database (T21a, `spec/dashboard.md`). It reads `DATABASE_URL` from `.env` like the CLI, so seed first.

```bash
npm run dev                      # http://localhost:3000, reloads on change
npm run build && npm start       # or the production build, same port
```

Three pages: **Overview** (`/`: KPIs, a day slider with the funnel as of that day, the daily activity chart), **Journey** (`/journey`: the nine stages and who moved between them on a day) and **Contacts** (`/contacts`: 50 per page, search, status filter, a detail panel with every send, reply and event). Every number is rebuilt from the database for the end of the selected simulated UTC day (D57); days before `SIM_START` are marked "seeded history". The header buttons advance the clock 1 or 7 days, or reset (`db:reset` keeping the AI cache, then `seed`), through the same engine functions as the CLI, one at a time (D58); the request stays open until every day has run, and in the CLI runs on 10,000 contacts with no AI key each simulated day took 0.3–2.0 seconds, so "advance 7 days" can take up to about 15 seconds (more with an AI key). There is no login, so run it on your own machine only.

## Architecture

TypeScript on Node, Postgres as both the database and the work queue, plain SQL with no ORM, Vitest against a real Postgres. Reasons, alternatives and costs for every choice are in [`docs/decisions.md`](docs/decisions.md).

| Layer | Tasks | What it is | Status |
|---|---|---|---|
| 0 Skeleton | T01 | Project, Docker Postgres, test runner, connection pool | built |
| 1 Pure rules | T02–T07 | Settings check, lifecycle rulebook, schedule, templates, segments, reply rules | built |
| 2 Data | T08–T11 | Tables, simulated clock, seed + consistency checker, mock provider | built |
| 3 Engine | T12–T15 | Claim due contacts, send, process replies, deactivate | T12–T13 built, T14–T15 next |
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
| `ai.llm_cache`, `ai.llm_usage` | AI answers kept for reuse, and AI calls used per real day. They live in their own `ai` schema, which `npm run db:reset` keeps (D52) |

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

Four layers, all built:

1. **The mock provider remembers every email by its key** (`"<contact_id>:<step>"`). Sending the same key again returns the first answer and creates nothing new, so a retry after a crash is harmless.
2. **The provider writes on its own connection**, like a real outside service: if our transaction rolls back, its record of the email survives.
3. **The database allows one row per contact per step** (`UNIQUE (contact_id, step)` on `sends`).
4. **Workers claim due contacts with `FOR UPDATE SKIP LOCKED`** (`src/engine/claim.ts`), so two workers never work on the same contact at once; other workers skip locked rows instead of waiting. Each batch's emails, records and status changes are saved as one transaction (`src/engine/send.ts`), so a crash undoes our side completely; the provider remembers what it was handed, so the retry sends nothing twice. A test crashes a batch half-way and checks exactly this.

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

## Sending

`sendDue` (`src/engine/send.ts`) works through due contacts in batches of 200 (`SEND_BATCH_SIZE`), several workers at once. Each email uses the AI template for the contact's segment when there is a valid one (T17), otherwise a hand-written fallback; both are checked for leftover blanks, length and spam words before sending. Contact details are cleaned first (braces removed, blanks given stand-ins like "there"), so one bad record can't stop the run. The mock provider runs on its own connection pool, like a real outside service. On the 10,000-contact seed, the first day's 1,883 emails take about 1.6 seconds with 4 workers.

## Replies

`deliverReplies` (`src/engine/replies.ts`) moves due mock replies into `replies` at the start of each day, in one statement that parallel callers can't double-deliver. A reply whose send was undone by a crash waits until the retried send is saved. `processReplies` labels them in batches of 25: plain rules first, then the AI for the unclear ones (T17), and `needs_review` when there is no AI or it fails, so the run never stops because of the AI. Interested, not interested and needs review stop the sequence; unsubscribe stops it and adds the address to the do-not-email list (it also beats an earlier bounce); out of office moves the next email to the day after the return date, or 7 days on. Replies are handled before sending, so a reply always stops the next email. Over 20 simulated days on the 10,000-contact seed with no AI key, every day took 0.5–2.0 seconds and the consistency checks were clean every day.

## Deactivation

`deactivateDue` (`src/engine/deactivate.ts`) closes contacts who stayed silent through the last wait, 500 at a time, after replies are handled and before sending, so a same-day reply or an out-of-office always wins. A deactivated contact who replies later becomes `replied`. In a 30-day run on the 10,000-contact seed with no AI key (replies, deactivation and 4 send workers each day), each day took 0.3–2.0 seconds, the consistency checks were clean every day, 7,031 contacts were deactivated, and 22 of them answered late (21 replied, 1 unsubscribed).

## AI

The free models allow roughly 45 calls a day. The design: the AI writes one 4-email sequence per segment (20 segments = 4 role families × 5 industries), and code fills in each contact's details; replies are first sorted by plain rules (auto-reply header, "unsubscribe", "out of office"), and only unclear ones go to the AI, 25 per call. Answers are cached; on failure or an exhausted budget, a hand-written template or a `needs_review` label takes over so the system never stops.

The client (`src/ai/client.ts`) uses three free models in order (`OPENROUTER_MODELS` in `.env.example`; how they were picked is in `docs/findings.md`). It spaces calls (`AI_RPM`), counts the day's calls against `DAILY_AI_BUDGET` in the database, retries busy or failing models twice, skips a dead model for 5 minutes, and refuses any model whose name doesn't end in `:free`. A first live call answered in 3.4 seconds; the same question again came from the cache in 3 ms without using the budget.

First live results with the test key (`docs/findings.md`): Flint wrote a valid four-email sequence for one segment in 28 seconds, after the first live run showed it writing each email as one run-on line, which the template check now rejects. On the 12 deliberately harder replies in the mock's bank that the rules leave alone, the AI matched the true label 11 times in one 7.5-second call; the miss ("Who gave you my address?") went to `needs_review`, which stops emails just as `not_interested` would.

## Known limitations so far

- The tick/advance commands, report, dashboard and the timed full run are not built yet.
- Without an AI key, every reply the rules can't label becomes `needs_review` and stops that contact's emails (about 70% of replies in the 20-day probe).
- A `needs_review` reply ends the sequence; there is no screen or command for a person to read it and restart the contact.
- Late replies are only simulated for follow-up 3; replies to earlier emails always arrive within 12–72 hours.
- Contacts with missing names or companies get a less personal email ("Hi there") rather than being flagged for review.

## Where to read more

- [`docs/plain-guide-t01-t11.md`](docs/plain-guide-t01-t11.md): every task so far, in plain words.
- [`docs/mental-model.md`](docs/mental-model.md): how the system works, as a whole.
- [`docs/flow.md`](docs/flow.md): which function calls which, file by file.
- [`docs/decisions.md`](docs/decisions.md): every decision with its alternatives and cost (D01–D44).
- [`spec/site.md`](spec/site.md) and [`tasks/`](tasks/): the spec and each task's contract.
