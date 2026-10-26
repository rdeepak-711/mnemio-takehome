# Mnemio cold-email engine

A cold-email outreach engine for 10,000 prospects: a four-email sequence per prospect on a simulated clock, Postgres as both database and work queue, 50 warming-up mailboxes with sending rules, AI-written emails and AI-read replies on OpenRouter's free models, and a Next.js dashboard.

**See it first:** [`docs/campaign-live-run.html`](docs/campaign-live-run.html) is one full 10,000-prospect run with a live OpenRouter key, day by day. Open it from disk or on the live link below: drag the slider or press Play and watch where everyone goes, how the mailboxes pace the day, and the emails that went out. (Live link: _to be added after the Vercel deploy_.)

## 1. What the system does

A sales team emails 10,000 prospects: a first email and up to three follow-ups each, a few days apart. This system keeps one record per prospect saying where they are in that sequence and when their next email is due. Each simulated hour it picks up everyone who is due, writes their email, hands it to a mock email provider, records what happened and books the next step. A reply, bounce or unsubscribe ends the sequence; if nobody answers the last follow-up within its wait, the prospect is deactivated. Sending behaves like a careful human sender: 50 warming-up mailboxes, the prospect's working hours, a cap per company domain, a pause for a mailbox that bounces too much, and unsubscribe headers. Emails are never sent for real, time is simulated so six weeks play out in under two minutes, the AI comes from OpenRouter's free models, and a dashboard shows it all as it happens.

## 2. Set up and run

Needs Node 22+ and Docker.

```bash
docker compose up -d db          # Postgres 17 on localhost:5433, databases mnemio and mnemio_test
npm install
cp .env.example .env             # the defaults work; add OPENROUTER_API_KEY for the AI (optional)
npm run db:reset                 # build the tables (keeps saved AI answers)
npm run seed                     # 10,000 contacts with history; ends with "invariants: ok"
```

Run the workflow, move time forward, see the report:

```bash
npm run tick                     # one tick at the current simulated time
npm run advance -- --days 7      # move the clock a day at a time and tick, 7 times; ends with "invariants: ok"
npm run report                   # statuses, reply and bounce rates, template sources, classifier accuracy, mailboxes
```

Or the whole campaign in one command, timed:

```bash
npm run full-run                 # reset (keeps the AI cache) → seed → write AI sequences → advance until nobody is left → check → report
```

The dashboard reads the same database:

```bash
npm run dev                      # http://localhost:3000
npm run build && npm start       # or the production build, same port
```

Checks: `npm test` (1,141 tests against a real Postgres, about 80 s), `npm run typecheck`, `npm run format:check`. A step-by-step tour, including clearing the AI cache, is in [`docs/try-it.md`](docs/try-it.md).

Every setting is in `.env.example`. The ones you're most likely to change: `CONTACT_COUNT`, `SEED`, `WAIT_DAYS=3,5,7,7`, `BOUNCE_RATE`, `REPLY_RATE`, `DAILY_AI_BUDGET`, and `DELIVERABILITY=on|off` (off sends one tick per day with no mailboxes, windows or caps).

## 3. Architecture, data model and why these tools

```
src/main.ts (CLI)  ─┐                     ┌─ src/engine/replies.ts     deliver mock replies, label them (rules → AI → needs_review)
app/ (dashboard)   ─┼─► src/engine/tick.ts ┼─ src/engine/deactivate.ts  close contacts silent past the last wait
                    │   one tick per       └─ src/engine/send.ts        claim due contacts, write, send, record, book next step
                    │   simulated hour            │
                    │                             ├─ src/delivery/       mailboxes, warm-up, pacing, windows, domain caps, pauses
                    │                             ├─ src/templates/      AI sequence or hand-written fallback, content checks
                    │                             └─ src/mock/provider.ts the "email service", on its own DB connection
                    └─► src/web/ (read-only SQL for the dashboard)        src/ai/ OpenRouter client, cache, budget
                                         all on Postgres
```

