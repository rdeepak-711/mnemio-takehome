# Mental model

**Status: PLANNED.** Describes the system as designed. It will be revised as each layer is built.

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

All the data lives in a Postgres database, in 11 tables: the contacts, every email sent, every reply, the do-not-email list, an append-only diary of everything that happened, the one-row simulated clock, the fake mail service's own records, and the AI's cache and daily counter. `npm run db:reset` wipes it and builds every table again from `src/db/migrations/001_init.sql`.

The tables don't just store data, they refuse impossible data. The database won't accept a second email of the same step to the same person, a status that doesn't exist, or a person marked "follow-up 1 sent" who isn't waiting for follow-up 2. The code already tries to prevent all of these, but if a bug ever slipped through, the database stops the bad row at the moment it's written and the whole batch undoes itself. A separate test checks that the database's lists of allowed values match the code's lists exactly, so the two can't quietly disagree.

Two deliberate quirks. Every time in these tables is simulated time written by the code; none is filled in from the real clock, because that would mix real dates into the simulation. And the fake mail service's tables don't point at ours at all: it stands in for an outside company, which wouldn't know our record numbers and whose work stays done even if ours is undone.

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
