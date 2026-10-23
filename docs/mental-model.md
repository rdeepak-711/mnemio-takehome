# Mental model

**Status: T01–T11 built (23 Oct).** Describes the system as designed; the sections marked "built in Txx" describe code that exists. The engine (T12+) is still planned.

## What it is, in one paragraph

A sales team wants to email 10,000 people: one first email and up to three follow-ups each. This system keeps a record for every person saying where they are in that sequence and when their next email is due. Each time it "ticks", it picks up everyone who is due, writes and sends their next email through a fake mail service, and books the email after that. When someone replies, bounces or unsubscribes, their sequence stops. If nobody answers after the last follow-up and one more wait, the person is marked deactivated. A dashboard shows how this plays out, day by day.

## The five ideas that carry the whole system

**1. Every person has exactly one status and one "next thing to do".** The `contacts` table holds a status (one of 9) and a `next_action` with a date, for example "send follow-up 2 on 14 Nov". Finding who is due means asking the table "whose date has passed?" There's no separate calendar and no list of future emails. Only the next one is ever stored. When someone unsubscribes, their next action is cleared, so there's nothing in the future to delete.

**2. The database itself stops double sends.** Two things could cause a duplicate email: two workers picking the same person at the same moment, or a crash after the email went out but before we wrote that down. For the first, a worker locks the people it picks, and other workers skip locked people instead of waiting (`SKIP LOCKED`). For the second, the `sends` table refuses a second row for the same person and step, and the fake mail service remembers each email's unique key and ignores a repeat.

**3. Time is a number we control.** The system never looks at the real clock to decide what's due. It reads one row, `sim_clock`. Moving that row forward by a day and ticking is how weeks of a campaign play out in minutes. The one exception is the AI quota, which counts real days because that's how OpenRouter counts.

**4. AI is scarce, so it's used once per group, not once per person.** The free AI allows about 50 requests a day. People are put into 20 groups (job type × industry). The AI writes one 4-email sequence per group, and code fills in each person's name and company. Replies are first checked by simple rules ("remove me", auto-reply headers). Only unclear replies go to the AI, 25 at a time. Every AI answer is saved and reused. If the AI is unavailable, a plain written template or a "needs a human" label takes its place, so the system never stops.

**5. Everything that happens is written to a diary.** Every send, bounce, reply, label and deactivation is appended to `events` with its simulated time. Nothing in it is ever changed. The dashboard's day slider reads this diary: "what did the funnel look like on day 12?" is a count of diary entries up to day 12. If something isn't in the diary, the dashboard can't show it.

## Settings: checked once, at the start (built in T02)

All the knobs of the system live in environment variables, usually in a `.env` file: how many contacts, how many days between emails, how often the fake mail service bounces or gets replies, which AI models to try. Environment variables are always text, even the numbers. Before anything else happens, `loadConfig` in `src/config.ts` reads every one of them once. For each it either uses what's given or falls back to a default (an empty line like `AI_RPM=` counts as not given), checks it, and turns the text into a real value: `"3,5,7,7"` becomes the four numbers 3, 5, 7, 7. If anything is wrong, such as three wait days instead of four or reply shares adding up to 90%, the program stops immediately with an error that names the variable. The rest of the code never reads `.env` itself. It gets one checked object and can trust it.

Two details matter later. The start time of the simulation must include a timezone, otherwise two laptops would start the simulation at different moments and get different results. And a missing AI key becomes "no key" (`null`), which is the signal for the AI steps to use their fallbacks, so the system still runs for someone without a key.

The four kinds of reply a contact can send back (interested, not interested, out of office, unsubscribe) are written down once, in `src/labels.ts`. A classifier can give a fifth answer, "needs review", meaning a human should look. Every part of the code takes these words from that one file, so a misspelling anywhere is caught by TypeScript before the code runs.

## The rulebook for where a contact is (built in T03)

Every contact is always in exactly one of 9 statuses. Five mean "still in the sequence": `new` (nothing sent yet), `first_sent`, and `follow_up_1_sent` to `follow_up_3_sent`. Four mean "finished, never email again": `replied`, `bounced`, `unsubscribed`, `deactivated`.