- **Postgres is both the database and the work queue.** A contact's `next_action_at` is its place in the queue; workers claim due contacts with `FOR UPDATE SKIP LOCKED`. One system to run, and a send, its record and the status change commit together in one transaction. A separate queue (Redis, SQS) would add a second system whose state can disagree with the database.
- **TypeScript (strict) on Node, plain SQL through `pg`, no ORM.** The interesting logic is in the SQL (claims, locks, invariants); an ORM would hide it.
- **Pure rules, tested without a database:** `src/lifecycle.ts` (`transition()` is the only place a status changes), `src/schedule.ts`, `src/templates/`, `src/delivery/rules.ts`, `src/classify/`.
- **A simulated clock** (`sim_clock`, `src/clock.ts`): nothing in `src/` reads the real time, so a run is repeatable and fast.
- **Vitest against a real Postgres** (`mnemio_test`), because the guarantees that matter (locks, unique keys, crash recovery) only exist in the database.
- **Next.js 16 + React 19** for the dashboard, with Anime.js for the animations. The routes only parse and call `src/web/`; there is no SQL in `app/`.

Every choice, with what else was considered and what it costs, is in [`docs/decisions.md`](docs/decisions.md) (D01–D73).

| Table | Holds |
|---|---|
| `contacts` | Each prospect: details, segment, `status`, `next_action`, `next_action_at`, its mailbox |
| `sends` | Every email: contact, step, `idempotency_key`, outcome, mailbox, recipient domain, headers, when |
| `replies` | Every reply: the email it answers, text, our label and its source, the mock's true label |
| `suppression` | Addresses never to email again (unsubscribed or bounced) |
| `events` | An append-only diary of everything that happened to each contact |
| `mailboxes`, `mailbox_pauses` | The 50 sending addresses with their warm-up start, and every auto-pause |
| `sim_clock` | The simulation's "now", one row |
| `mock_outbox`, `mock_inbox` | The mock provider's own records: emails received, replies waiting |
| `ai.llm_cache`, `ai.llm_usage` | AI answers kept for reuse, and AI calls per real day. In their own schema, which `db:reset` keeps |

The seed (`npm run seed`, `SEED=42`) gives each contact a random status with the history that status implies: 6,000 `new`, 2,800 part-way through the sequence, and 500 replied, 200 bounced, 200 unsubscribed, 300 deactivated. Each history is produced by walking the contact through the same `transition()` the engine uses. The mock provider (`src/mock/provider.ts`) decides everything from a hash of the seed and the email's key: 3% of addresses bounce, 8% of accepted emails get a reply 12–72 hours later (30% interested, 35% not interested, 20% out of office, 15% unsubscribe), including deliberately ambiguous texts for the AI, and some replies to the last follow-up arrive after the contact was deactivated.

## 4. Lifecycle rules and how double sends are stopped

Statuses: `new`, `first_sent`, `follow_up_1_sent`, `follow_up_2_sent`, `follow_up_3_sent` (in sequence) and `replied`, `bounced`, `unsubscribed`, `deactivated` (finished).

