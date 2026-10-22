# What T01–T11 built, in plain words

This is the whole foundation, built before the engine that actually runs the campaign. It comes in two layers. First the workshop (T01) and six small rulebooks (T02–T07): "pure" pieces of code that take something and give an answer without touching the database, the internet or the clock, so each is quick to test thoroughly. Then the parts that do touch the database (T08–T11): the filing cabinet, the pretend calendar, the starting crowd of 10,000 people, and the pretend email company. Nothing sends emails on its own yet; that's the engine, Layer 3. 528 automatic checks cover all of it.

## The big picture first

A sales team wants to send cold emails to 10,000 people: a first email, then up to three follow-ups, spaced a few days apart. People bounce, reply, go on holiday or ask to be removed. The system has to keep track of every one of them, never email anyone twice by mistake, and use a free AI that is only allowed about 45 requests a day.

Think of it as a small post office:

| Task | Post-office version | What it does |
|---|---|---|
| T01 | The building, the filing cabinet, the testing bench | Project setup, the database in Docker, the test runner |
| T02 | The settings card on the wall | Reads and checks all the settings once, at the start |
| T03 | The rulebook for each person's file | Where a person is in the sequence, and what may happen next |
| T04 | The calendar | When the next email is due, and how holidays push it back |
| T05 | The letter template and the proofreader | Fills in names, then checks the letter before it goes out |
| T06 | The sorting into groups | Puts people into 20 groups so the AI writes 20 letters, not 10,000 |
| T07 | The mail-room clerk | Sorts the obvious replies (holiday, unsubscribe) without the AI |
| T08 | The filing cabinet | The database tables, and the rules that refuse impossible paperwork |
| T09 | The wall calendar | The simulation's "today", which only moves when told to |
| T10 | The starting crowd, and the inspector | 10,000 made-up people with a believable past, and a checker for the whole cabinet |
| T11 | The other post office | A pretend email company that accepts, bounces and replies |

## T01 — The workshop

**What it is.** The empty project: the list of tools it needs (TypeScript, the test runner Vitest, the database library), a strict TypeScript setting that catches mistakes before the code runs, and a Postgres database running inside Docker.

**Two databases, on purpose.** `mnemio` holds the real data you look at. `mnemio_test` is for the automatic checks, which wipe tables as they go, so a test run never destroys the data you're looking at. The database listens on port 5433 instead of the usual 5432 so it can't collide with any other database already on your laptop.

**The connection pool.** Opening a connection to the database is slow, so the code keeps a few open and lends them out (`getPool`). Everyone asking for the same database shares one pool. `closePool` hands them all back so the program can actually finish instead of hanging.

**What went wrong, and why there's a Dockerfile.** The first attempt pointed Docker at a file in the project folder. On this Mac, Docker (through Colima) could only see the home folder, so the file arrived empty and the database wouldn't start. About two hours went into that. The fix was to copy the file into the database image itself, which works from any folder on any machine (decision D19).

**Secrets.** `.env.example` lists every setting with safe example values and is shared in git. `.env` holds your real values, including the AI key, and git ignores it so the key never reaches GitHub.

## T02 — The settings card

**What it is.** All the knobs of the system live in environment variables: how many contacts, how many days between emails, how often the fake mail service bounces. They always arrive as text, even the numbers. `loadConfig` reads every one of them once, at the start, and either hands the rest of the code a clean, checked set of values, or stops immediately with an error that names the bad setting.

**Why stop at the start.** Imagine `WAIT_DAYS=3,5,7` — three waits instead of four. Without the check, the fourth wait would be missing, nobody would ever be closed off after the last email, and you'd only notice days into a run. With the check, the program refuses to start and says `WAIT_DAYS: expected 4 values, got 3`.

**Defaults.** Leave a setting out, or leave it empty (`AI_RPM=`), and a sensible default is used.

**Two bugs found in review.** The tests were all green, but trying odd inputs by hand found: a start date without a timezone was read in the laptop's own timezone (so two laptops would start the simulation at different moments), and an absurdly large number was accepted. Both now fail loudly. The start date must look like `2026-11-02T09:00:00Z`.

**Why the settings are passed in, not read directly.** So each automatic check can hand in its own made-up settings without disturbing the shared, real ones.

**The reply labels live here too** (`labels.ts`): the four kinds of reply a person can send — interested, not interested, out of office, unsubscribe — plus a fifth, "needs review", for when a classifier isn't sure. They're written down once and every other file uses them, so a misspelling anywhere is caught automatically.

