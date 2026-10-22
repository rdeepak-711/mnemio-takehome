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

## Words used on this page

- **Tick:** one pass of the system at the current simulated time: deliver replies, label them, deactivate, send.
- **Segment:** a group of contacts with the same job type and industry, e.g. "founder · SaaS".
- **Suppression list:** addresses that must never be emailed again (unsubscribed or bounced).
- **Idempotency key:** a label that is unique per email ("contact 812, follow-up 1"), so sending it twice can be detected and ignored.
- **Environment variable:** a named setting given to the program from outside its code, e.g. `WAIT_DAYS=3,5,7,7`.
- **Terminal status:** a finished status (`replied`, `bounced`, `unsubscribed`, `deactivated`); no more emails are ever sent.
- **Fallback:** the simpler option used when the AI fails or the quota is used up.