One function, `transition` in `src/lifecycle.ts`, is the rulebook. You give it where a contact is and what just happened (an email was sent, it bounced, a reply came in with a label, or the final wait ran out) and it tells you where the contact is now and what it waits for next. No other part of the code changes a status on its own; they all ask this function. The main rules: emails go strictly in order, one step at a time; "unsubscribe" always wins, from any status; an out-of-office reply leaves everything as it is and only pushes the date back (that part is done by the schedule code, T04); any real reply stops the sequence, including one the classifier isn't sure about; a contact that was deactivated for not answering can still reply and become `replied`, but one that bounced or unsubscribed stays that way.

If something impossible is asked, such as sending follow-up 2 to a contact that hasn't had follow-up 1, the function refuses with an error instead of guessing. That situation can only mean a bug elsewhere, and the error makes the whole send batch roll back so nothing half-done is saved.

## When the next thing is due (built in T04)

Two small date calculations live in `src/schedule.ts`. After an email goes out, `nextActionAt` says when the contact's next action is due: the send time plus that step's wait from `WAIT_DAYS` (3, 5, 7 and 7 days by default). After the fourth email, the "next action" is closing the contact, so the fourth wait is how long we wait for a reply before giving up.

When someone replies "I'm out of office", `oooReschedule` decides the new date. If they said when they're back and that's still ahead, the email waits until the day after. If they didn't say, or the date has already passed, it waits a default number of days (7). Either way, it never makes the email come *earlier* than it was already due.

Neither function looks at the real clock. "Now" is always handed in, because in this system "now" is the simulated clock, not the time on your laptop. That's what lets the same run give the same result on any machine.

## Turning a template into one person's email (built in T05)

The AI writes one email sequence per segment, with blanks in it like `Hi {{first_name}}, I saw {{company}} is hiring`. `render` in `src/templates/render.ts` fills those blanks from one contact's record. Only five blanks exist (first name, last name, company, role, industry), because those are the only facts we have about a person. A blank with any other name, or one we have no value for, stops with an error instead of sending an email with a hole in it. Blanks are filled in one go, so if a company is literally named `{{evil}}`, that text goes in as-is and is never treated as another blank.

Before any email goes out, `checkContent` reads it like a strict proofreader and lists everything wrong: a blank that wasn't filled, an empty or very long subject, a very long body, or a word spam filters dislike ("guarantee", "act now", "winner" and a few more). An empty list means it's fine to send. Filling and checking are separate on purpose: the same check is also used on AI-written templates before they're ever used.

## Grouping people so the AI writes 20 sequences, not 10,000 (built in T06)

Every contact belongs to one of 20 groups, called segments. A segment is two facts put together: the kind of job they do (founder, sales, operations and finance, or tech) and their company's industry (SaaS, e-commerce, fintech, healthcare, logistics). Four kinds of job times five industries is 20. The AI writes one email sequence per segment, and code fills in each person's name and company, so the whole campaign needs about 20 AI calls for writing instead of one per person.

The kind of job comes from the job title, using simple keyword rules in `src/segments.ts`, checked in a fixed order: founder words first, then tech, then sales, then operations and finance. The first rule that matches wins, which is why "Founder, ex-Sales Director" counts as a founder. Keywords must be whole words, so "Director" doesn't count as tech just because it contains the letters "cto". A title that matches nothing goes to operations and finance, and a test pins that so the choice can't change by accident. The seed only uses titles from a fixed list, and a test checks that every one of them lands in the group it was meant for.

## Sorting the obvious replies without AI (built in T07)

Most replies to cold email are easy to sort. Many are automatic out-of-office messages, and the email system usually marks those with a hidden header (`Auto-Submitted`), which is the most reliable sign there is, so it's checked first. Next come plain requests to stop: "unsubscribe", "remove me", "stop emailing me". These count unless the person directly says the opposite ("don't unsubscribe me"). Last, an out-of-office written by hand ("I'm on annual leave until 3 Nov"), unless the person denies it ("Out of office? No, I'm here").