## T03 — The rulebook for each person

**What it is.** Every person is always in exactly one of 9 situations. Five mean "still being emailed": not contacted yet, then first email sent, follow-up 1 sent, follow-up 2 sent, follow-up 3 sent. Four mean "finished, never email again": replied, bounced, unsubscribed, deactivated (we gave up after no answer).

One function, `transition`, is the rulebook. You tell it where a person is and what just happened, and it tells you where they are now and what they're waiting for next. No other part of the system changes a person's situation on its own.

**The main rules.**
- Emails go strictly in order, one at a time. You can't skip from the first email to follow-up 2.
- "Unsubscribe" always wins, from any situation.
- An out-of-office reply changes nothing except pushing the date back (that's T04's job).
- Any real reply stops the emails, even one the classifier isn't sure about — you don't keep cold-emailing someone whose reply nobody has read.
- Someone deactivated for not answering can still reply late and become "replied". Someone who bounced can't: the email never reached anyone.

**Refusing instead of guessing.** If asked to do something impossible, like recording follow-up 2 for a person who hasn't had follow-up 1, it refuses with an error. That can only mean a bug somewhere else, and refusing makes the whole batch of sends undo itself instead of saving something half-wrong.

**Why 118 checks.** Every situation × every event is checked — the whole grid, not a few examples — because the bugs hide in the corners nobody thought of.

## T04 — The calendar

**What it is.** Two date calculations. After an email goes out, the next one is due after that step's wait (3, 5, 7 and 7 days by default). After the fourth email, the "next thing" is closing the person off, so the last wait is how long we wait for a reply before giving up.

**Holidays.** When someone replies "I'm out of office, back on 10 Nov", the next email moves to the day after they're back. If they didn't say when, it waits a default 7 days.

**The one rule that matters.** An out-of-office reply only ever *delays* an email, never brings it *forward*. If follow-up 2 was already due on 20 Nov and they're back on 8 Nov, it stays on 20 Nov — otherwise their being away would get them chased sooner.

**No real clock.** "Now" is always handed in, because in this system "now" is the simulated calendar, not the time on your laptop. A check reads the file and fails if it ever looks at the real clock.

## T05 — The template and the proofreader

**What it is.** The AI writes one email per group with blanks in it: `Hi {{first_name}}, I saw {{company}} is hiring.` `render` fills the blanks from one person's record. Only five blanks exist (first name, last name, company, role, industry), because those are the only facts we have about a person. An unknown blank, or a blank with no value, stops with an error instead of sending an email with a hole in it.

**The proofreader.** `checkContent` reads the finished email and lists everything wrong: a blank left unfilled, an empty or overly long subject, an overly long body, or words spam filters dislike ("guarantee", "act now", "winner"…). An empty list means it's fine to send.

**The `{{evil}}` company.** If a company is literally named `{{evil}}`, it's inserted as plain text and never treated as a blank. Then the proofreader sees the braces in the finished email and blocks it. Two lessons: a person's data can never change how the template behaves, and the check looks at the final email, so whatever slipped in gets caught.

**A small improvement on the spec.** Spam words match from the start of a word, so "guarantee" still catches "guaranteed", but "act now" no longer fires on an innocent "who should I contact now?".

## T06 — Sorting people into 20 groups

**What it is.** Every person goes into one of 20 groups: four kinds of job (founder, sales, operations and finance, tech) times five industries. The AI writes one email sequence per group, and the code fills in each person's details. So writing the whole campaign costs about 20 AI requests, not 10,000.

**Why 20 and not 40.** The AI allows about 45 requests a day. On day one, every group needs its sequence written. 20 groups leaves 25 requests for the AI's other job — reading the unclear replies, 25 at a time — plus room for failures. 40 groups would leave 5, and one bad day would leave the AI unable to read replies at all.

**Job title → kind of job.** Simple keyword rules, checked in a fixed order: founder words, then tech, then sales, then operations and finance. First match wins, so "Founder, ex-Sales Director" is a founder. Keywords must be whole words, so "Director" doesn't count as tech just because it contains the letters "cto". A title that matches nothing goes to operations and finance, and a check pins that choice.

## T07 — The mail-room clerk

**What it is.** Before replies reach the AI (the expensive expert), a clerk takes the obvious ones off the pile using plain rules. The clerk knows only two kinds: "I'm away" and "stop writing to me". It asks four questions, always in this order:

1. Is there a hidden "sent automatically" stamp on it? Email systems add one to automatic replies. If so: away.
2. Does it say "unsubscribe" or "remove me" — without "don't"? If so: stop.
3. Does it say "I'm on leave" or "out of office" — without "no, I'm here"? If so: away.
4. Anything else: "not sure", pass it to the AI.

**Why the order.** Automatic holiday replies often end with "click here to unsubscribe". Checking the stamp first stops us from unsubscribing someone who was only on holiday.

**Reading the return date.** For "away" replies, it also reads when they're back: "until 3 Nov", "back on 2026-11-10", "returning Monday", "until Monday 3rd November". If it can't read a date, the email just waits the default 7 days.

**The golden rule: "not sure" beats a guess.** A wrong guess can't be undone — unsubscribing someone who wanted to stay, or emailing someone on the last day of their holiday. "Not sure" costs one AI look, or a short wait, and if the AI has no requests left that day the reply is marked for a human. Review found two inputs where the clerk guessed a wrong date ("until Monday 3rd November" gave the Monday before; "until 3 November 2027" gave 2026); both were fixed before merging.

## T08 — The filing cabinet

**What it is.** Eleven database tables: the people (`contacts`), every email sent (`sends`), every reply (`replies`), the do-not-email list (`suppression`), a diary of everything that happened to each person (`events`), the pretend calendar (`sim_clock`), the pretend email company's own records (`mock_outbox`, `mock_inbox`), and the AI's memory and daily counter (`llm_cache`, `llm_usage`). A migration file builds them, and `npm run db:reset` wipes and rebuilds the whole cabinet.

**The cabinet refuses bad paperwork.** The code is the first line of defence; the database is the second. It refuses, for example, a person marked "follow-up 1 sent" whose next step isn't follow-up 2, a finished person who still has a next email planned, or a second "first email" for the same person. That last one is the double-send guard: even if two workers somehow both try to send the same email, the database keeps only one.

**One trap found during the build.** In Postgres, a rule whose answer is "unknown" (because a value is empty) counts as passing. So the "status and next step must match" rule was written in a way that turns "unknown" into "no", or it would have let an empty next step slip through.

**No real-clock dates.** None of our tables fills in a date from the computer's clock by itself. Every date is written by the code from the pretend calendar, so real dates can't leak into the simulation. (The AI's two tables are the exception: the free AI's daily limit counts real days.)

**The email company's records point at nothing of ours.** `mock_outbox` and `mock_inbox` stand in for an outside company, which wouldn't know our record numbers, and whose work stays done even if ours is undone. So they're keyed by the email's unique label (`"812:follow_up_1"`), not linked to our tables.

## T09 — The wall calendar

**What it is.** The simulation's "today" is a single row in the database, and `src/clock.ts` is the only code that reads or moves it. `getNow` reads it, `setNow` sets it (the seed sets it to the start date), and `advance(days)` moves it forward. A month of campaign plays out in a minute by moving the calendar a day and running the engine, over and over.

**Why a database row, not a variable.** A variable disappears when the program stops; the row survives, so every run, worker and the dashboard agree on what day it is.

**Why `advance` is one step.** "Read today, add a day, write it back" breaks when two things do it at once: both read Monday, both write Tuesday, and a day is lost. One database statement that adds the day itself can't lose one. A check fires ten advances at once and confirms the calendar moves exactly ten days.

**No real clock anywhere.** A check reads every code file and fails if any of them looks at the computer's clock, except the AI folder, because the free AI's daily limit counts real days.

## T10 — The starting crowd, and the inspector

**What it is.** `npm run seed` fills the empty cabinet with 10,000 made-up people and a believable past: 60% not emailed yet, about 28% part-way through their four emails, and the rest already finished (replied, bounced, unsubscribed, or given up on). New people start in daily waves of 1,000, and some part-way people are due on day one, so the engine has real work from the first tick.

**The past follows the rulebook.** Nobody's situation is typed in directly. Each person starts as "new" and is walked step by step through T03's rulebook, so the seed can't invent a past the engine would call impossible.

**Same seed number, same crowd.** One seed number drives every random choice. Run it again on a fresh database and you get the same people, the same dates, even the same record numbers. That's what lets a check compare two runs, and lets anyone reproduce a problem exactly.

**All or nothing.** The whole seed is one transaction: if anything fails half-way, nothing is kept. It refuses to run on a cabinet that already has people in it.

