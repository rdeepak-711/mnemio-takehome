# T21a — Core dashboard

## Goal

A browser view onto the engine (spec/dashboard.md, T21a part): KPIs, a day slider with the funnel as of that day, a daily activity chart, a journey view of who moved where, a paginated contact table with a detail panel, and controls that advance or reset the simulation through the same engine functions the CLI uses. Every number comes from the database, rebuilt from events (D14, D57); the dashboard has no business logic and no state of its own (D56, D58).

## Files

Create:
- `src/runtime.ts`: builds what the CLI builds (config, pool, provider pool, provider, AI client).
- `src/web/errors.ts`, `src/web/days.ts`, `src/web/summary.ts`, `src/web/timeline.ts`, `src/web/journey.ts`, `src/web/contacts.ts`, `src/web/sim.ts`, `src/web/runtime.ts`, `src/web/http.ts`.
- `app/api/summary/route.ts`, `app/api/timeline/route.ts`, `app/api/journey/route.ts`, `app/api/contacts/route.ts`, `app/api/contacts/[id]/route.ts`, `app/api/sim/advance/route.ts`, `app/api/sim/reset/route.ts`.
- The UI: `app/layout.tsx`, `app/globals.css`, `app/page.tsx`, `app/journey/page.tsx`, `app/contacts/page.tsx`, components in `app/_components/`, animation helpers in `app/_anim/`.
- `next.config.ts`, `next-env.d.ts` (Next writes it).

Change:
- `src/main.ts`: use `openRuntime`, with no change in behaviour.
- `package.json`: the dependencies and scripts below.
- `tsconfig.json`: include `app`, `next-env.d.ts` and `.next/types/**/*.ts`; set `jsx: "react-jsx"`; set `lib: ["ES2022", "DOM", "DOM.Iterable"]`; keep `strict` and `noUncheckedIndexedAccess`.
- `.prettierignore` / format scripts: format `app` too.
- `README.md`: how to run the dashboard.

Tests (written by the harness engineer): `tests/db/web-summary.test.ts`, `tests/db/web-timeline.test.ts`, `tests/db/web-journey.test.ts`, `tests/db/web-contacts.test.ts`, `tests/db/web-sim.test.ts`, `tests/db/web-routes.test.ts`, `tests/unit/web-days.test.ts`, `tests/db/runtime.test.ts`, plus the fixture `tests/helpers/web-fixture.ts`.

## Part 0 — Dependencies and scripts (D56)

Install exactly these. No other runtime dependency (no chart library, no UI kit); charts are SVG.
- `dependencies`: `next@16.4.2`, `react@19.3.0`, `react-dom@19.3.0`, `animejs@4.5.0`.
- `devDependencies`: `@types/react@19.3.0`, `@types/react-dom@19.3.0`.

Run `npm audit --omit=dev` afterwards; it must report 0 vulnerabilities.

Scripts: `"dev": "next dev"`, `"build": "next build"`, `"start": "next start"`. `format` and `format:check` cover `src tests app vitest.config.ts next.config.ts`.

`next.config.ts`: `serverExternalPackages: ['pg']`. Leave Next's TypeScript check on.

## Part 1 — `src/runtime.ts`

```ts
export type Runtime = { config: Config; pool: pg.Pool; providerPool: pg.Pool; provider: Provider; ai: AiClient; close(): Promise<void> };
export function openRuntime(env: Record<string, string | undefined>): Runtime;
```

It does exactly what `src/main.ts` does today:
- `loadConfig(env)`, then `getPool(config.databaseUrl)`.
- A separate `new pg.Pool` for the provider (D43), and `createProvider(providerPool, config)`.
- `createAiClient({ pool, apiKey, models, rpm, dailyBudget })`.

`close()` runs `closePool()` and ends the provider pool, and is safe to call twice. `src/main.ts` then calls `openRuntime(process.env)` and `runtime.close()` in `finally`. Its output and exit codes do not change (`tests/db/cli-run.test.ts` must stay green).

## Part 2 — `src/web/` (read-only queries, no `new Date()` / `Date.now()`; the no-real-clock test already covers `src/`)

**`errors.ts`:** `export class BadRequest extends Error {}` and `export class SimBusy extends Error {}`.