`src/classify/rules.ts` does this with simple text patterns and no AI. When it finds an out-of-office, it also tries to read the return date ("until 3 Nov", "back on 2026-11-10", "returning Monday", "until Monday 3rd November") so the next email can wait until they're back.

The most important rule in this file is that it would rather say "I don't know" (`null`) than guess. A reply the rules can't place goes to the AI later, and an out-of-office with no readable date simply waits the default 7 days. A wrong guess is worse: unsubscribing someone who asked to stay, or emailing someone on the last day of their holiday.

## The filing cabinet, and why it refuses bad paperwork (built in T08)

All the data lives in a Postgres database, in 11 tables: the contacts, every email sent, every reply, the do-not-email list, an append-only diary of everything that happened, the one-row simulated clock, the fake mail service's own records, and the AI's cache and daily counter. `npm run db:reset` wipes the business data and builds those tables again from `src/db/migrations/001_init.sql`. The AI's two tables sit in a separate area of the database (a schema called `ai`, set up by `002_ai_schema.sql`) that the reset leaves alone. That matters for two reasons. The 20 email sequences took real AI calls to write, so throwing them away made every demo after a reset wait minutes to write them again. And the daily counter has to match what OpenRouter has counted: if a reset set ours back to 0 while OpenRouter still remembered 40 calls, our check would happily start calls the account no longer had, and they would all come back as failures. Tests still wipe everything, so each test starts from nothing.

The tables don't just store data, they refuse impossible data. The database won't accept a second email of the same step to the same person, a status that doesn't exist, or a person marked "follow-up 1 sent" who isn't waiting for follow-up 2. The code already tries to prevent all of these, but if a bug ever slipped through, the database stops the bad row at the moment it's written and the whole batch undoes itself. A separate test checks that the database's lists of allowed values match the code's lists exactly, so the two can't quietly disagree.

Two deliberate quirks. Every time in these tables is simulated time written by the code; none is filled in from the real clock, because that would mix real dates into the simulation. And the fake mail service's tables don't point at ours at all: it stands in for an outside company, which wouldn't know our record numbers and whose work stays done even if ours is undone.

## The pretend calendar (built in T09)

