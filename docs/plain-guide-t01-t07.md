# What T01–T07 built, in plain words

This is the first half of the foundation: no emails are sent yet, no database tables exist yet. What exists is the workshop (T01) and six small rulebooks (T02–T07) that the rest of the system will follow. Each rulebook is a "pure" piece of code: you give it something, it gives you an answer, and it never touches the database, the internet or the clock. That makes each one quick to test thoroughly — 336 automatic checks run in under a second.

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

## How each task was built

The same loop every time. A "harness" writes the checks first, from the spec, and confirms they fail because nothing is built yet. A "junior" writes the code until every check passes. The harness then reruns everything itself, reads every line, and tries odd inputs the checks didn't cover; anything wrong goes back to the junior. Finally the reasons are written into `docs/decisions.md`, and Deepak explains the key idea back before the task is merged.

The weak spot, stated honestly: the harness and the junior are the same kind of AI model, so they can share a blind spot. The spec, the hand-probing, and Deepak's explain-back are what guard against that. The T02 and T07 bugs above were all found by probing, not by the original checks.

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

Why each choice was made, with what it costs: `docs/decisions.md` (D19–D30 cover these tasks). How the pieces will connect once the engine exists: `docs/flow.md`. The system explained as a whole: `docs/mental-model.md`.
