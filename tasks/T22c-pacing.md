# T22c — Hourly pacing

## Goal

Spread each mailbox's sends over the working day instead of spending the whole daily limit in the first hour (D72; the brief's bonus: "sends spread across mailboxes and across the working day, not in one burst"). Read D72, and D66 for the mailbox lock it builds on.

## Files

Change:
- `src/config.ts`
- `src/delivery/rules.ts`
- `src/delivery/mailboxes.ts` (`mailboxCapacity`)
- `src/engine/send.ts` (only if the capacity call needs new arguments)
- `src/invariants.ts`
- `.env.example` (`SEND_PACING=on`)

Tests (written by the harness engineer, do not edit):
- `tests/unit/config.test.ts` (new cases)
- `tests/unit/delivery-rules.test.ts` (`hourlyLimit`)
- `tests/db/delivery-pacing.test.ts` (new)

The T22 and T22b test helpers now set `SEND_PACING: 'off'` and must stay green unchanged. `tests/db/delivery-tick.test.ts` runs with pacing on (the default) and checks invariants 1–13 after 30 days.

## Part 1 — config

`Delivery` gains `pacing: boolean`, read from `SEND_PACING`:
- the value is trimmed and case-insensitive, `on` or `off`;
- empty or unset means `on`;
- anything else throws naming `SEND_PACING`.

Parse it with the same helper as `DELIVERABILITY` if one exists, or write a small shared one.

## Part 2 — `hourlyLimit`

```ts
export function hourlyLimit(daily: number, window: Delivery['sendWindow']): number; // ceil(daily / (endHour - startHour))
```

## Part 3 — capacity

When `delivery.pacing` is on, `mailboxCapacity` returns:

```
min(warmupLimit(age) − sentToday, hourlyLimit(warmupLimit(age), window) − sentThisHour)
```

- `sentThisHour` counts that mailbox's `sends` with `sent_at >= date_trunc('hour', $now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'` and `sent_at <` that `+ interval '1 hour'`.
- Compute it in the same query as `sentToday`.
- With pacing off, nothing changes.

## Part 4 — invariant 13

It runs only when `config.delivery?.pacing` is set, after 12.

- **Violation:** for a (mailbox, UTC hour), the count of engine sends is above `ceil(lim / (end − start))`. `lim` is that mailbox's warm-up limit on that hour's UTC day, computed exactly as invariant 8 does: reuse the same CTE, or factor it.
- **`contactId`:** null.
- **Message:** names the mailbox address and the hour.

## Rules

Same as T22. No `new Date()` in `src/`. Run `npm test`, `npm run typecheck` and `npm run format:check`. Do not commit.

## Explain-back question (for Deepak)

1. With 80 a day and a 9–17 window, why can a mailbox still send in 24 different UTC hours of a day, and what stops it sending more than 80?