The simulation's "today" is one row in the database, and `src/clock.ts` is the only code that reads or moves it. Everything else asks this file what day it is; nothing looks at the computer's own clock, and a test scans every file to make sure (the AI folder is the one exception, because the free AI's daily limit counts real days). Moving the row forward one day and running a tick is how a month of campaign plays out in a minute. The move is a single database statement, so even if two things advance the clock at the same moment, no day is lost.

## The starting crowd, and the inspector (built in T10)

`npm run seed` fills the empty database with 10,000 made-up people and a believable past: 60% haven't been emailed yet, about a quarter are part-way through their four emails, and the rest have already finished one way or another (replied, bounced, unsubscribed, or got all four emails and never answered). The past isn't typed in directly. Each person starts as "new" and is walked step by step through the same rulebook the real engine uses, so the made-up history follows exactly the rules the engine will follow later. A fixed seed number drives every random choice, so running it again on a fresh database gives the same people, the same dates and the same record numbers, which lets a test compare two runs. The whole thing happens in one go: if anything fails half-way, nothing is kept.

`checkInvariants` is the inspector. It asks the database seven questions, such as "does anyone marked as bounced lack a bounce?" and "does anyone's history end at a different status from the one they have now?", and lists every record that fails. The seed runs it at the end. Its own tests feed it data broken on purpose, one way at a time, to prove it catches each kind of break; an inspector only ever shown good data could be blind and nobody would know.

## The pretend email company (built in T11)

The engine never sends real email. It hands each email to `src/mock/provider.ts`, a pretend email company, which answers "accepted" or "bounced" and sometimes schedules a reply to arrive 12–72 hours later. Each decision comes from scrambling the seed number together with the email's unique key (for bounces, the address) into a number between 0 and 1. So the same email always gets the same answer, whichever worker sends it and in whatever order; that's what lets four workers run at once and still give repeatable results. About 3% of addresses are "dead" and bounce whatever is sent to them.

It behaves like an outside company. It keeps its own records (`mock_outbox`, `mock_inbox`) and writes them on its own connection, so if the engine's work is undone after a crash, the company's record that it already got the email stays, just as a real provider wouldn't forget. Sending the same key again gets the first answer back and creates nothing new, which is how a retry after a crash avoids a second email. About 10% of replies to the last follow-up arrive late, 8–21 days after it, when the person has already been given up on; that way the rule "someone we gave up on can still reply" is exercised in every run (D44). The replies come from a bank of written texts, including deliberately tricky ones meant for the AI; a test makes sure the simple rules never give any of them a wrong label.

## Taking a turn without two workers grabbing the same person (built in T12)

Several workers send at once. Before a worker emails anyone, it takes a batch of up to 200 people whose next email is due, and puts a lock on each of those rows in the database. Another worker asking at the same moment doesn't wait for those rows; it skips them and takes the next people in line. The lock lasts until the worker finishes its batch and saves (or gives up and undoes everything), so no two workers ever work on the same person at the same time. People who are finished, or whose only remaining step is "give up on them", are never taken. Someone on the do-not-email list is still taken, because the send step needs to see them to close them off properly.

## Sending a batch (built in T13)

A worker takes a batch of due people (T12) and goes through them one by one. If the person's address is on the do-not-email list, they are closed off (bounced or unsubscribed, whichever the list says) and nothing is sent. Otherwise their email is written: an AI template for their group if there is a good one (from T17), or a hand-written backup email. The person's details are cleaned first (curly braces removed, blanks replaced with "there" or "your company"), so one odd record can never stop the run. The email goes to the pretend email company; its answer is recorded in `sends`; the rulebook moves the person on (next email booked, or closed as bounced); and the diary gets an entry for each step. The whole batch is saved together at the end. If anything goes wrong half-way, all of it is undone, our side only: the email company still remembers what it was handed, so when the batch is retried it gives the same answers and nothing is sent twice.

## Answers coming back (built in T14)

Every simulated day starts with the post. First, any reply the pretend email company has ready (its delivery time has come) is moved into our `replies` table, attached to the email it answers. If we can't find that email, because a crash undid our record of sending it, the reply waits in the company's inbox until the retried send is saved, instead of being thrown away. Then each new reply gets a label. The plain rules go first ("auto-reply" header, "unsubscribe", "out of office"). Anything they can't tell is handed to the AI in groups of 25. If there is no AI, or it fails, or it gives a nonsense answer, the label is "needs review", which counts as a reply and stops the emails: the careful choice. Then the rulebook decides what happens to the person. Interested, not interested or needs review means they are done (`replied`). Unsubscribe means done and on the do-not-email list, even if an email to them had bounced earlier. Out of office keeps them in the sequence but pushes the next email (or the "give up" date) to the day after they say they're back, or a week from now if they don't say; the return date is read from the day they wrote, so "back Friday" means that Friday. A reply from someone already finished is written down and changes nothing, except a late reply from someone we had given up on, which turns them into `replied`. All of this happens before any email is sent that day, so a reply always stops the next email.

## Giving up on the silent ones (built in T15)

Someone who got all four emails and still hasn't answered after the last wait is closed as `deactivated`: we stop chasing them. Each day, after the post has been read, the engine takes up to 500 such people at a time, asks the rulebook to move each one to `deactivated`, and writes it in the diary with that day's date. It runs after replies on purpose: if someone's answer arrives the same day, the answer wins and they become `replied`, and if their out-of-office pushed the date back, they wait until the new date. Giving up isn't final: if a deactivated person writes back later (about 10% of replies to the last email arrive this late), the reply step turns them into `replied`. In a 30-day test run on the 10,000 contacts, 22 people came back like this.

## The one door to the AI (built in T16)

Every question to the AI goes through one function, `complete`, in `src/ai/client.ts`. It works like a careful receptionist. First it checks the filing drawer (`ai.llm_cache`): if this exact question was answered before, it hands back the saved answer, free and instant. The drawer is labelled by the question, not by which AI answered it, so a saved answer is found whichever AI happens to be first in line today. If there's no saved answer, it checks the day's allowance: the free account allows 50 answers a day, and a counter in `ai.llm_usage` stops us at our own limit, with every caller taking a ticket in one step so two can't sneak past together. It also spaces calls a few seconds apart. Then it asks the first free AI on the list. If that AI is busy (429) or broken for a moment (5xx, no answer in 60 seconds), it waits 2 seconds, then 4, and tries again; after that it moves to the next AI. If the AI doesn't exist or refuses the request (404, 400), it moves on at once and leaves that AI alone for 5 minutes. If the key itself is wrong (401, 403), it stops, because every AI would say the same. An answer that isn't the JSON we asked for counts as that AI failing. When nothing works it says "no answer" (`null`), and whoever asked uses their hand-written backup: a fallback email, or the label "needs review". So the AI being down slows nothing and stops nothing. Only free models (names ending in `:free`) are allowed, so a typo can never cost money.

## What the AI actually writes and reads (built in T17)

Two jobs use the AI, both through the one door from T16. **Writing emails:** there are 20 groups of people (4 kinds of job × 5 industries). For each group the AI is asked once for all four emails, written as fill-in-the-blanks templates (`Hi {{first_name}}, …`); the engine fills in each person's details. Within one day, every person in a group shares that one answer, even if 200 of them are sent at the same moment, and a failed answer is remembered for the day, so the hand-written backup email is used rather than asking again and again. Before an AI email is used it must pass a check: only the five allowed blanks, a greeting with the first name, proper paragraphs with "Sam" on the last line, no spam words, no "last week", and four different emails; otherwise the next AI is tried, and if none passes, the backup is used. **Reading replies:** the replies the plain rules couldn't sort are sent to the AI in groups of up to 25, and each answer is saved against the reply's text, so the same words later cost nothing. The replies go in as quoted data, so one that says "ignore your instructions" can't take over; at worst it gets a wrong label from the five allowed ones. Neither job can stop a run: anything that goes wrong becomes "use the backup".

## Words used on this page

- **Tick:** one pass of the system at the current simulated time: deliver replies, label them, deactivate, send.
- **Segment:** a group of contacts with the same job type and industry, written `founder:saas`. There are 20.
- **Suppression list:** addresses that must never be emailed again (unsubscribed or bounced).
- **Idempotency key:** a label that is unique per email ("contact 812, follow-up 1"), so sending it twice can be detected and ignored.
- **Environment variable:** a named setting given to the program from outside its code, e.g. `WAIT_DAYS=3,5,7,7`.
- **Terminal status:** a finished status (`replied`, `bounced`, `unsubscribed`, `deactivated`); no more emails are ever sent.
- **Slot:** a blank in a template, written `{{name}}`, filled from the contact's record.
- **Role family:** the kind of job a title belongs to: `founder`, `sales`, `ops_finance` or `tech`.
- **Auto-reply header:** a hidden line (`Auto-Submitted`) that email systems add to automatic messages such as out-of-office replies.
- **Migration:** a numbered `.sql` file that builds or changes tables; each is applied once and recorded.
- **Constraint (CHECK, UNIQUE):** a rule the database enforces on every row it stores.
- **Fallback:** the simpler option used when the AI fails or the quota is used up.
- **Seed (number):** the starting number for the random choices; the same number always produces the same choices.
- **Invariant:** a rule that must be true of the data at all times, e.g. "a bounced contact has a bounced email".
- **Hash:** a fixed scramble of some text into a number; the same text always gives the same number.
- **Connection pool:** a small set of open database connections that code borrows and returns.
- **Row lock:** a mark the database puts on a row so other transactions can't take it until the lock is released.
- **Transaction:** a group of database changes that are kept all together or not at all.
