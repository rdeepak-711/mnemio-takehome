# T21b — Dashboard extras

## Goal

The rest of `spec/dashboard.md` and the brief, on top of T21a:
- the AI classifier view;
- the activity log, with a recent-activity feed on the overview;
- play and pause with a speed;
- stage drill-down from the funnel and the journey;
- the sidebar with all six sections.

As in T21a, every number comes from the database, the SQL lives in `src/web/`, and the routes only parse and call (D56). Decisions: D60 (classifier), D61 (activity), D62 (stage), D63 (play).

## Files

Create:
- `src/web/classifier.ts`, `src/web/activity.ts`, `src/web/stage.ts`, `src/web/play.ts`.
- `app/api/classifier/route.ts`, `app/api/activity/route.ts`, `app/api/stage/route.ts`.
- `app/timeline/page.tsx`, `app/classifier/page.tsx`, `app/activity/page.tsx`.
- New components in `app/_components/`, animation helpers in `app/_anim/`.

Change:
- `app/_components/Nav.tsx`: the six sections.
- `app/_components/sim.tsx`: Play/Pause and the speed.
- `app/page.tsx`: the classifier card, the recent-activity feed, and a click on a funnel bar opens the drill-down.
- `app/_components/Funnel.tsx`, `app/journey/page.tsx` / `app/_components/JourneyMap.tsx`: the stage drill-down.
- `app/contacts/page.tsx`: read `?status=` and `?q=` from the URL on load.
- `app/globals.css`.
- `README.md`: the Dashboard section.

Tests (written by the harness engineer, do not edit): `tests/unit/web-play.test.ts`, `tests/db/web-activity.test.ts`, `tests/db/web-classifier.test.ts`, `tests/db/web-stage.test.ts`, `tests/db/web-routes-extras.test.ts`. The shared fixture `tests/helpers/web-fixture.ts` now writes the same event data and reasons as the engine.

No new dependency.

## Part 1 — `src/web/play.ts` (pure, D63)

```ts
export const PLAY_SPEEDS = [1, 2, 4] as const;
export type PlaySpeed = (typeof PLAY_SPEEDS)[number];
export function playDelayMs(speed: PlaySpeed): number; // 1 → 1500, 2 → 600, 4 → 150; anything else throws an Error naming "speed"
export function stopReason(s: { active: number; violations: number; error?: string | null }): string | null;
```

`stopReason` returns the first of these that applies:
- the error text, when there is an error;
- `'1 invariant violation'` or `'N invariant violations'`, when `violations > 0`;
- `'Nobody is left in the sequence'`, when `active === 0`;
- otherwise `null`.

## Part 2 — `src/web/activity.ts` (D61)

```ts
export const ACTIVITY_KINDS = ['sent', 'bounced', 'reply', 'unsubscribed', 'rescheduled', 'deactivated', 'suppressed'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type ActivityRow = { id: number; at: Date; kind: ActivityKind; contactId: number; name: string; email: string; description: string };
export type ActivityPage = { page: number; pageSize: number; total: number; rows: ActivityRow[] };
export function describeActivity(kind: ActivityKind, data: Record<string, unknown>): string;
export async function listActivity(db: Queryable, opts: { kind?: string | null; q?: string | null; day?: string | null; page?: number }): Promise<ActivityPage>;
```

**The kind of an event**, computed in SQL from `type` and `data`:

| Event | Kind |
| --- | --- |
| `sent`, `outcome = 'accepted'` | `sent` |
| `sent`, `outcome = 'bounced'` | `bounced` |
| `reply_received`, `label = 'unsubscribe'` | `unsubscribed` |
| any other `reply_received` | `reply` |
| `rescheduled` | `rescheduled` |
| `status_changed`, `reason = 'deactivate_due'` | `deactivated` |
| `status_changed`, `reason = 'suppressed'` | `suppressed` |
| any other `status_changed` | no kind, never listed |

**`describeActivity`** builds exactly these strings and nothing else.

Step names:

| Step | Name |
| --- | --- |
| `first` | First email |
| `follow_up_1` | Follow-up 1 |
| `follow_up_2` | Follow-up 2 |
| `follow_up_3` | Follow-up 3 |

Label words:

| Label | Words |
| --- | --- |
| `interested` | interested |
| `not_interested` | not interested |
| `out_of_office` | out of office |
| `unsubscribe` | unsubscribe |
| `needs_review` | needs review |

Source words:

| Source | Words |
| --- | --- |
| `rule` | a rule |
| `ai` | the AI |
| `fallback` | the fallback (no AI answer) |

The strings:

