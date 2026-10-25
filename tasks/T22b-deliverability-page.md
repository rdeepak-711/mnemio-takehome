# T22b — Deliverability page

## Goal

T22's mailboxes, warm-up limits, pauses, send windows and domain caps are now visible in the dashboard. This is a seventh section, `/deliverability`, plus a card on the overview. Every number and every moving dot comes from `sends`, `mailboxes` and `mailbox_pauses` (D71); the animation never shows an email that isn't a row. Deepak asked for the full page on 25 Oct.

As in T21a and T21b:
- the SQL lives in `src/web/`;
- the route only parses and calls (D56);
- the day is a simulated UTC day (D57);
- Anime.js v4 (`animate`, `stagger`, `createTimeline` imports from `animejs`; check `node_modules/animejs` before using a name);
- `prefers-reduced-motion` shows the final state at once.

## Files

Create:
- `src/web/delivery-view.ts` (pure, no imports from `pg` or Node; the page imports it)
- `src/web/delivery.ts`
- `app/api/delivery/route.ts`
- `app/deliverability/page.tsx`
- New components in `app/_components/`: at least `MailboxGrid.tsx`, `SendStrip.tsx`, `DeliveryCard.tsx`
- New animation helpers in `app/_anim/motion.ts` (add, don't change the existing ones)

Change:
- `app/_components/Nav.tsx`: a seventh link, "Deliverability", after "Activity Log".
- `app/page.tsx`: the `DeliveryCard` on the overview, for the selected day, linking to `/deliverability`.
- `app/globals.css`.

Tests (written by the harness engineer, do not edit):
- `tests/unit/web-delivery-view.test.ts`
- `tests/db/web-delivery.test.ts`
- `tests/db/web-routes-delivery.test.ts`

No new dependency. No engine change.

## Part 1 — `src/web/delivery-view.ts` (pure)

```ts
export const REGIONS = ['americas', 'europe', 'asia', 'australia'] as const;
export type Region = (typeof REGIONS)[number];
export const REGION_NAME: Record<Region, string>; // 'Americas', 'Europe', 'Asia', 'Australia'
export const MAX_DOTS = 12;
export function regionOf(timezone: string): Region;
export function dotSize(maxCell: number): number;
export function dotsFor(emails: number, size: number): number;
```

- `regionOf`:
  - `America/…` → `americas`;
  - `Europe/…` → `europe`;
  - `Australia/…` → `australia`;
  - anything else → `asia`.
- `dotSize(maxCell)` = `max(1, ceil(maxCell / MAX_DOTS))`.
- `dotsFor(emails, size)` = `ceil(emails / size)`, which is 0 for 0 emails.

## Part 2 — `src/web/delivery.ts`

```ts
export type MailboxDay = {
  id: number;
  address: string;
  limit: number; // warm-up limit for that day, the rule of invariant 8
  emails: number; // engine sends from it that day, bounces included
  bounced: number;
  paused: boolean; // a pause covers the end of the day
  pausedUntil: Date | null; // that pause's resume_at
};
export type HourRow = { hour: number; emails: number; bounced: number; regions: Record<Region, number> };
export type DeliveryPause = {
  mailboxId: number;
  address: string;
  pausedAt: Date;
  resumeAt: Date;
  bounceRate: number;
  sample: number;
};
export type DeliveryDay = {
  enabled: boolean;
  day: string;
  window: { startHour: number; endHour: number } | null;
  cap: number | null;
  totals: { emails: number; bounced: number; capacity: number; mailboxes: number; paused: number };
  mailboxes: MailboxDay[];
  hours: HourRow[];
  domains: { domain: string; emails: number }[];
  pauses: DeliveryPause[];
};
export async function deliveryDay(db: Queryable, day: string, delivery: Delivery | null): Promise<DeliveryDay>;
```

Every count is over engine sends: `sends.mailbox_id IS NOT NULL` with `sent_at` in `[day 00:00Z, next day 00:00Z)`. Write that as a range so the indexes apply.

- `delivery` null: return exactly the "off" object in the test, with no queries.
- **`mailboxes`:**
  - which ones: those with `created_at <` the end of the day (the start of the next day), id ≤ `mailboxCount`, ordered by id;
  - `limit`: as invariant 8 computes it:
    - effective start = `GREATEST(created_at, the latest resume_at among that mailbox's pauses whose UTC date ≤ day)`;
    - `age` = day − the UTC date of the effective start;
    - the limit is `age < 0 ? 0 : LEAST(max, start + step × age)`;
  - **do not** read `mailboxes.warmup_started_at` or `paused_until`: they are today's values, and a past day needs the history;
  - `paused`: a pause exists with `paused_at <` end of day `< resume_at`; `pausedUntil` is that pause's `resume_at`.
- **`totals`:**
  - `emails` and `bounced` over the day;
  - `capacity` = the sum of `limit` over `mailboxes`;
  - `mailboxes` = their count;
  - `paused` = how many are paused.
- **`hours`:**
  - always 24 rows, hour 0–23 UTC, zero-filled;
  - `regions` counts emails (bounced included) by `regionOf(contact timezone)`.
  - Do the region grouping in SQL with the same rule (a `CASE` on `timezone LIKE 'America/%'` and so on), or group in TS by calling `regionOf`. The test checks the result either way.
- **`domains`:** the top 8 `recipient_domain` by emails, ties by domain ascending.
- **`pauses`:** every pause with `paused_at <` end of day, newest `paused_at` first, at most 20, joined to the mailbox address. `bounceRate` is a number.

## Part 3 — `GET /api/delivery?day=`

It works like `app/api/stage/route.ts`:
- `parseDay(params.get('day'))`, defaulting to `(await campaignDays(pool, config.simStart)).today`;
- then `deliveryDay(pool, day, config.delivery)`;
- `dynamic = 'force-dynamic'`, `runtime = 'nodejs'`.

## Part 4 — the page `/deliverability`

Follow `app/journey/page.tsx`:
- `useSim()` for `version` and `lastAdvance`;
- a `DaySlider` for the day (with `/api/summary` for the day range, as the journey page does);
- `useApi` for `/api/delivery?day=`.

After an advance, the new day plays once. Moving the slider plays the chosen day.

Sections, top to bottom:

1. **Header.**
   - `<h1>Deliverability</h1>`.
   - A one-line lede: "How the engine spread the day's emails over its mailboxes, the prospects' working hours and their company domains."
   - When `enabled` is false, show only a note: "Deliverability is off (`DELIVERABILITY=off`). Turn it on in `.env` to use mailboxes, warm-up, send windows and domain caps." Nothing else.
2. **KPI row.** Four cards, using the existing KPI count-up:
   - "Emails today": `emails` of `capacity`;
   - "Bounced": `bounced`, and the rate;
   - "Mailboxes paused": `paused` of `mailboxes`;
   - "Busiest domain": the top domain's emails of `cap`, with the domain name, or "none".
3. **Mailbox grid** (`MailboxGrid`).
   - One tile per mailbox, in a grid that wraps (10 across on desktop, 5 on a phone).
   - Each tile shows:
     - a two-digit number;
     - a vertical fill: emails ÷ limit, with the bounced part in the bounce colour on top of the fill;
     - `emails/limit` in small text.
   - A paused tile has the danger border and the text "paused".
   - Each tile has an `aria-label`, e.g. "outreach-03@mail3.mnemio.example: 34 of 40 sent, 2 bounced, paused until 12 Nov".
   - The fills grow with a short stagger when a day plays.
   - A mailbox created later than the day shown isn't listed. With none, show "No mailboxes yet. They are created on the first send with deliverability on."
4. **The day, hour by hour** (`SendStrip`). This is the centrepiece, an SVG.
   - **Layout:** a narrow "mailboxes" bank on the left. To its right, 4 lanes (Americas, Europe, Asia, Australia) × 24 hour columns, with UTC hours labelled every 3 hours.
   - **Cells:** each holds `dotsFor(cell, dotSize(max cell of the day))` dots, laid out in a small grid inside the cell. Bounced dots: the bounced share of the hour gets `dotsFor(hourBounced, size)` dots in that hour's busiest lane, coloured as bounced.
   - **Legend:** "1 dot = N emails · times are UTC".
   - **Play:** a playhead line sweeps from hour 0 to 23 in about 2.4 s. As it reaches each hour, that hour's dots fly from the bank into their cells (a short path, staggered). Bounced dots turn red, then drop a few pixels and fade to 40%. After the sweep, every dot stays in its cell, so the final picture is a heat strip.
   - **Reduced motion:** the final picture at once.
   - **Pausing at night:** a weekend day or a quiet hour simply has no dots. Don't draw anything that isn't in `hours`.
   - **Accessibility:**
     - each cell has a `<title>` with "Europe, 10:00–11:00 UTC: 2 emails";
     - a visually hidden table with the same numbers follows the SVG for screen readers;
     - on a phone the strip scrolls sideways inside its card (`overflow-x: auto`), like the classifier table.
   - **Caption under it:** "Sends follow the prospects' working hours (`9:00–17:00` local, Monday to Friday), so the day moves from Asia to Europe to the Americas." Build the window text from `window`.
5. **Domains.** Bars for the top 8 domains, emails against the cap, with a vertical cap line.
6. **Pauses.** A table: mailbox, paused at, back at, bounce rate (1 decimal %), sample. With none: "No mailbox has paused. A mailbox pauses for 3 days when more than 10% of its last 100 sends bounced (at least 50 sends)." Build the 10% and 3 days from what the page knows. If they aren't in `DeliveryDay`, phrase the sentence without the numbers. Don't add fields.

The overview card (`DeliveryCard`) shows:
- "Deliverability";
- emails of capacity;
- paused of mailboxes;
- a tiny 24-bar sparkline of `hours[].emails`;
- a link "Open deliverability".

When `enabled` is false, it shows "Off".

Style: use the existing CSS variables and card styles in `app/globals.css`. Add a bounce colour variable only if none exists (check first). No gradients or glassmorphism (spec/dashboard-brief.md).

## Rules

- No SQL in `app/`. No `new Date()` without arguments in `src/`.
- The page imports only types from `src/web/delivery.ts`, plus `src/web/delivery-view.ts` for the pure helpers.
- Every animation is built from the fetched numbers. When the data changes mid-animation, cancel the running animation (keep the handles, as `motion.ts` does).
- Check:
  - `npm test`, `npm run typecheck` and `npm run format:check`;
  - `npm run build`: run it with `run_in_background`, because it takes over 30 s;
  - the page in a browser at 1440 px and 390 px, with no horizontal page overflow (only the strip's card scrolls).

## Done when

- The three test files pass, every existing test is still green, typecheck, format and build are clean.
- On a scratch database you seeded yourself (never the `.env` one), after a few advanced days:
  - `/deliverability` shows the grid, the strip playing, domains and pauses;
  - the overview shows the card;
  - the nav has seven links.

## Explain-back questions (for Deepak, after review)

1. On the strip, a cell in the Europe lane at 10:00 shows 3 dots and the legend says "1 dot = 5 emails". How many emails could that cell hold, and where does the exact number come from?
2. Why does the page work out a mailbox's limit for 4 Nov from `created_at` and `mailbox_pauses` instead of reading `mailboxes.warmup_started_at`?
3. Why does the Americas lane stay empty before about 14:00 UTC on a weekday?
