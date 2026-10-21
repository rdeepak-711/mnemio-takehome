# T07 — Rule classifier

## Goal

Label the clear-cut replies (out-of-office and unsubscribe) with plain rules and no AI, and pull a return date out of out-of-office text. Anything uncertain returns `null` and goes to the AI later.

## Files

Create: `src/classify/rules.ts`.
Tests: `tests/unit/rules.test.ts`.

## Behaviour

```ts
export type RuleResult = { label: 'out_of_office'; returnDate: Date | null } | { label: 'unsubscribe' } | null;
export function classifyByRules(reply: { body: string; headers: Record<string, string> }, now: Date): RuleResult;
export function findReturnDate(text: string, now: Date): Date | null;
```

Checked in this order:

1. **Auto-reply header**: `headers['auto-submitted']` (case-insensitive key) is present and not `no` → `out_of_office` with `findReturnDate(body, now)`.
2. **Unsubscribe**: matches `/\b(unsubscribe|remove me|stop (emailing|contacting) me|take me off)\b/i` **and** isn't negated: only `/\b(don'?t|do not)\s+(unsubscribe|remove)\b/i` counts as negation. A plain `not` elsewhere doesn't ("Not interested, please unsubscribe me" is an unsubscribe) → `unsubscribe`.
3. **Out-of-office phrase without header**: matches `/\b(out of (the )?office|on (annual )?leave|away until|on vacation)\b/i` **and** the body doesn't contain a denial (`no,`, `not out`, `i'm here`, `i am here`, `not away`) → `out_of_office`. If it's denied → `null`.
4. Otherwise → `null`.

`findReturnDate(text, now)` understands, case-insensitively:
- `until 3 Nov` / `until November 3` / `back on 3 November` → that date in `now`'s year, or the next year only if it is before the start of `now`'s UTC day (so "until 22 Oct" said on 22 Oct means today, not next year).
- `back on 2026-11-03` / `returning 2026-11-03` → that ISO date.
- `returning Monday` / `back Monday` → the next Monday strictly after `now`.
- Nothing matched → `null`.
Dates are returned at 00:00 UTC.

## Edge cases (each one a test)

| Input | Expected |
|---|---|
| header `Auto-Submitted: auto-replied`, body "I'm away until 3 Nov" (now 2026-10-30) | OOO, 2026-11-03 |
| header present, body with no date | OOO, `null` |
| header `auto-submitted: no`, body "Thanks" | `null` |
| "Please remove me from your list." | unsubscribe |
| "UNSUBSCRIBE" | unsubscribe |
| "Don't unsubscribe me, but send less often" | `null` |
| "Not interested, please unsubscribe me" | unsubscribe |
| "I'm on annual leave, back on 2026-11-10" (no header) | OOO, 2026-11-10 |
| "Out of office? No, I'm here, just not interested." | `null` |
| "Yes, keen to chat. Thursday?" | `null` |
| "until 5 Jan" with now = 2026-12-20 | OOO, 2027-01-05 |
| "returning Monday" with now = Wed 2026-11-04 | 2026-11-09 |
| header present, "away until 22 Oct" with now = 2026-10-22T09:00Z | OOO, 2026-10-22 |

## Tests that prove it

The table above with `it.each`, plus `findReturnDate` alone for each date format.

Expected failure before the build: `Cannot find module '../../src/classify/rules'`.

## Explain-back

1. Why does the header rule come before the text rules?
2. Why is "Out of office? No, I'm here" a `null` and not `not_interested`?
3. Why is it safer for the rules to return `null` than to guess?

## Done when

All rule tests pass, `npm run typecheck` is clean, and `classifyByRules` never reads anything except `body`, `headers` and `now`.