| Kind | Description |
| --- | --- |
| `sent` | `<Step> sent` |
| `bounced` | `<Step> bounced; address added to the do-not-email list` |
| `reply` | `Reply received, labelled <label words> by <source words>` |
| `unsubscribed` | `Unsubscribe request received (labelled by <source words>); address added to the do-not-email list` |
| `rescheduled` | `Out of office: next email moved from <data.from as YYYY-MM-DD> to <data.to as YYYY-MM-DD>` |
| `deactivated` | `Deactivated: no reply after the last follow-up` |
| `suppressed` | `Not emailed: address already on the do-not-email list; now <data.to>` |

**`listActivity`** returns events newest first, ordered by `occurred_at DESC, id DESC`, 50 per page (reuse `PAGE_SIZE` from `contacts.ts`). Each row is joined to `contacts` for the name (`first_name || ' ' || last_name`) and email.

Filters, all optional and combinable:
- **`kind`:** must be one of `ACTIVITY_KINDS`, otherwise `BadRequest`.
- **`q`:** the same search as `listContacts` (trimmed, case-insensitive substring of name, email or company, `%` `_` `\` literal). Share the pattern helper, don't copy it.
- **`day`:** `YYYY-MM-DD` validated with `parseDay`. Only events within that UTC day are listed. A day after the sim clock is a `BadRequest` (use `refuseFuture`).
- **`page`:** a whole number ≥ 1, otherwise `BadRequest`. A page past the end returns empty rows with the correct `total`.

The kind is a SQL `CASE`. Filtering on it is fine. Never query per row.

## Part 3 — `src/web/classifier.ts` (D60)

```ts
export type ClassifierExample = { id: number; contactId: number; body: string; label: Label; labelSource: string; trueLabel: string; receivedAt: Date; classifiedAt: Date };
export type ClassifierStats = {
  simStart: string;                  // dayKey(simStart)
  total: number;                     // labelled replies with classified_at >= simStart
  excludedSeeded: number;            // labelled replies with classified_at < simStart
  unlabelled: number;                // label IS NULL
  byLabel: Record<Label, number>;    // all five keys of LABELS, in LABELS order
  bySource: { rule: number; ai: number; fallback: number };
  accuracy: { rule: Accuracy; ai: Accuracy }; // Accuracy from src/report.ts; correct = label = true_label
  confusion: { trueLabel: string; label: string; count: number }[]; // non-zero cells; ordered by REPLY_LABELS index of trueLabel, then LABELS index of label
  examples: Record<Label, ClassifierExample[]>; // up to 3 per predicted label, classified_at DESC, id DESC; all five keys, in LABELS order
};
export async function classifierStats(db: Queryable, simStart: Date): Promise<ClassifierStats>;
```

Everything except `unlabelled` and `excludedSeeded` is scoped to `classified_at >= simStart`. The numbers must equal `report()`'s classifier line (a test compares them).

Use a few grouped queries, plus one window query (`row_number() OVER (PARTITION BY label ORDER BY classified_at DESC, id DESC) <= 3`) for the examples.

## Part 4 — `src/web/stage.ts` (D62)

```ts
export type StageRow = { id: number; name: string; email: string; company: string; since: Date | null; from: string | null; reason: string | null };
export type StagePage = { day: string; status: Status; page: number; pageSize: number; total: number; rows: StageRow[] };
export async function stageAt(db: Queryable, day: string, status: string, opts: { page?: number }): Promise<StagePage>;
```

**Who is listed:** the same rebuild as `summaryAt` (D57).
- Take contacts with `created_at < end`.
- For each, find the last `status_changed` before `end`, ordered by `occurred_at`, then `id`.
- The contact's status is that event's `to`, or `new` when there is none.
- Keep the contacts whose status is the one asked for.
- Share the SQL or the subquery with `summary.ts`; don't write a second copy of the rule.

**Each row:**
- `since` is that event's `occurred_at`.
- `from` and `reason` come from its data.
- All three are `null` when there is no event.

**Order:** `since DESC NULLS LAST`, then `id`.

**Refused with `BadRequest`:**
- an unknown status;
- a bad page;
- a future day.

## Part 5 — Routes

Same rules as T21a: export `dynamic = 'force-dynamic'` and `runtime = 'nodejs'`, plain `Request`/`Response`, wrap the body in `handle()`, no SQL.

- `GET /api/classifier` returns `classifierStats(pool, config.simStart)`.
- `GET /api/activity?kind=&q=&day=&page=` returns an `ActivityPage`. Parse `page` with `Number()`, as `/api/contacts` does.
- `GET /api/stage?status=&day=&page=` returns a `StagePage`.
  - `day` defaults to the sim clock's day.
  - A missing `status` is a 400.

## Part 6 — The UI

Every new block has loading, empty and error states. Status colours always come with text. The layout works at 390 px with no sideways scroll. Animations go through `app/_anim/` only and respect reduced motion.

**Sidebar** (`Nav.tsx`), in this order:

| Section | Page |
| --- | --- |
| Overview | `/` |
| Campaign Timeline | `/timeline` |
| Contact Journeys | `/journey` |
| AI Classifier | `/classifier` |
| Contacts | `/contacts` |
| Activity Log | `/activity` |

**`/timeline`:**
- The daily activity chart, full width.
- A table with one row per day from `/api/timeline`: date; phase (text: "seeded history" or "simulated"); first emails; follow-ups; replies; bounces; unsubscribes; deactivated; entered; left. Newest first.
- A filter: all days, simulated only, or history only.

**`/classifier`:**
- A disclaimer at the top: "These are labels the system produced, scored against the mock's hidden true label. They are not claims about real people."
- Count and percentage per predicted label as bars, with "needs review" shown as "Uncertain (needs review)".
- The split by source.
- Accuracy for rules and for the AI, as "N of M correct (P%)", or "nothing labelled yet" when M = 0.
- The confusion table.
- Example replies grouped by predicted label. Each shows the body, the source in words, and the mock's hidden label marked as such.
- The counts of unlabelled replies and of seeded replies left out, each with one sentence saying why.

**`/activity`:**
- Filters: kind (a select listing all seven kinds by human name), a contact search debounced by 300 ms, and a day (a date input bounded by `days.first` and `days.today`).
- The filters live in the URL query string.
- One row per event: time (UTC), kind as a badge with text, contact name (links to `/contacts?q=<email>`), description.
- Previous/next paging with "page N of M".
- New rows enter with a short stagger.

**Overview `/` additions:**
- An "AI classifier" card: the label distribution bars and both accuracies, linking to `/classifier`.
- A "Recent activity" card: the first 8 rows of `/api/activity?day=<selected day>`, titled "Activity on <day>", linking to `/activity?day=<day>`.

**Stage drill-down:**
- Clicking or keyboard-activating a funnel bar (overview) or a stage box (journey) opens a panel from `/api/stage?day=<selected day>&status=<status>`.
- The panel shows the stage name, the total, the day, and pages of 50 rows: name, company, since (UTC), from (status name), reason in words (`sent` → "email sent", `reply` → "replied", `unsubscribe` → "asked to unsubscribe", `bounced` → "email bounced", `deactivate_due` → "no reply after the last follow-up", `suppressed` → "on the do-not-email list", none → "not contacted yet").
- Each row links to `/contacts?q=<email>`.
- Escape closes the panel and returns focus to what opened it.

**Play/pause** (`sim.tsx`, D63):
- Controls: a Play/Pause toggle button (with `aria-pressed`) and a speed select (1×, 2×, 4×), both next to the existing controls.
- **The loop:** POST `{days:1}` → bump `version` → fetch `/api/summary` → `stopReason({ active, violations, error })` → if `null`, wait `playDelayMs(speed)` and repeat.
- **While playing:** advance and reset are disabled, Pause stays enabled, and the speed can be changed at any time.
- **Pause** stops the loop after the day in progress.
- **When the loop stops on its own,** it shows the reason in the notice area (as an error when it was an error or a violation).
- **Unmounting or leaving the page** stops the loop.
- **Delays:** no `setInterval`. Use a cancellable timeout and abort signals.

**Contacts page:** `/contacts?status=replied&q=ann` starts with those filters applied.

## Edge cases (each one a test)

- **play:** the three speeds, a bad speed, and every stop reason with its precedence.
- **describeActivity:** every kind, two labels for each source, and dates as days.
- **listActivity:** one row per happening (no duplicate `status_changed`), newest-first order including the second-level edge (23:59:59), every kind's total, day, search and combined filters, a page past the end, and refusals (kind, page, bad day, future day).
- **classifierStats:**
  - the `SIM_START` boundary (08:59:59 is excluded, 09:00:00 is included);
  - counts per label and per source;
  - accuracy equal to `report()`'s;
  - confusion order and non-zero cells;
  - examples limited to 3, newest first, with exact shape;
  - an empty database.
- **stageAt:**
  - the shape;
  - order by since, with nulls last;
  - from and reason;
  - totals equal the funnel for every status on four days;
  - a page past the end;
  - refusals.
- **routes:** 200 and 400 shapes for the three routes, and `stage`'s default day.

Expected failure before the build: `Cannot find module` for `src/web/play`, `src/web/activity`, `src/web/classifier`, `src/web/stage` and `app/api/{classifier,activity,stage}/route`.

## Explain-back

1. The activity log never shows a `status_changed` event with reason `sent`. Why is nothing lost?
2. The classifier page says the AI got 1,324 of 1,454 right. Where does "right" come from, and why are the seed's replies left out?
3. You press Play at 4× and walk away. Name the three things that make it stop by itself.

## Done when

- All tests pass, and `npm run typecheck`, `npm run format:check`, the production build and `npm audit --omit=dev` are clean.
- The harness then checks every new page and control in a browser against the 10k probe database, at desktop and phone width.