- Emails go strictly in order. The waits are 3, 5 and 7 days between emails, then 7 more days after follow-up 3 before deactivation.
- A reply (interested, not interested, or one the classifier isn't sure of, `needs_review`) ends the sequence: `replied`.
- A bounce ends it: `bounced`, and the address is suppressed.
- An unsubscribe ends it from any status: `unsubscribed`, and the address is suppressed.
- An out-of-office only delays the next email, to the day after the stated return date (or 7 days), never earlier.
- A deactivated prospect who replies late becomes `replied` (or `unsubscribed`).
- Each tick handles replies first, then deactivation, then sending, so a same-day reply always stops the next email.

Double sends are stopped by four layers:

1. **Claiming.** Workers claim due contacts with `FOR UPDATE SKIP LOCKED` (`src/engine/claim.ts`), so two workers never hold the same contact.
2. **One transaction per batch.** A batch's emails, records and status changes commit together (`src/engine/send.ts`); a crash undoes our side completely.
3. **An idempotency key.** The mock provider remembers every email by `"<contact_id>:<step>"` on its own connection, like a real outside service. A retry after a crash gets the first answer back and nothing new is sent. A test crashes a batch half-way and checks exactly this.
4. **The database.** `UNIQUE (contact_id, step)` on `sends` refuses a second row, and status, next action and segment must agree.

After the seed, after every `advance` and at the end of `full-run`, `checkInvariants` (`src/invariants.ts`) checks 13 rules across every row and prints `invariants: ok` or the violations. Examples: one send per contact and step; replaying a contact's status changes ends at its current status; no mailbox above its warm-up limit for the day or its hourly share; no email outside the prospect's 9:00–17:00 weekday window.

## 5. AI: where, which models, rate limits

The free models allow roughly 45 calls a day, so the AI does the work that is per segment or ambiguous, never per email:

- **Writing.** One 4-email sequence per segment (20 segments = 4 role families × 5 industries), written once and cached; code fills in each contact's name, company and role. Every template passes a content check (no leftover blanks, length, spam words) or the hand-written fallback is used.
- **Reading replies.** Plain rules label the clear ones first (an auto-reply header, "unsubscribe", "out of office"). Only the unclear ones go to the AI, 25 per call. If there is no AI, or it fails, a reply becomes `needs_review`, which stops that contact's emails like `not_interested` would.

Models, in order: `recursive/flint-v1.0:free`, `nvidia/nemotron-3.5-lightning:free`, `nvidia/nemotron-3.5-super-vl:free` (`OPENROUTER_MODELS`; how they were picked is in `docs/findings.md`). The client (`src/ai/client.ts`) refuses any model not ending in `:free`.

Rate limits are handled in four ways:
- Calls are spaced out to `AI_RPM` (20 a minute).
- Each real day's calls are counted in `ai.llm_usage` against `DAILY_AI_BUDGET` (45), so a restart doesn't reset the count.
- A busy or failing model is retried twice, then the next model is tried, and a dead model is skipped for 5 minutes.
- Every answer is cached, so a re-run uses no budget.

When the budget runs out, the system carries on with the fallbacks; it never stops for the AI.

Measured with a key (`docs/findings.md`):
- Flint wrote a valid four-email sequence in 28 seconds.
- On the 12 hardest replies in the mock's bank, the AI matched the true label 11 times in one 7.5-second call.
- Over a 10k run using cached AI labels, 1,324 of 1,454 AI labels (91.1%) were correct.

## 6. Results of the 10,000-contact run

`npm run full-run` on 25 Oct 2026, on a MacBook with Postgres 17 in Docker, with no OpenRouter key and an empty AI cache, so every email used the hand-written fallback and every reply the rules couldn't label went to `needs_review`. Each run was done once, on a fresh scratch database.

| Phase | Deliverability on (default) | `DELIVERABILITY=off` |
|---|---|---|
| reset | 0.1 s | 0.1 s |
| seed 10,000 contacts | 0.7 s | 0.7 s |
| advance until nobody is left in sequence | 102.7 s (43 simulated days, 24 ticks a day) | 44.6 s (40 simulated days, 1 tick a day) |
| check the invariants | 0.3 s (1–13 hold) | 0.2 s (1–7 hold) |
| **total** | **103.9 s** | **45.6 s** |

Final counts, the same in both runs:

| | |
|---|---|
| Replied | 1,965 |
| Bounced | 454 |
| Unsubscribed | 442 |
| Deactivated | 7,139 |
| Still in sequence | 0 |
| Reply rate | 28.8% (2,769 of 9,615 contacts with an accepted send) |
| Bounce rate | 1.3% (454 of 35,212 sends) |
| Emails sent by the engine | 26,562 (all fallback templates, no key) |
| Replies labelled by the rules | 640, all correct against the mock's true label |
| Replies to `needs_review` | 1,465 (no key) |
| Orphaned mock replies, unlabelled replies | 0, 0 |

The 35,212 sends include 8,650 from the seed's history. The counts match because the mock decides each outcome from the seed and the email's key, so deliverability changes when an email goes out, not what happens to it. With deliverability on, the campaign takes 3 more simulated days: on day one the 50 new mailboxes are allowed 20 emails each, 1,000 in total. With pacing, no mailbox ever sent more than 10 emails in one UTC hour (80 without pacing).

### With a live OpenRouter key

The same command on a fresh scratch database with a key took 820.2 s: 678.3 s for the AI to write the 20 segment sequences once, then 140.8 s to advance the 43 days. It used 41 of the day's 45 free calls.

- **Emails:** all 26,581 emails used the AI-written sequences, all from `recursive/flint-v1.0:free`.
- **Replies:** the rules labelled 640 replies, all correct. The AI labelled 1,465, and 1,314 of those (89.7%) matched the mock's true label. The other 151 were held as `needs_review` rather than guessed wrong.
- **Final counts:** 1,891 replied, 454 bounced, 503 unsubscribed and 7,152 deactivated. The reply rate (28.8%) and bounce rate (1.3%) are the same as without a key.

[`docs/campaign-live-run.html`](docs/campaign-live-run.html) shows this run day by day: a slider with Play, the three numbers for the day (emails sent, share of the mailbox limit used, prospects still in sequence), an animated funnel of the nine statuses with that day's real moves between them, emails per day against the mailboxes' combined limit, the day hour by hour, the four sending rules, and one real email per step (click a step in the funnel to see its email). Every number comes from one frozen export of the run, embedded in the file, so it opens straight from disk and connects to nothing. A headless-browser check confirmed that on all 44 days the nine counts match the export and sum to 10,000.

## 7. Trade-offs, limitations and what's next

**Trade-offs taken on purpose:**
- **Postgres as the queue.** It is simple and transactional, but it is not built for millions of jobs a minute.
- **AI per segment, not per contact.** The emails are less personal, but the run fits the free tier.
- **`needs_review` stops a contact.** That is safer than guessing, but without a key about 70% of replies end there.
- **Hourly ticks with deliverability on.** They are needed for working hours across time zones, and they cost about 2.3× the run time.

**Known limitations:**
- **Warm-up favours early time zones.** Mailbox allowances reset at 00:00 UTC, so during warm-up the regions whose working hours fall early in the UTC day (Australia and Asia, then Europe) get first call on it and the Americas come last. Pacing limits how much one hour can take, not which hours come first.
- **Mailboxes fill unevenly.** A new contact goes to the lowest-numbered mailbox with room, so low-numbered mailboxes fill first. This is correct by the rules, but uneven.
- **Bounces only.** Auto-pause looks at bounces only; spam complaints are not simulated.
- **Unsubscribe links go nowhere.** The link and `List-Unsubscribe` headers are the right shape, but nothing handles a click. The token is a hash of the seed and contact id, not a secret.
- **No review queue.** There is no screen for a person to read a `needs_review` reply and restart the contact.
- **Late replies are partial.** They are only simulated for follow-up 3.
- **Generic greetings.** Contacts with missing names or companies get "Hi there" instead of being flagged.
- **Local only.** The dashboard has no login, so it is for your own machine.

**What's next:**
- A review queue for `needs_review` replies, with a "restart" action.
- A real unsubscribe endpoint with signed tokens.
- Complaint-rate pauses.
- Spreading new contacts across mailboxes by load.
- A real provider adapter (SES or Postmark) behind the same idempotency key.
- Per-contact AI personalisation for the interested segment once the budget allows.

## The dashboard

Seven sections in the sidebar:

- **Overview**: KPIs, a day slider with the funnel as of that day, daily activity, AI and deliverability cards.
- **Campaign Timeline**: one row per day.
- **Contact Journeys**: the nine stages and who moved between them.
- **AI Classifier**: accuracy per source, the confusion table, example replies.
- **Contacts**: search, filter and every send, reply and event for one contact.
- **Activity Log**: every send, bounce, reply and deactivation.
- **Deliverability**: the mailbox grid, an hour-by-hour strip of the day's sends by region, domains against the cap, and pauses.

Every number is rebuilt from the database for the end of the selected simulated UTC day. The header buttons advance the clock 1 or 7 days, play day by day, or reset and re-seed, through the same engine functions as the CLI.

## Where to read more

- [`docs/mental-model.md`](docs/mental-model.md): how the system works, in plain words.
- [`docs/flow.md`](docs/flow.md): which function calls which, file by file.
- [`docs/decisions.md`](docs/decisions.md): every decision with its alternatives and cost.
- [`docs/findings.md`](docs/findings.md): measurements and live AI results.
- [`docs/try-it.md`](docs/try-it.md): a step-by-step tour of the CLI and dashboard.
- [`docs/campaign-live-run.html`](docs/campaign-live-run.html): the live-key run, day by day.
- [`spec/site.md`](spec/site.md) and [`tasks/`](tasks/): the spec and each task's contract.