**`days.ts`** (pure):
- `dayKey(t: Date): string` gives the UTC date as `YYYY-MM-DD`.
- `dayStart(key: string): Date` gives 00:00 UTC of that day.
- `nextDay(key: string): string`.
- `parseDay(raw: string | null | undefined): string | null`: `null` or `''` gives `null`. Anything that isn't a real calendar date in exactly `YYYY-MM-DD` form throws `BadRequest` with a message containing `day`. For example `2026-13-01`, `2026-02-30`, `2026-1-5` and `yesterday` all throw.
- `phaseOf(key: string, simStart: Date): 'history' | 'simulated'`: `history` when the end of that day (the next day's 00:00) is at or before `simStart`, otherwise `simulated`.

**`summary.ts`:**

```ts
export type Summary = {
  day: string; phase: 'history' | 'simulated';
  statuses: Record<Status, number>; // all 9 keys
  total: number; active: number; deactivated: number; unsubscribed: number;
  sent: number; replies: number; bounces: number;
  replyRate: Count; bounceRate: Count; // Count from src/report.ts
};
export type CampaignDays = { first: string; today: string; simStart: string };
export async function campaignDays(db: Queryable, simStart: Date): Promise<CampaignDays>;
export async function summaryAt(db: Queryable, day: string, simStart: Date): Promise<Summary>;
```

**`campaignDays`:**
- `today` is `dayKey(getNow(db))`, so it throws the clock's "run npm run seed" error when the clock is not set.
- `first` is the day of the earliest `events.occurred_at`, or `today` when there are no events.
- `simStart` is `dayKey(simStart)`.

**`summaryAt(db, day)`** refuses a `day` after the sim clock's day with `BadRequest` (message contains `future`). Let `end = dayStart(nextDay(day))`. Then:
- **Contacts:** only those with `created_at < end`. Each one's status is the `to` of its last `status_changed` event with `occurred_at < end`, ordered by `occurred_at, id`, or `new` when it has none (D57).
- **Status counts:**
  - `total`: all those contacts.
  - `active`: those whose status is in `IN_SEQUENCE`.
  - `deactivated`: those with status `deactivated`.
  - `unsubscribed`: those with status `unsubscribed`.
- **Sends:**
  - `sent`: sends with `sent_at < end` (accepted or bounced).
  - `bounces`: those with outcome `bounced`.
- **`replies`:** replies with `received_at < end`.
- **Rates**, using the report's definitions (D54), cut off at `end`:
  - `replyRate`: `{ count: distinct contacts with a reply received before end, of: distinct contacts with an accepted send before end }`.
  - `bounceRate`: `{ count: bounces, of: sent }`.
- **`phase`:** `phaseOf(day, simStart)`.

On the sim clock's own day, `statuses` must equal `SELECT status, count(*) FROM contacts GROUP BY status`.

**`timeline.ts`:** `timeline(db, simStart): Promise<TimelineDay[]>`.

```ts
type TimelineDay = {
  day: string; phase: 'history' | 'simulated';
  firstEmails: number; followUps: number; replies: number;
  bounces: number; unsubscribes: number; deactivated: number;
  entered: number; left: number;
};
```

- **Days:** one entry per day from `campaignDays.first` to `campaignDays.today` inclusive, in order, with zeros on empty days.
- **Sends** that day:
  - `firstEmails`: sends with step `first`.
  - `followUps`: sends with any other step.
  - Both count accepted and bounced sends.
- **`replies`:** replies received that day.
- **`bounces`:** sends with outcome `bounced` that day.
- **`status_changed` events** that day:
  - `unsubscribes`: `to = 'unsubscribed'`.
  - `deactivated`: `to = 'deactivated'`.
  - `entered`: `from = 'new'`.
  - `left`: `to` is one of the four finished statuses.

**`journey.ts`:** `movesOn(db, day): Promise<Move[]>` with `type Move = { from: Status; to: Status; count: number }`.
- It covers the `status_changed` events within that day, grouped by `(from, to)`.
- Sort by count, largest first, then by `from` and `to` in `STATUSES` order.
- A day after the sim clock's day throws `BadRequest`.

**`contacts.ts`:**

```ts
export const PAGE_SIZE = 50;
export type ContactRow = {
  id: number; name: string; email: string; company: string; status: Status;
  lastSentAt: Date | null; lastReplyAt: Date | null; nextAction: string | null; nextActionAt: Date | null;
};
export type ContactPage = { page: number; pageSize: number; total: number; rows: ContactRow[] };
export async function listContacts(db: Queryable, opts: { q?: string | null; status?: string | null; page?: number }): Promise<ContactPage>;
export type ContactDetail = {
  contact: ContactRow & { firstName: string; lastName: string; role: string; industry: string; segment: string; timezone: string; createdAt: Date };
  sends: { id: number; step: string; outcome: string; subject: string; body: string; templateSource: string; sentAt: Date }[];
  replies: { id: number; sendId: number; body: string; receivedAt: Date; label: string | null; labelSource: string | null; trueLabel: string; classifiedAt: Date | null }[];
  events: { id: number; type: string; data: unknown; occurredAt: Date }[];
};
export async function contactDetail(db: Queryable, id: number): Promise<ContactDetail | null>;
```

**`listContacts`:**
- **Order:** by `id`, 50 per page. `total` counts every match. A page past the end has `rows: []` with `total` still correct.
- **`page`** defaults to 1; anything that isn't a whole number ≥ 1 throws `BadRequest`.
- **`q`** is trimmed; empty means no filter. It matches case-insensitively as a substring of `first_name || ' ' || last_name`, `email` or `company`. `%`, `_` and `\` in `q` are literal: `q = '%'` matches only a value that actually contains `%`.
- **`status`** must be one of `STATUSES`, else `BadRequest`.
- **`name`** is `first_name + ' ' + last_name`.
- **`lastSentAt` / `lastReplyAt`** are the latest `sends.sent_at` and `replies.received_at` for that contact, or `null`.
- **Speed:** one page on 10,000 contacts must not query per row.

**`contactDetail`:**
- Unknown id gives `null`.
- `sends` ordered by `sent_at, id`; `replies` by `received_at, id`; `events` by `occurred_at, id`.
- `trueLabel` is the mock's hidden label. The UI must label it as such (D12).

**`sim.ts`:**
- `simAdvance(deps: TickDeps, days: number): Promise<{ days: TickSummary[]; violations: Violation[] }>`:
  - Invalid `days` throws `BadRequest`, using the same rule as `advanceDays`: a whole number from 1 to `MAX_ADVANCE_DAYS`.
  - Otherwise it runs `advanceDays(deps, days, onDay)`, collecting every summary, then `checkInvariants(deps.pool)`.
- `simReset(pool: pg.Pool, config: Config): Promise<{ contacts: number }>` runs `resetDb(pool, MIGRATIONS_DIR, { keepAi: true })` then `seed(pool, config)`.
- **Lock:** both share one in-process lock (D58). Validate `days` first (synchronously), then take the lock before the first `await`, so of two requests that arrive together exactly one wins and the other gets `SimBusy` (tests/db/web-routes.test.ts sends two at once and expects one 200 and one 409). While either is running, a second call to either rejects at once with `SimBusy` and touches nothing. The lock is released when the call finishes or throws.

**`runtime.ts`:** `getRuntime(): Runtime` opens `openRuntime(process.env)` once per process and caches it on `globalThis`, so Next's dev reloads don't open new pools. `closeRuntime()` closes it and forgets it.

**`http.ts`:** `handle(fn: () => Promise<unknown>): Promise<Response>`.
- Success gives `Response.json(value)` with status 200.
- `BadRequest` gives 400 `{ error: message }`.
- `SimBusy` gives 409 `{ error: message }`.
- Anything else gives 500 `{ error: message }`.

## Part 3 — Route handlers (`app/api/**/route.ts`)

**Rules for every route file:**
- Export `const dynamic = 'force-dynamic'` and `const runtime = 'nodejs'`.
- Use only the standard `Request` / `Response` objects.
- Get the database and config from `getRuntime()`.
- Wrap the body in `handle()`.

**Routes:**
- **`GET /api/summary?day=YYYY-MM-DD`** returns `{ summary, days }`, where `days` comes from `campaignDays`. With no `day`, it uses `days.today`.
- **`GET /api/timeline`** returns `{ days: TimelineDay[] }`.
- **`GET /api/journey?day=`** returns `{ day, moves }`. It defaults to today.
- **`GET /api/contacts?q=&status=&page=`** returns a `ContactPage`. `page` is parsed with `Number()`, so `abc` or `1.5` give 400.
- **`GET /api/contacts/[id]`**: the signature is `GET(req, { params }: { params: Promise<{ id: string }> })`. It returns the detail. A missing contact gives 404 `{ error: 'contact not found' }`. A non-integer id gives 400.
- **`POST /api/sim/advance`**:
  - The body is `{ days }`.
  - It returns `{ days: TickSummary[], violations }` from `simAdvance`, using deps built from `getRuntime()` as `{ pool, provider, config, ai }`.
  - A missing or bad body gives 400.
  - If any violation is returned, the route still answers 200; the UI shows the violations.
- **`POST /api/sim/reset`** returns `{ contacts }`.

## Part 4 — The UI (spec/dashboard.md "Look and motion"; checked in a browser at review)

**`/` (overview), each item from the APIs above:**
- **Header:** the sim clock's date, labelled "simulated", and the controls: advance 1 day, advance 7 days, reset. Reset asks for confirmation first. While a control runs, every control is disabled and a progress note shows. After it finishes, everything refetches. Invariant violations, if any, appear in a visible error box.
- **KPI row:** total, sent, replies, bounces, unsubscribes, active, deactivated, reply rate and bounce rate, for the selected day. Numbers count up on load and on change.
- **Day slider:** from `days.first` to `days.today`. Below it, the selected date and whether it is "seeded history" or "simulated". Moving it refetches the summary.
- **Funnel:** New → First sent → Follow-up 1 → Follow-up 2 → Follow-up 3 → Deactivated, with Replied, Bounced and Unsubscribed shown as exits. Every bar is labelled with its count and name. Bars grow when the day changes.
- **Daily activity chart:** a stacked bar per day of first emails and follow-ups, plus replies and bounces. History days look visibly different from simulated ones, with a legend saying so. Hovering or focusing a bar shows its numbers. Clicking a bar moves the slider to that day.

**`/journey`:**
- The nine statuses as stages.
- For the selected day (a slider like on `/`), arrows from stage to stage, each labelled with the number of contacts that moved, from `/api/journey`.
- After "advance 1 day" on this page, the moves of the new day animate from stage to stage, with their counts.

**`/contacts`:**
- **Table:** name, company, email, status (text plus colour), last sent, last reply, next action and when. Server-side pages of 50, with previous/next and "page N of M".
- **Search:** the search box debounces by 300 ms.
- **Filter:** a status dropdown.
- **Row:** clicking or pressing Enter on a row opens a detail panel with the contact's fields and one merged timeline. The timeline contains every send (step, outcome, subject, template source), every reply (body, label, label source, and the mock's true label marked "mock's hidden label, used for scoring") and every event, in time order.

**On every page:**
- Loading, empty ("No contacts yet. Run `npm run seed`.") and error states on every data block.
- A sidebar or top navigation between the three pages.
- Keyboard focus is visible.
- Status colour is always paired with text.
- Works at 390px wide with no horizontal scroll and a 16px gutter.
- `prefers-reduced-motion` turns animations off and shows final values at once.

**Anime.js 4.5.0:**
- Import it only in `app/_anim/`. Use v4's named exports (`import { animate, stagger } from 'animejs'`); read `node_modules/animejs/types` before writing a call, and don't guess method names.
- Animations must not delay data: values are correct in the DOM before and after.
- Cancel running animations on unmount and when a new value arrives.

## Edge cases (each one a test)

**`days`:** real-date validation (leap day 2028-02-29 is ok; 2026-02-29 is not); phase at exactly SIM_START.

**`summaryAt`** on the fixed dataset in `tests/helpers/web-fixture.ts`:
- A day before the contact existed.
- A day where the contact had a status change late in the day (23:59:59 counts, 00:00 the next day does not).
- A day after the clock is refused.
- The sim clock's day equals `contacts.status` exactly.
- Rates with nothing to divide.

**`timeline`:** zero-filled gaps; first email vs follow-up split; bounced sends counted as both sent and bounced; `entered` and `left`.

**`movesOn`:** grouping and order.

**`listContacts`:** pagination at 50; page past the end; search on name, email and company, case-insensitive; literal `%`; status filter; bad page or status; `lastSentAt` and `lastReplyAt`.

**`contactDetail`:** ordering; unknown id.

**`simAdvance` / `simReset`:**
- The clock moves exactly N days.
- Bad days are refused before the clock moves.
- A concurrent call gets `SimBusy` and changes nothing.
- The lock is released after an error.
- Reset keeps a saved AI answer and seeds `CONTACT_COUNT` contacts.

**Routes:** 200, 400, 404 and 409 shapes.

**`openRuntime`:** it builds everything from env, refuses a paid model the same way `createAiClient` does, and `close()` is safe to call twice.

Expected failure before the build: `Cannot find module` for `src/web/*`, `src/runtime` and `app/api/*`.

## Explain-back

1. The slider is on day 12. Where does the number in the "Replied" bar come from? Name the table and the rule.
2. Why does clicking "advance 7 days" twice quickly not move the clock 14 days, even though the engine itself would be safe?
3. Why do the route handlers contain no SQL?

## Done when

- All tests pass, and `npm run typecheck`, `npm run format:check`, `npm run build` and `npm audit --omit=dev` are clean.
- The harness then runs `npm run dev` against the 10k probe database and checks every page and control in a browser at desktop and phone width.
