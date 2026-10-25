# T19 — Report

## Goal

One read-only summary of where the run stands, for the CLI now and the dashboard later: counts per status, today's sending, what's due, reply and bounce rates, where the emails came from, how well the classifier did against the mock's true labels, and the health checks (unlabelled replies, orphaned mock replies, AI calls against the budget). `npm run report` prints it (D54).

## Files

Create: `src/report.ts`. Change: `src/cli.ts` (a `report` command), `src/main.ts` (run it), `package.json` (one script).
Tests (written by harness engineer): `tests/db/report.test.ts`, new cases in `tests/unit/cli.test.ts`, one in `tests/db/cli-run.test.ts`.

## Part 1 — `src/report.ts`

```ts
import type pg from 'pg';
import type { Status } from './lifecycle';
export type Count = { count: number; of: number }; // a rate: count ÷ of
export type Accuracy = { labelled: number; correct: number };
export type Report = {
  now: Date;
  statuses: Record<Status, number>; // all 9 keys, 0 when none
  inSequence: number;
  sentToday: number;
  dueToday: number;
  dueTomorrow: number;
  replyRate: Count;
  bounceRate: Count;
  templateSources: { ai: number; cache: number; fallback: number };
  classifier: { rule: Accuracy; ai: Accuracy; fallback: number };
  needsReview: number;
  unlabelled: number;
  orphaned: number;
  aiCalls: { today: number; budget: number };
};
export async function report(pool: pg.Pool, opts: { simStart: Date; dailyAiBudget: number }): Promise<Report>;
export function formatReport(r: Report): string;
```

Definitions. `now` = `getNow(pool)`. "Today" is the **simulated** UTC calendar day of `now`: `[dayStart, dayStart + 1 day)`. "Since start" means at or after `opts.simStart`: the engine's own work, leaving out the seeded history.
- `statuses`: contacts per status. `inSequence`: the five in-sequence statuses added up.
- `sentToday`: `sends` (accepted or bounced) with `sent_at` in today.
- `dueToday`: in-sequence contacts whose `next_action` is a send step (`first` … `follow_up_3`, not `deactivate`) and `next_action_at < dayStart + 1 day` (overdue included). `dueTomorrow`: the same with `next_action_at` in `[dayStart + 1 day, dayStart + 2 days)`.
- `replyRate`: `count` = distinct contacts with at least one reply, `of` = distinct contacts with at least one `accepted` send (all time, seed included).
- `bounceRate`: `count` = sends with `outcome = 'bounced'`, `of` = all sends (all time).
- `templateSources`: sends since start, by `template_source`.
- `classifier`: replies with `classified_at` since start. For `rule` and `ai`: `labelled` = how many had that `label_source`, `correct` = how many of those had `label = true_label`. `fallback` = how many had `label_source = 'fallback'` (always `needs_review`, which no true label is).
- `needsReview`: replies classified since start with `label = 'needs_review'` (any source). `unlabelled`: replies with `label IS NULL` (any time).
- `orphaned`: `mock_inbox` rows with `delivered = false`, `deliver_at <= now`, and no `sends` row with the same `idempotency_key` (D35; 0 after a clean run).
- `aiCalls.today`: `calls` in `ai.llm_usage` for `(now() AT TIME ZONE 'UTC')::date`, 0 with no row (real day: OpenRouter counts real days). `budget` = `opts.dailyAiBudget`.

Read-only: no writes, no transactions needed. No `new Date()` / `Date.now()`.

**`formatReport(r)`**, exactly these lines (a percentage has one decimal; `n/a` when `of` / `labelled` is 0):
```
Report for 2026-11-05 (simulated)
Contacts: 9 · new 2 · first_sent 2 · follow_up_1_sent 0 · follow_up_2_sent 0 · follow_up_3_sent 1 · replied 1 · bounced 1 · unsubscribed 1 · deactivated 1
In sequence: 5 · sent today: 2 · due today: 2 · due tomorrow: 1
Reply rate: 83.3% (5 of 6 contacts with an accepted send)
Bounce rate: 10.0% (1 of 10 sends)
Emails since start by template: ai 2 · cache 1 · fallback 2
Classifier since start, against the mock's true label: rule 1 of 1 correct (100.0%) · ai 1 of 2 correct (50.0%) · fallback 1
Needs review: 1 · unlabelled: 1 · orphaned mock replies: 1
AI calls today: 7/45
```
Status order is `STATUSES`. "Contacts:" is the total.

## Part 2 — CLI

`parseArgs(['report'])` → `{ command: 'report' }` (extra arguments refused with `usage:`; the usage text names `report`). `src/main.ts`: `report` prints `formatReport(await report(pool, { simStart: config.simStart, dailyAiBudget: config.dailyAiBudget }))` and doesn't run the invariants. `package.json`: `"report": "tsx src/main.ts report"`.

## Edge cases (each one a test)

The fixed dataset in `tests/db/report.test.ts` (9 contacts, 10 sends, 6 replies, 3 mock replies) has every number above worked out by hand: overdue counts as due today; a `deactivate` action is never "due"; a send at 23:59:59 yesterday isn't today's; seeded sends and replies before `simStart` stay out of the template and classifier counts; a wrong AI label is counted as labelled, not correct; an inbox row whose send exists, or that is in the future, or already delivered, isn't orphaned. An empty seeded-free database (only a clock) gives zeros and `n/a`. CLI: `report` parses; `report extra` refused; `npm run report` prints `Report for` and exits 0.

Expected failure before the build: `Cannot find module '../../src/report'`, and the new CLI cases.

## Explain-back

1. Why does the classifier's accuracy leave out replies classified before `SIM_START`?
2. Why is "AI calls today" a real day while "sent today" is a simulated day?
3. What is an orphaned mock reply, and why should a clean run have none?

## Done when

All tests pass, `npm run typecheck` and `npm run format:check` are clean.
