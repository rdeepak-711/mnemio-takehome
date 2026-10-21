# T04 — Schedule

## Goal

Two pure date functions: when the next step is due after a send, and where an out-of-office reply moves that date.

## Files

Create: `src/schedule.ts`.
Tests: `tests/unit/schedule.test.ts`.

## Behaviour

```ts
import type { Step } from './lifecycle';
export function nextActionAt(step: Step, sentAt: Date, waits: [number, number, number, number]): Date;
export function oooReschedule(currentDue: Date, now: Date, returnDate: Date | null, defaultDays: number): Date;
```

- `nextActionAt`: `first` → `sentAt + waits[0]` days, `follow_up_1` → `+ waits[1]`, `follow_up_2` → `+ waits[2]`, `follow_up_3` → `+ waits[3]` (that's the deactivation date). Adds whole days in UTC (24-hour steps on the timestamp). Returns a new `Date` and never mutates `sentAt`.
- `oooReschedule`: candidate = `returnDate + 1 day` if `returnDate` is given and `returnDate + 1 day` is later than `now`, otherwise `now + defaultDays`. Returns the **later** of `candidate` and `currentDue`, so an out-of-office never pulls an email *earlier*.

## Edge cases

- `nextActionAt('first', 2026-11-02T09:00Z, [3,5,7,7])` → `2026-11-05T09:00Z`.
- Month rollover: sent 2026-11-28 + 5 days → 2026-12-03. Year rollover: sent 2026-12-29 + 7 → 2027-01-05.
- Input `Date` is unchanged after the call.
- `oooReschedule`: return date in the past → uses `now + defaultDays`.
- `oooReschedule`: return date is today (`returnDate` 2026-11-04T00:00Z, `now` 2026-11-04T09:00Z) → 2026-11-05T00:00Z (or `currentDue` if later), not `now + defaultDays`.
- `oooReschedule`: return date + 1 is earlier than `currentDue` → returns `currentDue`.
- `oooReschedule`: `returnDate = null` → `now + defaultDays` (or `currentDue` if that's later).

## Tests that prove it

Each edge case above as a test, plus all 4 steps of `nextActionAt` with `[3,5,7,7]`.

Expected failure before the build: `Cannot find module '../../src/schedule'`.

## Explain-back

1. Why does `oooReschedule` take the later of the two dates?
2. Why pass `now` in as a parameter instead of using `new Date()` inside?
3. Which wait does `follow_up_3` use, and what happens when that date arrives?

## Done when

All schedule tests pass, `npm run typecheck` is clean, and there's no `new Date()` call without arguments in `src/schedule.ts`.
