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

## Words used on this page

- **Tick:** one pass of the system at the current simulated time: deliver replies, label them, deactivate, send.
- **Segment:** a group of contacts with the same job type and industry, e.g. "founder · SaaS".
- **Suppression list:** addresses that must never be emailed again (unsubscribed or bounced).
- **Idempotency key:** a label that is unique per email ("contact 812, follow-up 1"), so sending it twice can be detected and ignored.
- **Fallback:** the simpler option used when the AI fails or the quota is used up.
