# Decisions

Every meaningful choice, with what else was considered and what it costs. Superseded decisions stay here, marked reversed.

---

## D01 · 2026-10-22 · TypeScript, not Python

**Decided:** TypeScript (strict) on Node 22 for the engine, CLI and dashboard.
**Considered:** Python (FastAPI + psycopg + a separate JS frontend).
**Why:** the dashboard is part of the plan, and with TypeScript the engine and the dashboard share one set of types. The 9 statuses are defined once, so a status can't mean one thing in the backend and another in the UI. `zod` gives schema checks on AI output in the same language. Deepak already knows Next.js and is learning TypeScript.
**Cost:** Python reads more simply and is listed first in the job post. Without the dashboard, Python would have been the pick.

## D02 · 2026-10-22 · Postgres as both the database and the queue

**Decided:** Postgres 17. The `contacts` table, with `next_action_at`, is the job queue. Workers claim due rows with `SELECT … FOR UPDATE SKIP LOCKED`.
**Considered:** MySQL 8 (has `SKIP LOCKED` too), SQLite (zero setup), Postgres + Redis/BullMQ as a separate queue.
**Why:** `SKIP LOCKED` lets several workers take disjoint sets of due contacts without waiting on each other. Unique constraints make "never send the same step twice" a property of the data, not of careful code. One system holds the state and the queue, so they can't disagree. A separate queue would mean a second source of truth to keep in sync.
**Cost:** needs Docker on the evaluator's machine. SQLite would have needed nothing, but it has no row-level locking, so the concurrency story would be weaker.

## D03 · 2026-10-22 · Two guards against double sends

**Decided:** (1) `FOR UPDATE SKIP LOCKED` when claiming; (2) `UNIQUE (contact_id, step)` on `sends`, plus an idempotency key `"<contact_id>:<step>"` that the mock provider remembers in its own table.
**Considered:** a status check in code before sending ("if not already sent, send").
**Why:** a check in code fails when two workers read the same row before either writes. The lock prevents overlap between running workers. The unique constraint and the provider-side key prevent repeats after a crash between "provider accepted" and "our commit". Each guard covers a failure the other doesn't.
**Cost:** a little more SQL, and a provider that has to honour idempotency keys. Real providers like SendGrid and Postmark support this pattern, so the mock matches reality.

## D04 · 2026-10-22 · Raw SQL with `pg`, no ORM

**Decided:** `pg` (node-postgres) with hand-written SQL, and migrations as numbered `.sql` files run by a ~20-line script.
**Considered:** Prisma, Drizzle, node-pg-migrate.
**Why:** the core of the system is locking and constraints, which should be readable SQL. Prisma can't express `FOR UPDATE SKIP LOCKED` without falling back to raw queries anyway. Fewer tools means fewer things to explain.
**Cost:** no generated types from the schema. Row types are written by hand and checked by tests.

## D05 · 2026-10-22 · Out-of-office replies delay the sequence, they don't stop it

**Decided:** an out-of-office reply keeps the contact's status and moves the next action to after the return date (+1 day), or `OOO_DEFAULT_DAYS` later if no date is found. Every other reply stops the sequence.
**Considered:** treating out-of-office like any reply (stop), as a literal reading of "a reply stops the sequence".
**Why:** an auto-reply isn't the person answering. Stopping would drop a prospect who never saw the email.
**Cost:** a deviation from the literal PDF wording, so the README must state it. A misclassified out-of-office would wrongly continue a sequence. That's why out-of-office is decided by rules (the auto-reply header), not guessed by AI (D11).

## D06 · 2026-10-22 · A fourth wait, D, after follow-up 3

**Decided:** `WAIT_DAYS=3,5,7,7`, four waits. D is the gap between follow-up 3 and deactivation.
**Considered:** the PDF's example of three waits (3, 5, 7).
**Why:** the PDF says the contact is deactivated "if the last follow-up gets no reply within its wait period", which is a fourth period its example doesn't list.
**Cost:** none, but the README says it was added.

## D07 · 2026-10-22 · No login on the dashboard

**Decided:** no authentication.
**Considered:** a demo login with credentials printed in the README.
**Why:** a password published in a public README protects nothing, and it costs build time. The dashboard runs locally against fake data.
**Cost:** couldn't be deployed publicly as is. Listed under "what I'd build next".

## D08 · 2026-10-22 · Seed with Faker and a fixed seed, not AI

**Decided:** `@faker-js/faker` with `faker.seed(SEED)`. Emails on `.example` domains. Industry assigned by the seed when it picks the company.
**Considered:** AI-generated contacts.
**Why:** the PDF requires the same data on every run. AI output isn't reproducible and would use quota needed for emails and replies. `.example` is reserved, so no real address can appear.
**Cost:** names and companies look synthetic. `industry` is an extra column the PDF didn't list. A real campaign would get it from enrichment.

## D09 · 2026-10-22 · 20 segments, one AI call each, all 4 steps per call

**Decided:** 4 role families × 5 industries = 20 segments. One AI call writes a segment's full 4-email sequence as JSON with slots (`{{first_name}}`, `{{company}}`, …). Code fills in the slots per contact.
**Considered:** one call per email (40,000 calls, about 800 days at 50/day), one call per segment per step (80 calls), more segments.
**Why:** OpenRouter's free tier allows about 50 calls a day, counted in real days, not simulated ones. 20 calls leaves about 25 for reply classification and retries. One call per segment also makes the 4 emails read as one story.
**Budget arithmetic (added 2026-10-22 after review):** the 10k run covers 60 simulated days but happens in one real day, so the whole run gets 45 calls. It produces about 2,800 replies (8% per accepted send over 4 sends ≈ 28% of contacts), and roughly 1,800 of them need AI after the rules. 25 calls × 25 replies covers only 625. So classifications are cached by normalised reply body, and mock replies come from a fixed bank of texts: AI calls then scale with the number of distinct bodies (the bank size), not the number of replies. Cost: this works because the mock reuses texts. Real replies are all different, and the README has to say so, along with what real volume would cost.
**Cost:** personalisation stops at the segment level. Contacts in the same segment get the same wording with different names. A `priority` flag lets leftover quota personalise top contacts later.