**The inspector.** `checkInvariants` asks the cabinet seven questions and lists everyone who fails one: do the emails match the situation, is every bounce a real bounce, is every unsubscribe on the do-not-email list, are next steps set only for people still being emailed, does every reply come after its email, does each person's diary end where they are now, and does the email company agree with our records. Its checks feed it data broken on purpose, one way at a time, to prove each question really catches its problem; an inspector only ever shown good data could be blind and nobody would know.

**Two bugs found by probing.** All checks passed with the default settings. Trying a start time of 23:30 put 117 people's next email more than two days overdue, because the window was measured from 09:00 instead of the real start time. Trying one-day waits produced replies that arrived after the next email was already due, a past the engine could never produce. Both were fixed and now have checks.

## T11 — The other post office

**What it is.** The engine never sends real email. It hands each email to `src/mock/provider.ts`, a pretend email company, which answers "accepted" or "bounced" and sometimes schedules a reply to arrive 12–72 hours later.

**Same email, same answer.** Every decision comes from scrambling the seed number with the email's unique label (or, for bounces, the address) into a number between 0 and 1. So the answer doesn't depend on which worker sent first or in what order. About 3% of addresses are "dead" and bounce whatever is sent to them, which is how real mail fails.

**It behaves like an outside company.** It keeps its own records on its own database connection. If the engine crashes after the company accepted an email but before saving it, the company still remembers. When the engine retries, the company recognises the label, gives the same answer and creates nothing new, so the person gets one email, not two.

**Late replies.** About 10% of replies to the last follow-up arrive late, after the person has already been given up on, so the rule "someone we gave up on can still reply" actually happens in a run.

**The reply bank.** Replies come from written texts for each kind of reply, including deliberately tricky ones ("Not right now, maybe next quarter", "Who gave you my address?") meant for the AI. Most holiday replies carry the "sent automatically" stamp and a return date in a form the clerk (T07) can read; some don't, to test the fallbacks. A check makes sure the clerk never gives any of these texts a wrong label: it either gets them right or says "not sure".

**A risk found for later.** The company and the engine currently share one set of 10 database connections. A probe showed that when all 10 are held by engine workers, the company waits forever for one. The fix belongs to T13: the company gets its own set of connections (decision D43).

## How each task was built

The same loop every time. A "harness" writes the checks first, from the spec, and confirms they fail because nothing is built yet. A "junior" writes the code until every check passes. The harness then reruns everything itself, reads every line, and tries odd inputs the checks didn't cover; anything wrong goes back to the junior. Finally the reasons are written into `docs/decisions.md`, and Deepak explains the key idea back before the task is merged.

The weak spot, stated honestly: the harness and the junior are the same kind of AI model, so they can share a blind spot. The spec, the hand-probing, and Deepak's explain-back are what guard against that. The T02, T07 and T10 bugs above were all found by probing, not by the original checks.

## Where to look

| Task | Code | Checks |
|---|---|---|
| T01 | `src/db/pool.ts`, `docker/`, `docker-compose.yml`, `vitest.config.ts` | `tests/unit/smoke.test.ts`, `tests/db/connection.test.ts` |
| T02 | `src/config.ts`, `src/labels.ts` | `tests/unit/config.test.ts` |
| T03 | `src/lifecycle.ts` | `tests/unit/lifecycle.test.ts` |
| T04 | `src/schedule.ts` | `tests/unit/schedule.test.ts` |
| T05 | `src/templates/render.ts`, `src/regex.ts` | `tests/unit/render.test.ts`, `tests/unit/regex.test.ts` |
| T06 | `src/segments.ts` | `tests/unit/segments.test.ts` |
| T07 | `src/classify/rules.ts` | `tests/unit/rules.test.ts` |
| T08 | `src/db/migrations/001_init.sql`, `src/db/migrate.ts`, `src/db/reset.ts` | `tests/db/schema.test.ts`, `tests/db/schema-drift.test.ts` |
| T09 | `src/clock.ts` | `tests/db/clock.test.ts`, `tests/unit/no-real-clock.test.ts` |
| T10 | `src/seed/seed.ts`, `src/seed/run.ts`, `src/invariants.ts` | `tests/db/seed.test.ts`, `tests/db/invariants.test.ts` |
| T11 | `src/mock/provider.ts`, `src/mock/replies.ts` | `tests/db/provider.test.ts`, `tests/unit/mock-replies.test.ts` |

Why each choice was made, with what it costs: `docs/decisions.md` (D19–D43 cover these tasks). How the pieces will connect once the engine exists: `docs/flow.md`. The system explained as a whole: `docs/mental-model.md`.
