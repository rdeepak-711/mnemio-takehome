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

## D19 · 2026-10-22 · The Postgres image is built with init.sql inside it, not bind-mounted

**Decided:** `docker-compose.yml` builds the `db` image from `docker/Dockerfile` (`FROM postgres:17-alpine` + `COPY init.sql`).
**Considered:** bind-mounting `docker/init.sql` (the T01 task file's first version); adding `/Volumes/asus` to Colima's shared folders.
**Why:** Colima only shares `$HOME` with its VM, so a bind mount from a repo on an external drive arrives as an empty folder and Postgres won't start. A build sends the folder to Docker, so it works from any path on any machine, including an evaluator's. Changing Colima's config would only fix this one laptop.
**Cost:** one extra file, and editing `init.sql` needs `docker compose down -v` then `up -d --build db` to take effect.

## D20 · 2026-10-22 · An empty setting means "use the default"

**Decided:** in `loadConfig`, an optional variable that is missing, empty or only spaces gets its default. `OPENROUTER_API_KEY` that is empty or only spaces becomes `null`.
**Considered:** treating an empty value as an error; passing it through as `""`.
**Why:** `.env` files often have lines like `AI_RPM=`. Passed through, `""` can quietly turn into `0` (`Number("")` is `0`), which is wrong and doesn't fail. Treating it as an error would break the `.env.example` lines that are left blank on purpose (`OPENROUTER_MODELS=`).
**Cost:** someone who writes `AI_RPM=` expecting it to switch something off silently gets 20. The task file didn't specify this case.

## D21 · 2026-10-22 · Numbers are checked as text before they are converted

**Decided:** whole numbers must match `^-?\d+$` and rates `^-?\d*\.?\d+$` before `Number()` runs. Whole numbers must also be safe integers (`z.number().int()`).
**Considered:** zod's `z.coerce.number()`, which converts first and checks after.
**Why:** `Number()` accepts too much. `""` becomes `0`, `"3e0"` becomes `3`, and `"99999999999999999999"` becomes a number JavaScript can't hold exactly. Checking the text first means a typo fails loudly instead of becoming a valid-looking value.
**Cost:** forms some people might expect to work, such as `1e-2` or `1.` for a rate, are rejected.

## D22 · 2026-10-22 · SIM_START must include a time and a timezone

**Decided:** `SIM_START` must be ISO 8601 with a date, a time and an explicit zone (`Z` or `±hh:mm`), e.g. `2026-11-02T09:00:00Z`.
**Considered:** `new Date(value)` with a NaN check, which was the first build and matches the task file's "valid ISO date".
**Why:** review found that `new Date` accepts `1` (as 31 Dec 2000) and `Nov 2 2026`, and reads anything without a zone in the machine's own timezone. The same `.env` would start the simulation at different moments on different laptops, so runs wouldn't be repeatable.
**Cost:** stricter than the task file says, so `2026-11-02` alone is rejected. An impossible day such as `2026-02-31T09:00:00Z` still gets through and rolls over to 3 March. Fixing that is about 3 lines, left out for time.

## D23 · 2026-10-22 · A label given twice in REPLY_MIX is an error

**Decided:** `REPLY_MIX=interested:0.5,interested:0.5` throws naming `REPLY_MIX`.
**Considered:** letting the last value win.
**Why:** a repeated label is almost certainly a typo for another label. Letting the last one win would hide it, and the sum check might not catch it.
**Cost:** none worth noting. The task file didn't specify this case.

## D24 · 2026-10-22 · A reply that needs review stops the sequence

**Decided:** `needs_review` (the classifier isn't sure) moves an in-sequence or deactivated contact to `replied`, the same as `interested` and `not_interested`.
**Considered:** leaving the contact in sequence until a human labels the reply.
**Why:** the person wrote back. Sending them another cold follow-up before anyone has read their reply is the mistake a real sales team would be embarrassed by, and it can't be undone.
**Cost:** if the reply was noise (an empty message, a bounce the rules missed), that contact gets no more emails. The `needs_review` count on the dashboard is how a human would find them.

## D25 · 2026-10-22 · Lifecycle rules live in one pure function that throws on anything not in the table

**Decided:** `transition(status, event)` in `src/lifecycle.ts` is the only place that decides a contact's next status. A send of the wrong step, a bounce on a finished contact, or a deactivation before follow-up 3 throws `InvalidTransitionError`. `expectedStep('follow_up_3_sent')` is `null`, since only deactivation is left (the task file didn't say).
**Considered:** letting each engine module update the status itself; ignoring impossible events instead of throwing.
**Why:** a skipped or repeated step means something upstream is broken (a double claim, a stale row). Throwing turns that into a loud failure inside the send transaction, which rolls back, instead of a quietly wrong status. Keeping it pure means all 118 rule cases are tested in milliseconds with no database.
**Cost:** every caller has to catch or let the error stop the batch. The rules exist twice in the codebase, once in the code and once as a table in the tests, by design.

## D26 · 2026-10-22 · Prettier with the repo's own style, pinned in the project

**Decided:** `.prettierrc` with single quotes, 120-character lines, trailing commas and semicolons. Prettier 3.6.2 is a pinned dev dependency, with `npm run format` and `npm run format:check`. All existing files were formatted once in a single style-only commit.
**Considered:** no formatter (the state until now); Prettier's defaults (double quotes, 80 characters).
**Why:** Deepak's editor formatted `src/lifecycle.ts` on save with its own defaults, turning a reviewed file into a 133-line diff that blocked a merge. With the settings in the repo, the editor, the junior and Claude all produce the same layout. Single quotes and 120 characters match what was already written, so the one-off reformat was 47 lines.
**Cost:** one more dev dependency. A file only stays stable if everyone formats with this config.

## D27 · 2026-10-22 · Dates move in 24-hour steps on the UTC timestamp; an out-of-office lands at the return date + 1 day

**Decided:** `nextActionAt` and `oooReschedule` in `src/schedule.ts` add whole days as `days × 24 h` to the timestamp. An out-of-office with a return date moves the due date to exactly `returnDate + 1 day` (so a return date of `2026-11-04T00:00Z` gives `2026-11-05T00:00Z`), never earlier than the date that was already due. Both functions take `now` as a parameter; a test fails if the file calls `new Date()` with no arguments or `Date.now()`.
**Considered:** calendar-day arithmetic in a local timezone; snapping the out-of-office date to a sending hour such as 09:00.
**Why:** UTC 24-hour steps give the same answer on every machine and need no date library. The simulated clock decides "now", so the schedule must never read the real one. Snapping to a sending hour belongs with timezone send windows (T22), not here.
**Cost:** a contact moved by an out-of-office reply gets its email at the return date's time of day (often midnight UTC) instead of around 09:00. Harmless in the simulation; a real system would snap to working hours.

## D28 · 2026-10-22 · Template filling and the content check: three refinements to the task file

**Decided:** in `src/templates/render.ts`: (1) spam words match case-insensitively from the start of a word (`\b` before, nothing required after), so `guarantee` catches `guaranteed` but `act now` doesn't fire on "cont**act now**"; (2) an allowed slot whose value is empty or only spaces throws, the same as a missing one; (3) `findSlots` reports every slot name in a template, allowed or not, and only `render` rejects unknown ones. `render` fills all slots in one pass, so a value such as a company named `{{evil}}` is inserted as text and never filled again; `checkContent` then flags its braces.
**Considered:** a plain case-insensitive substring match (the task file's wording); passing empty values through; having `findSlots` drop unknown names.
**Why:** a substring match blocks ordinary sentences ("who should I contact now?"), which would push good emails into the fallback for no reason. An empty company produces "I saw  is hiring", which is a broken email, not a valid one. T17 needs to see unknown slots in an AI-written template to reject it, so `findSlots` must report them.
**Cost:** the start-of-word rule only works for words that begin with a letter, digit or underscore. A future spam entry starting with a symbol (e.g. `$$$`) would almost never match; switch to a lookbehind `(?<![A-Za-z0-9_])` if one is added. Spam phrases with doubled spaces ("free  money") aren't caught.

## D29 · 2026-10-22 · Job titles map to a role family by ordered whole-word keyword rules; the odd results are pinned, not fixed

**Decided:** `roleFamily` in `src/segments.ts` checks four keyword rules in the task file's order (founder → tech → sales → ops_finance), whole words, case-insensitive, first match wins, and anything else gets `ops_finance`. The rules are a data table, so the order is visible in one place. Tests pin the results that follow from the order: "Sales Engineer" → `tech`, "VP Sales & Operations" → `sales`, "CTO & Co-founder" → `founder`, and an empty title → `ops_finance`. Every title in `ROLE_TITLES` must map back to its own family.
**Considered:** reordering so sales beats tech (a sales engineer is a pre-sales role); matching keywords as substrings so plurals and joined forms ("Engineers", "RevOps", "CoFounder") are caught.
**Why:** the seed only ever draws titles from `ROLE_TITLES`, and the round-trip test guarantees each lands in its intended family, so the odd cases can't occur in our data. Substring matching would break the rule that keeps "Director" out of `tech` (it contains "cto") and "DevOps" out of `ops_finance`. Pinning the odd cases makes them a visible choice for a reviewer instead of a surprise.
**Cost:** with real imported titles, "Head of RevOps", "Head of Engineers" and "CoFounder" fall to the default `ops_finance`, and "Sales Engineer" gets tech-flavoured emails. ~~`escapeRegExp` is now duplicated in `render.ts` and `segments.ts`; worth one shared helper if a third copy appears.~~ **Resolved 2026-10-22:** Deepak asked for the helper now rather than at a third copy; it lives in `src/regex.ts`, and a test fails if either file defines its own again.

## D30 · 2026-10-22 · The rule classifier says "don't know" rather than guess; five refinements to the task file

**Decided:** `src/classify/rules.ts` follows the task file's rule order (auto-reply header → unsubscribe unless negated → out-of-office phrase unless denied → `null`) with these refinements: (1) curly apostrophes count as straight ones, so "Don’t unsubscribe me" is negated; (2) denial phrases match from the start of a word, so "Juno," isn't "no,"; (3) `Auto-Submitted: No` counts as "no" in any case and with spaces; (4) impossible dates (31 Feb, 2026-02-30) return `null` instead of rolling over; (5) the first date mentioned wins, and every trigger word (until, back on, back, returning, return on) works with every date format. After review, two more: ordinal days ("3rd", "21st") are understood and a weekday written before a date is ignored in favour of the date, and an explicit 4-digit year is used as written.
**Considered:** the task file's literal patterns (straight apostrophe only, substring denials); returning the next Monday for "until Monday 3rd November"; ignoring a written year.
**Why:** the review found two inputs that gave a confidently wrong date: "until Monday 3rd November" (said on Friday 30 Oct) returned 2 Nov, and "until 3 November 2027" returned 2026. A wrong date sends a follow-up while the person is still away; `null` falls back to the default wait, which is merely cautious. Curly apostrophes are what real mail clients type, and the straight-only pattern would unsubscribe someone who asked not to be.
**Cost:** still `null` for phrasings like "back in the office on 3 Nov", "the 1st of December", two-digit years, and an out-of-office that happens to contain "No," anywhere ("…until 3 Nov. No, I won't check email."), since denials are checked across the whole body. These go to the AI or the default wait. The mock provider (T11) should generate out-of-office texts in the supported formats, plus a few unsupported ones on purpose, so both paths are exercised.

## D31 · 2026-10-22 · The mock provider's tables store the idempotency key and reference nothing

**Decided:** `mock_inbox` stores `idempotency_key` (`"<contact_id>:<step>"`) instead of the spec's `contact_id` and `send_id`, and neither `mock_inbox` nor `mock_outbox` has a foreign key. T14 finds the send for a delivered reply through `sends.idempotency_key`. This changes the data model in `spec/site.md`.
**Considered:** the spec as written (`mock_inbox.contact_id`, `send_id`); foreign keys from the mock tables to `contacts` and `sends`.
**Why:** the provider is called before our `sends` row is inserted, so it can't know a `send_id`. It also writes on its own connection, outside our send transaction, to behave like an outside service whose work has already happened if our transaction rolls back (the T13 crash test). A foreign key would make the "outside service" depend on our uncommitted rows and fail exactly in the crash case it's meant to model.
**Cost:** the reply → send link is a text lookup instead of a key, and a reply whose send was rolled back has no send to attach to. T14 must decide what to do with it (it can't happen without a crash between provider and commit).

## D32 · 2026-10-22 · The database refuses impossible contact states, not just the code

**Decided:** `contacts` has CHECKs that `next_action` and `next_action_at` are both set or both null, that `(status, next_action)` is one of the five in-sequence pairs (`new`/`first` … `follow_up_3_sent`/`deactivate`) or a terminal status with no action, and that `segment = role_family || ':' || industry`. `sends` has a CHECK that `idempotency_key = contact_id || ':' || step`.
**Considered:** leaving these to `transition` (T03) and the seed's invariant checks.
**Why:** the invariants in the spec are only checked after a run; a CHECK refuses a bad row at the moment it's written, inside the transaction that caused it, so the batch rolls back with the cause in the error. It's the same reasoning as `UNIQUE (contact_id, step)`: a property of the data, not of careful code.
**Cost:** the pairing of status and next action now lives in two places, `src/lifecycle.ts` and the SQL. Changing the sequence means changing both. `tests/db/schema-drift.test.ts` reads the CHECKs Postgres actually enforces (`pg_get_constraintdef`) and compares them value for value with `STATUSES`, `STEPS`, `LABELS`, `REPLY_LABELS`, `INDUSTRIES`, `ROLE_FAMILIES` and `TERMINAL`, so drift in either direction fails a test. Note for anyone writing these CHECKs: a CHECK that evaluates to NULL passes, which is why the status/next-action rule is a `CASE` (an `IN (...)` with a NULL `next_action` would have let `first_sent` with no next action through).

## D33 · 2026-10-22 · No real-time defaults on business tables

**Decided:** no `DEFAULT now()` on `contacts`, `sends`, `replies`, `suppression`, `events`, `sim_clock` or the mock tables. Every timestamp there is simulated time written by the code. Only `llm_cache.created_at`, `llm_usage` and `schema_migrations` use real time.
**Considered:** `created_at DEFAULT now()` as a convenience.
**Why:** a real-time default would quietly mix wall-clock time into simulated data, break the "same seed → identical rows" hash in T10, and make the day slider show contacts created "in the future" relative to the simulation.
**Cost:** every insert must pass its timestamps explicitly; forgetting one is a not-null error rather than a silent default.

## D34 · 2026-10-22 · Suppressed contacts change status through `transition`, via a new `suppressed` event

**Decided:** `src/lifecycle.ts` gains a fifth event, `{ type: 'suppressed'; reason: 'bounced' | 'unsubscribed' }`: from an in-sequence status it gives `bounced` or `unsubscribed` with no next action; from a terminal status it throws. The send step (T13) uses it when a claimed contact's address is on the suppression list, instead of setting the status directly as the spec first said. Added to T13's scope, with tests in `tests/unit/lifecycle.test.ts`.
**Considered:** the spec as written (the send step sets the status itself); reusing the `reply: unsubscribe` and `bounced` events.
**Why:** T03's whole point is that `transition` is the only place that decides a status (D25). One exception in the send step would be the one path the 118 lifecycle tests don't cover. Reusing `reply: unsubscribe` would be a lie in the event log (there was no reply), and `bounced` normally means this send bounced, which it didn't.
**Cost:** T03 code changes inside T13, and `transition` gets one more case. The `never` checks in `transition` make the build fail until every switch handles it.

## D35 · 2026-10-22 · A mock reply whose send was rolled back waits until the retried send commits

**Decided:** `deliverReplies` (T14) joins `mock_inbox.idempotency_key` to `sends.idempotency_key`. A due mock reply with no matching send is left undelivered, not dropped and not inserted. The report (T19) counts those still waiting as "orphaned".
**Considered:** dropping such rows; inserting the reply with no `send_id`.
**Why:** the gap only exists after a crash between the provider call and our commit (D31). The contact is still due, so the next tick claims it again; the provider returns the same outcome for the same key and creates nothing new; our `sends` row is inserted; and on the following tick the waiting reply finds it. Dropping the reply would lose a real answer. Inserting it without a send would break `replies.send_id NOT NULL` and invariant 5.
**Cost:** a reply can arrive one tick late after a crash. If the contact goes terminal before the retry (for example it unsubscribes by another route), the reply waits forever; the orphaned count makes that visible instead of silent.

## D36 · 2026-10-22 · The clock moves in one atomic UPDATE, and the no-real-clock rule covers all of `src/`

**Decided:** `src/clock.ts` `advance(db, days)` is a single `UPDATE sim_clock SET now = now + make_interval(days => $1) WHERE id = 1 RETURNING now`; `days` must be an integer ≥ 1. `setNow` is an upsert on `id = 1`. A unit test scans every `.ts` file under `src/` and fails on `new Date()` with no arguments or `Date.now(`, except under `src/ai/`, where the daily quota counts real days.
**Considered:** read the time, add a day in TypeScript, write it back; the spec's narrower check of only `src/engine` and `src/mock`.
**Why:** read-then-write loses updates when two callers advance at once (both read Monday, both write Tuesday); one statement can't. A test proves ten simultaneous `advance(1)` calls move exactly ten days. Scanning all of `src/` catches a real-clock call wherever it's added, including the seed and the report, which the narrower check would have missed.
**Cost:** the scan is a text match, so a real-clock call written in an unusual way (for example through an alias) would get past it. `src/ai/` is trusted by folder, not checked.

## D37 · 2026-10-22 · The seed builds history through `transition()`, with a pinned status mix

**Decided:** the seed walks every contact from `new` through `transition()` (the engine's own rulebook) to a target status, writing the sends, replies, suppression rows and events each step implies. The mix is pinned: 60% new; 12 / 8 / 5 / 3% at the four in-sequence statuses; 5% replied, 2% bounced, 2% unsubscribed, 3% deactivated, split exactly by largest remainder. New contacts start in daily waves of 1,000 from `SIM_START`. About a third of in-sequence contacts are already due at `SIM_START`. All randomness comes from one Faker instance seeded with `SEED`; `@faker-js/faker` is pinned at 10.6.0 exactly.
**Considered:** writing statuses straight into `contacts` and generating matching rows separately; all 10,000 contacts starting at `new`; an unpinned Faker version.
**Why:** if the seed writes statuses itself, the seed and the engine can disagree about what a status means, and T20's consistency checks would fail on seed data rather than engine bugs. Starting with history means the dashboard and the engine have mid-sequence, terminal and due contacts on day one. Waves of 1,000 keep the first ticks to a realistic size. Faker's output for a seed changes between versions, so an unpinned version would break "same seed, same rows".
**Cost:** walking each contact through `transition()` is slower than writing statuses, so the inserts are batched to stay under 30 seconds. Upgrading Faker changes the seeded data.

## D38 · 2026-10-22 · `checkInvariants` is one shared checker, tested by breaking data on purpose

**Decided:** `src/invariants.ts` exports `checkInvariants(db, limit = 50)`: read-only SQL, one query per invariant (spec invariants 1–6 plus a 7th, every send has a matching `mock_outbox` row with the same outcome), returning numbered violations. `npm run seed` runs it after seeding; T18 and T20 reuse it. Its tests build a small clean dataset and then break it one way at a time, asserting the exact invariant number reported.
**Considered:** each later task writing its own consistency queries; testing the checker only on seed output.
**Why:** a checker that only ever sees good data could return `[]` for everything and still pass. Breaking the data on purpose proves each check actually fires, and asserting the exact number proves it doesn't fire for the wrong reason.
**Cost:** the checker scans whole tables, so it is a verification tool, not something to run inside every tick.

## D39 · 2026-10-22 · Seeded replies don't count toward classifier accuracy

**Decided:** T19's accuracy figure counts only replies with `received_at ≥ SIM_START`. Seeded replies get `label = true_label`.
**Considered:** counting all replies.
**Why:** seeded labels are copied from the truth, so including them would inflate accuracy with numbers the classifier never produced.
**Cost:** the accuracy figure has nothing to report until the simulation produces replies.

## D40 · 2026-10-22 · Seed details decided during the build

**Decided:** (1) Each contact gets one 09:00–09:59 UTC send minute, and all its sends use it, so the gap between two sends is exactly the wait. (2) The in-sequence "due" window is measured from `SIM_START` itself, not from 09:00 on its date. (3) A seeded reply always arrives before the next step would have been due (delay < that step's wait). (4) Email name parts are letters and digits only; the company domain keeps single hyphens (`smith-jones.example`). (5) Invariant 2 is checked both ways: `bounced` without its signs, and any other status that has a bounced last send or a bounced suppression row. (6) Ids for contacts, sends and replies are reserved from their sequences first, so rows can be linked in memory and inserted in batches.
**Considered:** a new random minute per send; a window anchored at 09:00 on the start date (the first build did this); any reply delay from 0.5–3 days regardless of the wait; stripping hyphens from domains too; inserting row by row and reading back each id.
**Why:** (1) a per-send minute would make some follow-ups go out up to 59 minutes before their wait allows. (2) and (3) came from probing settings the tests didn't cover: with `SIM_START` at 23:30 the 09:00 anchor put 117 contacts outside the window, and with 1-day waits replies landed after the next email was already due, which the engine could never produce. Both now have tests. (4) hyphens keep company names readable and are valid in domains. (5) a bounce with the wrong status is just as broken as a bounced status without a bounce. (6) row-by-row inserts would be 30,000+ round trips; batches finish 10,000 contacts in about one second.
**Cost:** ids only match between runs after `npm run db:reset`, which restarts the sequences. Changing how many random draws a contact uses (as the window fix did) changes the seeded data for the same `SEED`.

## D41 · 2026-10-22 · The mock provider decides bounces per address, replies per email, all by hash

**Decided:** `src/mock/provider.ts` decides every outcome with `draw(seed, purpose, value)`, a SHA-256 hash turned into a number in [0, 1). Bounce uses the address (`draw(seed, 'bounce', to)`); the reply chance, label, text, delay, header and return date each use the idempotency key with their own purpose word. The provider takes a pool, never a client, and writes `mock_outbox` and `mock_inbox` together in its own transaction. A repeated key returns the stored outcome and schedules nothing. The caller passes `now`.
**Considered:** the spec's bounce from `hash(SEED, idempotencyKey)`; one seeded random generator shared by all sends; writing outbox and inbox as separate statements.
**Why:** a real dead address bounces whatever email is sent to it; deciding per email would let a contact's first email succeed and a later one bounce, which isn't how mail fails. A shared generator hands out numbers in call order, so with four workers the results would depend on who sent first; a hash of the key gives the same answer in any order (a test sends the same keys in two orders and compares). Writing both rows in one transaction means a crash can't leave an email remembered with its reply lost, because a retry sees the key and schedules nothing.
**Cost:** this changes the spec's T11 wording. SHA-256 per decision is slower than a generator, which doesn't matter at 10,000 sends.

## D42 · 2026-10-22 · The mock's reply texts must never fool the rules into a wrong label

**Decided:** `REPLY_BANK` in `src/mock/replies.ts` has at least 4 texts per label, at least one deliberately ambiguous. A test runs `classifyByRules` (T07) on every text and on every generated reply: the result is either `null` (left for the AI) or the true label, never a wrong label. Out-of-office replies carry the `Auto-Submitted` header about 75% of the time, and some have no return date.
**Considered:** only clear-cut texts; letting ambiguous texts trip the rules.
**Why:** the rules are trusted without an AI check, so a rule mistake goes straight into the contact's status. Ambiguous texts are still needed so the AI classifier (T17) and its accuracy figure (T19) are tested on hard cases, but those must reach the AI as `null`, not be grabbed by a rule. OOO replies without a header or without a date exercise the phrase rule and the `OOO_DEFAULT_DAYS` fallback.
**Cost:** writing the bank is constrained by the rules' patterns; changing a rule pattern later can break the bank test, which is the point.

## D43 · 2026-10-22 · The mock provider gets its own connection pool (for T13)

**Decided:** when T13 wires the engine to the provider, the provider is given its own `pg.Pool`, not the cached engine pool from `getPool`. T13 adds a test with more workers than the engine pool has connections.
**Considered:** sharing the one pool and capping the number of workers below half its size.
**Why:** each engine worker holds a connection for its send transaction and the provider then needs a second one. With a shared pool of 10, five or more workers take every connection and the provider waits forever; a probe on T11 confirmed it hangs with 10 connections held. A real mail service has its own connections, so a separate pool is also the more faithful model.
**Cost:** two pools means more open Postgres connections (default 10 each, well under Postgres's 100).

## D44 · 2026-10-23 · About 10% of replies to follow-up 3 arrive after deactivation

**Decided:** the mock provider makes 10% (`LATE_REPLY_SHARE`) of replies to `follow_up_3` arrive `waitDays[3] + 1` to `+ 14` days after the send, so they land after the contact is deactivated. Decided per email by `draw(seed, 'late', key)`; the step is read from the idempotency key. The provider config now includes `waitDays`. Every other reply keeps the 12–72 hour delay.
**Considered:** leaving all replies at 12–72 hours (the T11 build); a fixed late delay such as 8–21 days.
**Why:** with only 12–72 hour delays a reply always arrives before the 7-day deactivation wait ends, so the rule "a deactivated contact can still reply and becomes `replied`" (T03) would never happen in a run and would be a claim, not a tested behaviour (Deepak, 23 Oct). Tying the delay to the last wait keeps replies late whatever `WAIT_DAYS` is set to.
**Cost:** the provider now parses the step out of the key, so it depends on the key format `"<contact_id>:<step>"`, which the `sends_idempotency_key_check` constraint already guarantees.

## D45 · 2026-10-23 · `claimDue` takes the caller's client and leaves deactivation and suppression to others

**Decided:** `src/engine/claim.ts` `claimDue(client, now, limit)` runs one `SELECT … ORDER BY next_action_at, id LIMIT $limit FOR UPDATE SKIP LOCKED` on a client the caller has already opened a transaction on. It returns only sending steps (`first` … `follow_up_3`); `follow_up_3_sent` contacts (next action `deactivate`) are left to T15. Suppressed addresses are returned, and the send step (T13) handles them (D34). `limit` must be an integer ≥ 1.
**Considered:** `claimDue` opening and committing its own transaction; plain `FOR UPDATE` without `SKIP LOCKED`; filtering suppressed addresses in the claim query.
**Why:** the lock must last until the contact's send, record and status change commit together, so the claim has to live inside the send step's transaction, not end with its own. Without `SKIP LOCKED`, a second worker would wait for the first instead of taking other contacts, so four workers would run one at a time. Filtering suppressed addresses in the query would leave those contacts due forever; claiming them lets T13 move them to `bounced` or `unsubscribed` through `transition()`.
**Cost:** a caller that forgets `BEGIN` gets a lock that ends with the statement; only T13 calls `claimDue`, and its tests cover parallel workers.

## D46 · 2026-10-23 · The send step: fallback templates now, braces stripped from contact data, duplicate sends fail loudly

**Decided:** (1) T13 adds four hand-written fallback emails (`src/templates/fallback.ts`) and takes an optional `getTemplate(segment, step)` that T17 fills with AI templates; an AI template that fails to render or fails `checkContent` is replaced by the fallback. (2) `contactVars` removes every `{` and `}` from a contact's five slot values before rendering. (3) `sends` is written with a plain `INSERT`, not `ON CONFLICT DO NOTHING` as the spec said. (4) A bounce applies `transition(bounced)` directly (a bounced first email goes `new → bounced`) and adds a `bounced` suppression row. (5) A test-only `afterProviderCall` hook lets the crash test throw between the provider call and the commit.
**Considered:** building T13 only after T17's AI templates; stopping the run when the fallback fails on a contact's data (the spec's rule); `ON CONFLICT DO NOTHING`; crashing the process in the test.
**Why:** (1) the send step must work with no AI at all (no key, or the daily budget spent), so the fallback is the base and the AI is an add-on. (2) Deepak spotted that a company named `{{evil}}` makes the AI template and then the fallback fail `checkContent`, and the spec's "fallback failed, so stop the run" would halt all 10,000 contacts over one bad record; braces carry no meaning in a name, so removing them sends a clean email, and a fallback that still fails is genuinely our bug and still stops the run. (3) With the claim lock, a duplicate can only come from a bug; `DO NOTHING` would skip the status change and leave the contact due, retried every batch for ever, while a loud failure rolls the batch back and names the problem. (5) A thrown error at the exact point is repeatable; killing the process isn't.
**Cost:** a contact's company is stored with braces but emailed without them. A duplicate-send bug stops the whole tick rather than one contact.

## D47 · 2026-10-23 · Contact data can never stop a run: stand-ins for empty values

**Decided:** `contactVars` trims each slot value after removing braces, and gives an empty value a stand-in (`there`, `your company`, `your role`). `industry` is written as text (`SaaS`, `e-commerce`). The fallback emails don't name a time span.
**Considered:** leaving empty values to fail `render` (the first T13 build), which stops the run.
**Why:** probing the first build showed an empty first name, or a company that is only braces, made the fallback throw and halted the whole tick, the same failure D46 fixed for `{{evil}}` reached another way. "Hi there," is a normal email; a stopped campaign isn't. Raw industry codes read badly in an email ("saas teams"), and "my email from last week" is wrong when the first wait is 3 days.
**Cost:** a contact with missing data gets a less personal email instead of being flagged; the report doesn't count these yet.

## D48 · 2026-10-23 · Reply processing: rules first, a classifier that can't stop the run, and unsubscribe beats an earlier bounce

**Decided:** `src/engine/replies.ts` (T14) labels each reply with the rules first, sends only the rest to an optional `classify` function in one call per batch of 25, and turns no classifier, a thrown error, a missing answer or an unknown label into `needs_review` with source `fallback`. A reply's `received_at` is the mock's `deliver_at`, unless that is not after the send's `sent_at` (a send retried after a crash), in which case it is `now`. An out-of-office return date is read relative to `received_at`. A `rescheduled` event is written only when the date actually moves, and an out-of-office also pushes back deactivation. Replies are applied oldest first, with the contact re-read each time. A late "unsubscribe" arriving after a later email bounced makes the contact `unsubscribed` (Deepak, 23 Oct), and invariants 2 and 3 accept that state when the bounced send and the bounced suppression row are both there.
**Considered:** `received_at = deliver_at` always; reading return dates from `now`; letting a classifier error stop the tick; "bounced is final" (changing T03 instead of the invariants); a `rescheduled` event on every out-of-office.
**Why:** a crash between the provider call and our commit can date the retried send after the mock's delivery time, and `deliver_at` would then put a reply before its email (invariant 5). "Back Friday" written on a Wednesday means that Friday, not the Friday after the tick that processed it. The spec requires a full run with no API key, so the AI can never be the reason a tick stops. Unsubscribe is the person's stated wish and the lifecycle table (T03) already says "any state → unsubscribed"; the suppression row keeps its first reason (`bounced`), so the invariants had to learn that pairing. An event for a date that didn't move would put noise in the timeline.
**Cost:** a classifier bug looks like a run of `needs_review` replies instead of an error; T19's source counts are where it shows. `needs_review` stops the sequence (`replied`), so an AI outage stops emails to everyone who replied ambiguously, the cautious choice. The batch transaction stays open during the AI call; acceptable because sending runs after this step, not alongside it. Invariants 2 and 3 are now looser for `unsubscribed`.

## D49 · 2026-10-23 · Deactivation goes through `transition()` in batches of 500, dated at the tick

**Decided:** `src/engine/deactivate.ts` `deactivateDue(pool, now)` locks due `follow_up_3_sent` contacts 500 at a time (`FOR UPDATE SKIP LOCKED`), takes each new status from `transition(status, { type: 'deactivate_due' })`, and writes `status_changed` with reason `deactivate_due` and `occurred_at = now`. No suppression check.
**Considered:** one `UPDATE contacts SET status = 'deactivated' WHERE …` for everyone; dating the event at the contact's `next_action_at`; checking the do-not-email list first.
**Why:** `transition()` is the only place that decides a status (D25, D34); a bare UPDATE would be the one status change the lifecycle tests don't cover. Batches with `SKIP LOCKED` keep parallel calls from deactivating anyone twice and keep each transaction small (the 20-day probe had 6,117 contacts reach this step within days). The tick is when the engine acted, which is what the day slider should show. Deactivating sends nothing, so the list is irrelevant, and a suppressed address can't still be `follow_up_3_sent`.
**Cost:** a few extra queries per 500 contacts compared with one statement; the event time can be up to a day after the contact fell due.

## D50 · 2026-10-23 · The AI client: plain `fetch`, cache keyed without the model, three free models, failures that rest a model

**Decided:** `src/ai/client.ts` (T16) calls OpenRouter with Node's built-in `fetch` rather than the OpenAI SDK the spec named. The cache key is `sha256(kind, prompt version, input)`, with the model in its own column, not part of the key. `OPENROUTER_MODELS` holds three free models in order (`recursive/flint-v1.0:free`, `nvidia/nemotron-3.5-lightning:free`, `nvidia/nemotron-3.5-super-vl:free`), not two; a model without `:free` is refused. The daily budget counts only calls that got an answer: a slot is reserved before each attempt in one SQL statement and given back if the attempt fails. 429, 5xx and timeouts are retried twice (2 s, 4 s, plus up to 0.5 s jitter); 400 and 404 move to the next model at once; 401 and 403 give up; invalid JSON or the wrong shape moves to the next model without a retry. A model that has failed is skipped for 5 minutes. The timeout is 60 s. JSON is asked for in the prompt, not through `response_format`.
**Considered:** the OpenAI SDK; the spec's key with the model in it; two models; counting every attempt against the budget; retrying every error; no resting.
**Why:** the SDK brings its own retries and timeouts that would stack on ours, and is a new dependency for one POST. With the model in the key, an answer saved from Flint is missed whenever Flint is down and Lightning answers, and the same question is paid for again. The live checks (`docs/findings.md`) found 2 of 5 candidates unavailable and one listed model returning 404, so a third model is cheap insurance; failed calls didn't count against OpenRouter's 50 a day, so counting only answers matches what the account actually spends. A 404 or 400 won't fix itself in 2 seconds, a 429 often does. Without resting, a dead first model costs up to 3 attempts on every request; with a 60 s timeout that is minutes per batch. Lightning returned valid JSON without JSON mode, and not every free model advertises it.
**Cost:** the cache can return an answer from a model that is no longer in the list (fine: it was valid when saved). Resting is per process, so a new CLI run tries a dead model again once. A wrong answer in valid JSON (an AI mislabel) is accepted; T19's accuracy figure is where that shows. The model list will need re-checking before the final run, because free models come and go.

## D51 · 2026-10-23 · AI prompts: one shared answer per segment per tick, a per-reply classification cache, checked templates, and resting a model per kind

**Decided:** `src/ai/sequences.ts` (T17) `createSequenceWriter(ai)` keeps one in-memory promise per segment, so every contact of that segment in a tick shares one `complete()` call, and a failure is remembered for the tick; it never throws. AI sequences pass `SequenceSchema`: the four steps, only allowed slots, `{{first_name}}` in each body, render and `checkContent` clean with sample values, no time spans, four different bodies. `src/ai/classify.ts` `createClassifier` caches each answer per normalised reply text, sends only uncached distinct texts (25 per call) as a JSON array marked as data, keeps the good items of a partly bad answer, and never throws. In `src/ai/client.ts`, a bad answer now rests that model for that kind of request only. The pitch matches the fallback emails, and the fallback stays one set (D46), not one per role family.
**Considered:** calling `complete()` per contact (a cache read each time, and on day 1 four workers would all miss the cache together and ask the AI many times for the same segment); caching classifications per batch (a batch of 25 is almost never repeated, single texts often are: the mock's bank repeats them); dropping a whole batch on one bad item; resting a model everywhere after a bad answer; leaving `getTemplate` free to throw.
**Why:** the day's budget is 45 calls; 20 segments is already 20 of them, so a duplicate call per worker or a whole batch lost to one odd label is money we don't have. A thrown error in `getTemplate` would roll back a send batch (`writeEmail` doesn't catch it), which would let the AI stop the run. A model that writes bad email sequences may still label replies well, and Flint, the first model, is built for code, so its emails are the open question. Reply texts are untrusted; as JSON strings they can't close the instructions, and the label is checked against five values.
**Cost:** a failed segment uses the fallback for the rest of the tick even if the AI recovers minutes later. A reply can still talk the AI into a wrong label among the five; T19's accuracy figure is where that shows. The classifier's batch call is also cached under its own key by the client, a row that is rarely reused.

## D52 · 2026-10-23 · The AI cache and call count live in an `ai` schema that `npm run db:reset` keeps

**Decided:** migration `002_ai_schema.sql` moves `llm_cache` and `llm_usage` into an `ai` schema, copying any rows already saved. `resetDb` gains `{ keepAi }`; `npm run db:reset` passes `true`, tests use the default full wipe. The code reads and writes `ai.llm_cache` and `ai.llm_usage`.
**Considered:** leaving both in `public` (every reset drops them); copying the rows out and back in around each reset; editing `001_init.sql`.
**Why:** found while answering "it takes a lot of time to load" (Deepak, 23 Oct): each reset threw away the 20 paid-for sequences, so a demo after a reset waited minutes and spent 20 calls again; and the call count went back to 0 while OpenRouter's didn't, so the budget check would let us send calls the account no longer had, which come back as failures. A separate schema survives `DROP SCHEMA public` with no copying code. `001` has already been applied to existing databases, so changing it would never reach them.
**Cost:** `migrate` now runs `002` after every reset (cheap, and written to be safe to repeat). With `keepAi`, `resetDb` also runs `migrate` once before the drop, so a database still in the old layout has its `public` rows moved into `ai` before `public` is dropped (found in review: `mnemio_probe` had 14 saved answers that the first version would have lost). Each database still has its own count (dev, test and probe), while the account's 50 a day is shared; the count protects one database, not the account.

## D53 · 2026-10-23 · One tick wires every step with a new AI writer per tick; the CLI is `tick`, `advance` and `ai:warm`

**Decided:** `src/engine/tick.ts` `runTick` reads the sim clock and runs deliver → label → deactivate → send, each awaited before the next; with an AI client it builds a new sequence writer and classifier every tick. `advanceDays` checks `days` (whole number, 1–365) before touching the database, then moves the clock one day and ticks, N times. The command line is `src/main.ts` (entry) over `src/cli.ts` (pure `parseArgs`, `formatTick`): `npm run tick`, `npm run advance -- --days N`, `npm run ai:warm`. The mock provider gets its own pool (D43). After `tick` and `advance` the CLI runs `checkInvariants` and exits 1 on any violation.
**Considered:** one writer for the whole run (a segment that failed once would use the fallback for the rest of the run); `npm run run` as the spec literally names it (reads badly; the command inside is still `run`); testing the CLI in-process (its `closePool()` would close the tests' shared pool, so the tests run it as a child process instead); a `--days` that accepts `2.5` or `1e2` (`Number()` would take them).
**Why:** a new writer per tick keeps T17's "one answer per segment" inside a day while letting a failed segment be asked again tomorrow. `ai:warm` answers "it takes a lot of time to load" (Deepak, 23 Oct): the 20 sequences are written once, up front, and every later tick reads them from the cache in milliseconds. Checking the invariants after every CLI run makes a broken state loud.
**Cost:** a failing segment can cost one AI call per tick rather than one per run. The 30-day test on 500 contacts adds to the suite's time (measured in T18). The child-process tests start `tsx` each time, about half a second each.

## D54 · 2026-10-23 · The report: simulated "today", engine-only template and classifier counts, real-day AI calls

**Decided:** `src/report.ts` `report(pool, { simStart, dailyAiBudget })` is read-only SQL. "Today" is the simulated UTC day of the sim clock. Template sources and classifier accuracy count only rows at or after `SIM_START` (the engine's own work); reply and bounce rates are all-time. "Due" means a send step, overdue included; `deactivate` is never "due". AI calls are counted for the real UTC day, from `ai.llm_usage`. It also reports unlabelled replies and orphaned mock replies (D35) as health checks. `npm run report` prints it.
**Considered:** counting the seed's history in accuracy (the seed writes `label = true_label` for its replies, so accuracy would read near 100% whatever the classifier did); a real-clock "today" (meaningless in a simulation that moves 30 days in a minute); counting `deactivate` as due (it isn't an email).
**Why:** the brief asks how the engine behaves, so the numbers that judge the engine (where its emails came from, how well it labelled) must leave out what the seed made up. The AI budget is the one real-world limit, so it's the one real-day number.
**Cost:** two definitions of "today" on one page; the report says "(simulated)" in its first line to make that visible.

## D55 · 2026-10-23 · The full run is a `main.ts` command that stops when nobody is left in sequence

**Decided:** `src/full-run.ts` `fullRun(deps, { maxDays = 60, onDay })` times six phases (reset with `keepAi`, seed, warm the 20 sequences when there is an AI client, advance a day at a time while anyone is in sequence, check invariants, report) with `performance.now`, and `npm run full-run` (`tsx src/main.ts full-run`) prints each day, the timings, the invariants and the report. It exits 1 on any violation or any orphaned mock reply.
**Considered:** `scripts/full-run.ts` as the spec names it (a second copy of the pools, AI client and printing set up in `main.ts`; `scripts/` isn't in `tsconfig.json` either); a fixed 30 days (stops before the last follow-ups and deactivations, or wastes empty days); timing with the sim clock (it measures pretend days, not how long the machine took).
**Why:** the brief asks how long a 10,000-contact run takes and what it ends with; stopping when the sequence is empty measures exactly that. Keeping the AI cache through the reset means a second full run costs no AI calls, so timings are repeatable.
**Cost:** a run with a cold cache and a key includes the AI's minutes in "warm"; the README states which kind of run its numbers come from. `performance.now` is the one real clock outside `src/ai/`, used only for timing, never for business time.

## D56 · 2026-10-25 · Dashboard: Next.js 16.4.2 at the repo root, a tested read layer in `src/web/`, thin route handlers

**Decided:** T21a adds `next@16.4.2`, `react@19.3.0`, `react-dom@19.3.0` and `animejs@4.5.0` (plus `@types/react` and `@types/react-dom` 19.3.0) to the one package, as D14 planned. Every number the dashboard shows comes from read-only functions in `src/web/` that take a `Queryable` and return plain data; they are tested with Vitest against the test database like the rest of the engine. The route handlers in `app/api/**/route.ts` only parse the request, call one `src/web/` function and return `Response.json`; they use the standard `Request`/`Response`, nothing from `next/server`, so tests call them directly. Pages and client components live in `app/`; Anime.js is imported only in `app/_anim/`, so animation never touches data. The pool, provider and AI client the CLI builds are built in one place, `src/runtime.ts`, which `src/main.ts` and the dashboard both use.
**Considered:** Next.js 16.4.0 (the newest release more than two weeks old, but `npm audit` lists three advisories for 16.0.0–16.4.0, two of them critical remote code execution: GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr, and a DoS, GHSA-p3m5-59mp-jv5r); 16.4.3 (two days old); queries inside the route handlers or React server components; `NextResponse`; a second copy of `main.ts`'s set-up in the dashboard.
**Why:** 16.4.2 is the oldest release with none of those advisories (`npm audit`: 0 vulnerabilities), and a spike build with this repo's TypeScript 7.0.2, `strict` and `noUncheckedIndexedAccess` passed Next's own type check. Queries in `src/web/` can be tested with the fixed-dataset approach T19 used, so the dashboard's numbers are proven the same way the report's are. One runtime builder means "controls call the engine" (spec/dashboard.md) is literally the same code path as `npm run advance`.
**Cost:** Next adds about 100 MB to `node_modules` and its first build rewrites parts of `tsconfig.json` (`jsx`, `lib` gains DOM, `include` gains `.next/types`). The DOM types are visible to engine code too. The UI itself (layout, animation) has no automated tests; it is checked in a browser at review.

## D57 · 2026-10-25 · "Day D" on the dashboard is the end of a simulated UTC day, rebuilt from events; days before SIM_START are labelled history

**Decided:** every dashboard query takes a day as `YYYY-MM-DD` and means "as of the end of that simulated UTC day": events, sends and replies with a time before the next day's 00:00 UTC, and contacts created before then. A contact's status on day D is the `to` of its last `status_changed` event before the end of D, or `new` if it has none (one `DISTINCT ON (contact_id)` query, 17–28 ms on the 10k probe database). The slider runs from the day of the first event to the sim clock's day; a day after the sim clock is refused. Days that end at or before `SIM_START` are marked `history` (the seed made them up), later ones `simulated` (the engine produced them). Rates use the same definitions as the report (D54), cut off at the end of D.
**Considered:** stored daily snapshots (D14 already rejected them); a correlated subquery per contact (1.5 s on the probe database, too slow to drag); the start of day D; real dates.
**Why:** the end of the day is what "the funnel on day 12" means to a reader, and the sim clock's own day then matches `contacts.status` exactly (invariant 6 guarantees the replay ends at the current status). The brief asks for a clear line between historical and simulated activity; the seed's backdated history is exactly that line.
**Cost:** a day in progress (the sim clock is at 09:00) shows only what has happened so far that day. Two "todays" again: the dashboard is simulated time throughout, and only the AI budget (not shown in T21a) is a real day.

## D58 · 2026-10-25 · Dashboard controls call `advanceDays` and `resetDb` + `seed`, one at a time per server process

**Decided:** `POST /api/sim/advance {days}` calls `simAdvance`, which runs the engine's `advanceDays` with the same dependencies the CLI builds (`src/runtime.ts`), then `checkInvariants`, and returns every day's tick summary and any violations. `POST /api/sim/reset` calls `simReset`: `resetDb` with `keepAi` and then `seed` with the configured contact count. Both share one in-process lock: a second control request while one is running gets 409 and changes nothing. The page refetches after each control action; there is no push.
**Considered:** a queue of control requests; letting parallel advances run (the engine is safe under concurrency, D03, but two clicks would move the clock two days when the user meant one); running the CLI as a child process from the route.
**Why:** the engine already guarantees correctness under parallel workers, so the lock is about meaning, not safety: one click, one action. Calling the functions directly keeps one code path with the CLI and returns structured summaries instead of parsed text.
**Cost:** the lock is per server process; `npm run advance` in a terminal while the dashboard advances still runs (safely, D03), and the dashboard shows its effect after the next refetch. Advancing 7 days on 10,000 contacts takes about 10 s with a warm cache (T20 measured 54 s for 40 days), and the request is held open that long.

## D59 · 2026-10-25 · `MIGRATIONS_DIR` is built with `path`, not `new URL('./migrations/', import.meta.url)`

**Decided:** `src/db/migrate.ts` builds the migrations folder path as `join(dirname(fileURLToPath(import.meta.url)), 'migrations')`. This is the one change outside T21a's file list, found by the builder and applied by the harness.

**Considered:** keeping `new URL(...)` and configuring Next around it (`serverExternalPackages` only covers packages in `node_modules`; `turbopack.ignoreIssue` would hide the error and leave a broken module at runtime); moving the reset route into a child process that runs `tsx`.

**Why:** Next's bundler (Turbopack) treats `new URL('<relative>', import.meta.url)` as an asset import and cannot resolve a folder, so the production build failed as soon as `app/api/sim/*` reached `src/web/sim.ts` → `src/db/migrate.ts`. The `path` form gives the same absolute path under `tsx`, Vitest and Next, and every existing test that uses `MIGRATIONS_DIR` still passes.

**Cost:** Next warns that the `readdir` in `migrate()` makes it trace the whole project into the server output. That only matters for a deployed build, which this take-home doesn't have; it can be silenced with a `/*turbopackIgnore: true*/` hint later.

## D60 · 2026-10-25 · The AI classifier view scores the engine's labels only, by the report's rules

**Decided:** `/classifier` (and `GET /api/classifier`) covers replies labelled at or after `SIM_START` (`classified_at >= simStart`), the same scope and definitions as the report's classifier line (D54). It shows counts per predicted label (the four reply labels plus `needs_review`, shown as "uncertain, needs review"), the split by label source (rule, AI, fallback), accuracy per source against the mock's true label (`label = true_label`), a true-label × predicted-label table, the number still unlabelled, the number of seeded replies left out, and up to 3 example replies per predicted label, newest classification first. The "explanation" shown for a reply is its label source in words (a rule matched, the AI answered, the fallback was used because the AI gave no answer); the engine stores nothing else about why.

**Considered:** including the seeded replies (the seed writes the correct label in, so accuracy would look perfect); a day filter (the slider already covers time on the other pages, and labels don't change after they're written); asking the AI for an explanation per reply (costs free-tier calls for display only, and would be a new claim the engine never made).

**Why:** the view's job is to show how well the system's own sorting worked. Using the report's scope means the page and `npm run report` give the same numbers, which a test checks.

**Cost:** no per-reply reasoning text. A reviewer sees which mechanism labelled a reply, not why that mechanism chose the label.

## D61 · 2026-10-25 · The activity log shows one row per happening, with descriptions built only from stored event data

**Decided:** `/activity` (and `GET /api/activity?kind=&q=&day=&page=`) lists `events` newest first, 50 per page, joined to the contact's name and email. Each event gets a kind from its stored data: `sent` (a `sent` event with outcome accepted), `bounced` (a `sent` event with outcome bounced), `reply` (`reply_received`, any label but unsubscribe), `unsubscribed` (`reply_received` labelled unsubscribe), `rescheduled`, `deactivated` (`status_changed` with reason `deactivate_due`) and `suppressed` (`status_changed` with reason `suppressed`). The `status_changed` events whose reason is `sent`, `bounced`, `reply` or `unsubscribe` are never listed, because each one repeats the send or reply event written in the same transaction. `describeActivity(kind, data)` turns the stored fields into one sentence, with nothing added. Filters: kind, contact search (name, email, company, as on the contacts page) and one day. The overview shows the first 8 rows for the selected day.

**Considered:** listing every event (each send and each reply would appear twice, once as itself and once as a status change); building descriptions in the browser (the same rules would then live in two places); cursor paging (offset paging is fast enough on 83,000 events and matches the contacts page).

**Why:** the brief's feed is "email sent, follow-up rescheduled, reply received and classified, bounced, unsubscribe received, deactivated", one line each. Every one of those has exactly one event that already holds the facts.

**Cost:** a filter on kind computes the kind for every event in the range; on the 10k run that is tens of milliseconds, measured at review.

## D62 · 2026-10-25 · Stage drill-down lists who was in a stage at the end of a day, by the same rule as the funnel

**Decided:** clicking a funnel bar or a journey stage opens a list from `GET /api/stage?day=&status=&page=` (`stageAt` in `src/web/stage.ts`): the contacts whose rebuilt status at the end of that day (D57) is that status, 50 per page, each with when they entered it, from which status and why (the `status_changed` event's `from` and `reason`; `null` for a contact still `new` with no events). Sorted by most recent entry first; contacts with no entry (still `new`) last, by id. Its `total` equals the funnel's count for that status on that day, which a test checks for every status.

**Considered:** linking to `/contacts?status=X` (only right for today, because `contacts.status` is today's status); listing contacts without the reason (the brief asks to show why contacts stopped).

**Why:** "selecting a stage should reveal the number of contacts and their relevant details" for the day on screen, not for today.

**Cost:** one more `DISTINCT ON` pass per request (the same query shape as the funnel, under 30 ms on the 10k run).

## D63 · 2026-10-25 · Play runs one day per request from the browser and stops on its own

**Decided:** Play repeatedly sends `POST /api/sim/advance {"days":1}`, waits for the answer and the refetch, then waits a pause set by the speed (1× = 1,500 ms, 2× = 600 ms, 4× = 150 ms) before the next day. It stops when Pause is pressed (after the day in progress finishes), when a request fails (including a 409 from another control), when a day returns invariant violations, or when nobody is left in sequence (`active = 0`, the same stop rule as the full run, D55). While playing, every control except Pause and the speed is disabled. The pause lengths and the stop rule are pure functions in `src/web/play.ts` so they are tested.

**Considered:** a server-side loop or timer (state outside the database, and a background job that keeps running when the tab closes); advancing several days per request at higher speeds (fewer refetches, but the screen would skip days).

**Why:** each day stays one engine call through the same lock as the buttons (D58), the screen shows every day, and closing the tab stops the run.

**Cost:** the speed is a pause between days, not a guarantee: a day that takes 2 seconds to tick still takes 2 seconds. With an AI key, playing spends the daily AI budget like `npm run advance` does.

## D64 · 2026-10-25 · Deliverability is one switch, on by default, and the core engine tests switch it off

**Decided:** the T22 features (mailboxes with warm-up and auto-pause, send windows, per-domain caps, List-Unsubscribe) are controlled by `DELIVERABILITY=on|off`, default `on`. `loadConfig` returns `delivery: Delivery | null` (`null` when off). The engine reads `config.delivery`; when it is `null`, `sendDue` and `advanceDays` behave exactly as before T22. The existing engine test helpers (`send`, `tick`, `replies`, `full-run`, `ai-prompts`) set `DELIVERABILITY=off`, so they keep testing the core on its own; the new `delivery-*` tests switch it on.

**Considered:** always on (every core test would then also be a deliverability test, and a failure would not say which part broke); off by default (the CLI and dashboard would not show the bonus unless someone knew to switch it on); a separate flag per feature (five switches, and the send window is useless without hourly ticks anyway).

**Why:** a reviewer can run the system with and without the bonus and compare, and the core numbers measured in T20 stay reproducible with `DELIVERABILITY=off`.

**Cost:** two paths through `sendDue`. The T20 numbers in the README are re-measured in T23 with deliverability on.

## D65 · 2026-10-25 · With deliverability on, a simulated day is 24 hourly ticks

**Decided:** `advanceDays` moves the clock one hour at a time and runs a full tick (replies, classification, deactivation, sends) after each hour, 24 times per day. It still returns one summary per day (the 24 summed, `now` = the end of the day) and calls `onDay` once per day. `npm run run` is still one tick at the current time. With deliverability off, a day is one tick, as before. `src/clock.ts` gains `advanceHours(db, hours)`.

**Considered:** keeping one tick a day at 09:00 UTC (at that moment it is 01:00–05:00 in the Americas and 20:00 in Sydney, so with a 9–17 window those contacts would never be emailed); recording sends at an earlier "slot" time inside the day that just passed (sends would be dated before the replies the same tick already processed, breaking "a reply that arrives before a due send wins"); moving the daily tick to another hour (no single UTC hour is inside working hours in all eight seeded timezones).

**Why:** a send window only means something if the clock passes through the hours of the window.

**Cost:** 24 times as many ticks. Most are cheap (nothing due, or nothing in window), but a day takes longer; measured at review and in T23. Classification runs every hour, so AI batches are smaller; the cache answers most replies because the mock's reply texts repeat (D53), but the AI call count per simulated day can be higher than before.

## D66 · 2026-10-25 · Mailboxes ramp up per UTC day, each contact sticks to one mailbox, and one batch locks one mailbox

**Decided:** `MAILBOX_COUNT` mailboxes (default 50, `outreach-01@mail1.mnemio.example` … spread over five sending domains) are created on the first send with deliverability on (`INSERT … ON CONFLICT DO NOTHING`), with `warmup_started_at` = that moment. A mailbox's limit on a UTC day is `min(WARMUP_MAX, WARMUP_START + WARMUP_STEP × age)`, where age is the number of whole UTC days from the warm-up start's date to that day (defaults 20, 10, 80: 20 on the first day, full at 80 on the seventh). It is counted from the `sends` rows of that mailbox on that UTC day, bounces included. A contact keeps the mailbox of its first engine send (`contacts.mailbox_id`), so its follow-ups come from the same sender. Each send batch locks one mailbox row (`FOR UPDATE SKIP LOCKED LIMIT 1`, the first not-paused mailbox that has due work it may send), counts its sends today, and claims at most its remaining capacity among due contacts whose mailbox is that one or none.

**Considered:** a counter row per mailbox and day, updated per send (two workers locking counters in different orders can deadlock, and a deadlock aborts the batch); one global lock for all sending (exact, but the parallel workers of T13 would just wait in line); reserving capacity in a separate short transaction (a rolled-back batch would leave capacity used that was never sent); handing each contact to whichever mailbox is free (follow-ups would arrive from a different sender than the first email).

**Why:** holding the mailbox row for the whole batch makes the count exact, a transaction never waits for a second mailbox so it cannot deadlock, and parallel workers spread over different mailboxes.

**Cost:** a batch is at most the mailbox's remaining capacity (80 or fewer, not 200), so there are more, smaller transactions. A contact whose mailbox is full or paused waits for it, even if another mailbox has room. Found at the T22b review (25 Oct): the allowance resets at 00:00 UTC and new contacts fill the lowest-numbered mailbox first, so during warm-up the regions whose windows open first in the UTC day use the allowance first, and the low-numbered mailboxes fill while the high ones stay idle (`docs/findings.md`, T22b). Accepted for the simulation; a real sender would start each mailbox's day in its own timezone and spread new contacts over the mailboxes with the most room.

## D67 · 2026-10-25 · A mailbox pauses itself for 3 days when more than 10% of its last 100 sends bounced

**Decided:** after every bounce, the engine looks at that mailbox's last 100 sends (`PAUSE_SAMPLE`) made since its warm-up started or last restarted (`sent_at >= warmup_started_at`). If there are at least 50 (`PAUSE_MIN_SENDS`) and the share that bounced is above `PAUSE_BOUNCE_RATE` (default 0.10), the mailbox is paused: `paused_until` = now + `PAUSE_DAYS` (default 3), its warm-up restarts at `paused_until` (`warmup_started_at` = `paused_until`), and a row goes into `mailbox_pauses` (when, until, the rate and the sample size). The rest of that batch is not sent; those contacts stay due. When `paused_until` has passed, the mailbox is used again at the first day of its warm-up.

**Considered:** counting sends from before the last pause too (a mailbox coming back from a pause would be paused again by its first bounce, because the old bounces are still in the sample); pausing on a fixed number of bounces (a busy mailbox would pause sooner than a quiet one at the same rate); a smaller sample (with 3% background bounces, 2 bounces in the first 20 sends is already over 10% and happens about 12% of the time); pausing forever until someone resumes it (the simulation has no operator).

**Why:** the brief's bounce rate is 3% and spread evenly over addresses, so a healthy mailbox should almost never pause, and a mailbox sending to a bad list should stop within a day. By the binomial formula, 6 or more bounces in 50 sends at 3% has a chance of about 0.4%, and 11 or more in 100 about 0.02%, so a 10k run may see about one pause by chance (an estimate, not a measurement).

**Cost:** a new mailbox can't pause before its 50th send, so a truly bad list costs up to 50 bounces per mailbox. Contacts tied to a paused mailbox wait 3 days and then go out at the restarted warm-up pace.

## D68 · 2026-10-25 · Send windows are the contact's local weekday hours, checked in the claim query

**Decided:** with deliverability on, a due contact is claimed only when, in its own timezone (`contacts.timezone`, an IANA name), the day is Monday to Friday and the hour is in `SEND_WINDOW` (default `9-17`: from 09:00 up to but not including 17:00). The check is SQL in the claim (`($1::timestamptz AT TIME ZONE c.timezone)`, `isodow`, `hour`), so Postgres's timezone data handles daylight saving. `inSendWindow(at, timeZone, window)` in `src/delivery/rules.ts` is the same rule in TypeScript (via `Intl.DateTimeFormat`); a test checks the two agree on every hour across the two daylight-saving changes inside the simulation (Europe 25 Oct 2026, US 1 Nov 2026). A due contact outside its window simply stays due.

**Considered:** snapping `next_action_at` to the next window opening when it is computed (the wait would then depend on the window, and every reschedule path would need to know about it); windows in the sender's timezone (the point is the recipient's inbox at a sensible hour); including weekends (most B2B outreach tools skip them by default).

**Why:** one filter in one query covers first emails, follow-ups and rescheduled sends alike.

**Cost:** weekends stop sending, so the campaign takes longer in calendar days; the full run's 60-day limit is checked in T23.

## D69 · 2026-10-25 · At most 10 engine sends per recipient domain per UTC day, guarded by a non-blocking lock

**Decided:** `sends.recipient_domain` stores the part of the address after `@`. Before sending to a contact, the batch takes `pg_try_advisory_xact_lock(hashtext('mnemio:domain:' || domain))`; if another transaction holds it, or the domain already has `DOMAIN_DAILY_CAP` (default 10) engine sends today (UTC), the contact is skipped for the rest of this tick: it stays due, and later claims in the same `sendDue` call leave it out by id. Bounced sends count.

**Considered:** counting with a join from `sends` to `contacts` on every check (a scan of the day's sends for each send); a blocking `pg_advisory_xact_lock` (two batches holding one domain each and waiting for the other's would deadlock); a cap per mailbox per domain (several mailboxes could still flood one company on the same day).

**Why:** the try-lock never waits, so it cannot deadlock, and while a transaction holds a domain's lock no other one can add to that domain's count, so the count is exact.

**Cost:** a contact skipped because another worker held its domain waits for the next hour's tick, even when the cap had room.

## D70 · 2026-10-25 · Every engine email carries List-Unsubscribe headers and a footer link, with no handler behind them

**Decided:** with deliverability on, every email gets the headers `List-Unsubscribe: <mailto:unsubscribe@mnemio.example?subject=unsubscribe%20<id>-<token>>, <https://mnemio.example/unsubscribe/<id>/<token>>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058 one-click), and the body ends with `\n\n--\nNot interested? Unsubscribe here: <link>`. `<token>` is the first 16 hex characters of `sha256("unsubscribe:<SEED>:<contact id>")`. The headers are stored in `sends.headers` and passed to the provider with the sender address. `checkContent` runs on the template's text before the footer is added. `.example` domains are reserved and never resolve (RFC 2606).

**Considered:** a one-click handler route in the dashboard (nothing is deployed, the links point at a domain that does not exist, and an unsubscribe by link would need its own invariant beside invariant 3); a footer only (mail clients show their unsubscribe button from the header, and Gmail and Yahoo require the one-click header from bulk senders since 2024).

**Why:** the brief asks for the header and the link; recipients in the mock still unsubscribe by replying, which the engine already handles.

**Cost:** the token is derived from `SEED`, which is in `.env.example`, so anyone could forge it; a real system would use an HMAC with a secret key. The footer makes stored bodies up to about 110 characters longer than the 1,200 the content check allows.

## D71 · 2026-10-25 · The deliverability page replays the selected day's real sends hour by hour, one dot for a fixed number of emails

**Decided:** a seventh dashboard section, `/deliverability`, fed by `GET /api/delivery?day=` (`deliveryDay` in `src/web/delivery.ts`). For the selected simulated UTC day it shows: the mailboxes that existed by the end of the day as tiles, each filled by its engine sends that day (bounces included, bounces marked) against its warm-up limit for that day (the rule of invariant 8), and marked paused when a pause covers the end of the day; a 24-hour strip, one column per UTC hour and one lane per recipient region (`regionOf(timezone)`: `America/*` → Americas, `Europe/*` → Europe, `Australia/*` → Australia, anything else → Asia), where the hour's real emails fly as dots from the mailbox bank into their lane, bounced ones turning red and dropping; the top 8 recipient domains against `DOMAIN_DAILY_CAP`; and every pause up to the end of the day, newest first. One dot stands for a fixed number of emails, chosen per day so the busiest cell has at most 12 dots, and the legend says how many. With `DELIVERABILITY=off` the page says so and shows nothing else. The overview gets a small card with the day's emails against capacity and the paused count.

**Considered:** one dot per email (2,000 moving dots a day is noise and slow on a phone); animating mailbox-to-domain lines (500+ domains do not fit on a screen); local-time columns per lane (a lane mixes several timezones, so there is no single local hour to label).

**Why:** the brief asks that "animation must never invent successful sends, replies, or state changes". Every dot is backed by `sends` rows of that hour and lane, the tile numbers are counts, and the strip makes the send windows visible: the wave of sends moves from Asia to Europe to the Americas through the UTC day and stops at weekends.

**Cost:** a dot is a rounded group, so a cell with 1 email and one with the dot size both show one dot; the cell's exact count is in its label and on focus. Capacity is the sum of every mailbox's warm-up limit for the day, including a mailbox that paused partway through it.

## D72 · 2026-10-25 · Each mailbox sends at most its daily limit ÷ the window's hours in any one hour

**Decided:** with deliverability on and `SEND_PACING=on` (the default), a mailbox's capacity for a batch is the smaller of what is left of its daily limit and what is left of its hourly limit, `hourlyLimit(daily, window) = ceil(daily ÷ (endHour − startHour))` (80 a day in a 9–17 window → 10 an hour; 20 → 3). "This hour" is the UTC hour of `now`, counted from that mailbox's `sends` in `[date_trunc('hour', now), +1 hour)`. Invariant 13 checks it after a run. `SEND_PACING=off` keeps T22 behaviour; the T22 test helpers set it off, so those tests keep testing what they were written for, and new tests switch it on.

**Considered:** leaving it (the T22b page showed day 1's 1,000 emails leaving at 10:00 and 14:00 UTC, two bursts, which the brief's bonus asks to avoid: "sends spread across mailboxes and across the working day, not in one burst"); random jitter of send times inside the hour (time would be invented, and replies before sends would need a finer clock); pacing per recipient-local hour (a mailbox serves every timezone, so its pace is a property of the sender, not the recipient).

**Why:** a fixed share per hour is how sending tools pace a mailbox, it is one more count under the mailbox lock D66 already holds, and it also spreads new contacts over more mailboxes, because a mailbox that has used its hour stops taking them.

**Cost:** while mailboxes warm up, fewer emails go out per day when only a few hours have due contacts in window, so the campaign takes more simulated days; the full run is re-measured in T23. With a 0–24 window the hourly share is daily ÷ 24.

## D73 · 2026-10-26 · The live-run page is a day-by-day funnel of all nine statuses, drawn from the same frozen export

**Decided:** `docs/campaign-live-run.html` was rebuilt around one SVG funnel: the five in-sequence statuses as a column of bars (length = share of all 10,000), the four outcomes as boxes beside it, and lines between them for the status changes of the selected day, labelled with the real counts from `events`. A sticky timeline (scrubber, play, keyboard, `#YYYY-MM-DD` hash) drives the funnel, the headline numbers, the three daily charts, the hour chart, and the example emails and replies together. Clicking a stage opens its rules from `transition()` and `WAIT_DAYS`. The embedded JSON is byte-for-byte the one in the first version (sha1 `8be01419…`), so no number changed.

**Considered:** keeping the first version (a status table and stacked bars per day, which answered "how many" but not "who moved where"); a full Sankey across all 44 days (unreadable at 9 nodes × 44 columns); animating individual dots as people (would imply a count per dot that is not true at this scale).

**Why:** the reviewer's question is "what happened to the 10,000"; the funnel answers it on every day, and a browser check confirms every day's nine counts sum to 10,000 and each day's changes equal that day's moves.

**Cost:** the page is now ~1,000 lines of hand-written JS with no tests in the repo; it was checked with a headless-browser script outside the repo (desktop, tablet, phone, light, dark, reduced motion). Moving dots only show direction.