## D10 · 2026-10-22 · AI client: OpenAI SDK pointed at OpenRouter, with a fallback for every AI step

**Decided:** the `openai` npm SDK with `baseURL = https://openrouter.ai/api/v1`, two `:free` models in order (picked from the live list at T16), cache, a limiter (calls spaced by `AI_RPM`, a daily count against `DAILY_AI_BUDGET` stored in Postgres), up to 2 retries with backoff and jitter (no `Retry-After` handling, cut for time on 2026-10-22), then fallback: hand-written templates for emails, `needs_review` for replies.
**Considered:** calling the API with raw `fetch`, a single model, failing the run when AI is unavailable.
**Why:** OpenRouter uses the OpenAI API shape, so the SDK works unchanged. A fallback means a free model's bad day lowers quality but never stops sending. It also means the system runs with no API key at all.
**Cost:** fallback emails are plainer. The report shows how many were AI, cached, or fallback.

## D11 · 2026-10-22 · Rules classify the clear-cut replies, AI the ambiguous ones

**Decided:** rules first (auto-reply header, unsubscribe phrases), then cache, then AI in batches of 25 validated by zod, then `needs_review`.
**Considered:** AI for every reply.
**Why:** unsubscribes and out-of-office are the replies where a mistake costs most, and they're the easiest to catch with certainty. That saves quota for the ambiguous replies.
**Cost:** rules are crude. Each known trap ("Out of office? No, I'm here") is a test case.

## D12 · 2026-10-22 · Mock replies carry a hidden true label, used to score the classifier

**Decided:** `mock_inbox` and `replies` store `true_label` from the mock. The classifier never reads it. The report computes accuracy (rules vs AI).
**Considered:** no evaluation.
**Why:** gives measured evidence of classifier quality, which the job post asks for ("better-than-default AI results").
**Cost:** one extra column, and care to keep it out of the classifier's input. A test checks this.

## D13 · 2026-10-22 · Simulated clock in the database; CLI ticks instead of a background daemon

**Decided:** one row in `sim_clock`. All business time is read from it. `run` = one tick, `advance --days N` = N ticks. No cron, no long-running worker.
**Considered:** a worker process with real timers.
**Why:** the PDF wants weeks of campaign played out in minutes. A tick as a function call is deterministic and testable, and nothing runs unattended.
**Cost:** no real-time sending. In production, a scheduler would call `run` every few minutes. Same code.

## D14 · 2026-10-22 · Dashboard in the same Next.js package, state rebuilt from events

**Decided:** Next.js App Router at the repo root, with the engine in `src/`. Day-by-day views are computed from the append-only `events` table, with no stored snapshots. UI controls call the same engine functions as the CLI.
**Considered:** Vite + React with a separate API server, a separate `web/` package, storing daily snapshots.
**Why:** one package, one install, one set of types. Rebuilding from events means the slider can only show what actually happened.
**Cost:** Next.js is heavier than the dashboard strictly needs. Event queries need an index on `occurred_at`.

## D15 · 2026-10-22 · Build process: harness engineer + junior + explain-back

**Decided:** Claude writes each task file and its failing tests. The Claude `junior-software-engineer` agent writes the code until the tests pass. Claude reviews the diff. Deepak answers 3 explain-back questions before the task counts as done. One branch per task.
**Considered:** Codex via `handoff` (free), building without per-task files.
**Why:** small tasks with failing tests first mean nothing gets missed. Explain-back is how the work stays Deepak's own for the interview.
**Cost:** paid Claude usage, and more ceremony per task.

## D16 · 2026-10-22 · Bounced addresses go into the suppression list too

**Decided:** a bounce adds the address to `suppression` with reason `bounced`, as well as setting status `bounced`.
**Considered:** relying on status alone.
**Why:** one check before every send ("is this address suppressed?") covers both unsubscribes and bounces, and it holds even if the same address appears on a second contact row.
**Cost:** none meaningful.

## D17 · 2026-10-22 · The mock provider decides each send by hashing its key, not with a running random generator

**Decided:** bounce, reply, reply label, delay and reply text for a send all come from `hash(SEED, idempotencyKey)`.
**Considered:** one seeded random generator that each send draws from in turn (the first draft of the spec).
**Why:** with 4 parallel workers, the order of sends changes between runs, so a shared generator hands each contact a different draw every time. The "same seed, same result" test and the README's numbers would then change from run to run. A hash of the key gives the same answer in any order, and a retried key gets the same outcome for free.
**Cost:** the rates are only right on average. Over 10,000 sends that's well inside the test tolerance, but a 50-contact test can't assert exact counts.

## D18 · 2026-10-22 · A send that can't be rendered stops the run instead of being skipped

**Decided:** if an AI-written email fails `checkContent`, the hand-written fallback is used. If the fallback fails too, the send step throws and the batch rolls back.
**Considered:** marking the contact `send_failed` and moving on, as the reviewer suggested.
**Why:** there are only 9 statuses, and a "failed" contact would be stuck in the sequence with no next action, so the run would never finish. The fallbacks are hand-written and tested, so their failing is a code bug, and a bug should stop the run loudly rather than leave contacts behind.
**Cost:** one bad fallback template stops the whole run until it's fixed.
