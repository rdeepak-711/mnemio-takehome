# T03 — State machine

## Goal

One pure function that holds every lifecycle rule: given a contact's status and something that happened, return the new status and what should happen next. Every other part of the system asks this function instead of deciding on its own.

## Files

Create: `src/lifecycle.ts`.
Tests: `tests/unit/lifecycle.test.ts`.

## Behaviour

Exports:

```ts
import type { Label } from './labels';

export const STATUSES = ['new','first_sent','follow_up_1_sent','follow_up_2_sent','follow_up_3_sent',
                         'replied','bounced','unsubscribed','deactivated'] as const;
export type Status = typeof STATUSES[number];
export const STEPS = ['first','follow_up_1','follow_up_2','follow_up_3'] as const;
export type Step = typeof STEPS[number];
export type NextAction = Step | 'deactivate' | null;
export const IN_SEQUENCE: readonly Status[];   // new, first_sent, follow_up_1/2/3_sent
export const TERMINAL: readonly Status[];      // replied, bounced, unsubscribed, deactivated

export type LifecycleEvent =
  | { type: 'sent'; step: Step }
  | { type: 'bounced' }
  | { type: 'reply'; label: Label }
  | { type: 'deactivate_due' };

export function transition(status: Status, event: LifecycleEvent):
  { status: Status; nextAction: NextAction | 'unchanged' };

export function expectedStep(status: Status): Step | null;  // which step a due contact gets next
```

Rules, exactly the table in `spec/site.md` "Lifecycle rules":

- `sent` must be the expected step for the status (`new` → `first`, `first_sent` → `follow_up_1`, …). After `follow_up_3`, `nextAction = 'deactivate'`. Any other step throws `InvalidTransitionError`.
- `bounced` from an in-sequence status → `bounced`, `nextAction = null`. From a terminal status → throws.
- `reply` `unsubscribe` from **any** status → `unsubscribed`, `null`.
- `reply` `out_of_office` from an in-sequence status → status unchanged, `nextAction = 'unchanged'` (the date is moved by T04, not here). From terminal → status unchanged, `null`.
- `reply` `interested` / `not_interested` / `needs_review` from in-sequence or `deactivated` → `replied`, `null`. From `replied` / `bounced` / `unsubscribed` → unchanged, `null`.
- `deactivate_due` only from `follow_up_3_sent` → `deactivated`, `null`. Otherwise throws.

`InvalidTransitionError` is exported, and its message names the status and the event.

## Edge cases

- `transition('new', sent follow_up_1)` throws (skipped a step).
- `transition('first_sent', sent first)` throws (repeat step).
- `transition('unsubscribed', sent first)` throws.
- `transition('bounced', reply interested)` → stays `bounced`.
- `transition('deactivated', reply interested)` → `replied`.
- `transition('follow_up_2_sent', deactivate_due)` throws.
- Unsubscribe from each of the 9 statuses → `unsubscribed` (9 cases, `it.each`).

## Tests that prove it

The full happy path (`new` → … → `deactivated`) as one test. Every row of the lifecycle table as its own case. Every edge case above. Plus `IN_SEQUENCE` and `TERMINAL` together cover all 9 statuses with no overlap.

Expected failure before the build: `Cannot find module '../../src/lifecycle'`.

## Explain-back

1. Why does `transition` throw on a skipped step instead of just allowing it?
2. Out-of-office returns `'unchanged'` and not a new date. Which file moves the date, and why is it split that way?
3. Why can a `deactivated` contact become `replied`, but a `bounced` one can't?

## Done when

All lifecycle tests pass, `npm run typecheck` is clean, and `src/lifecycle.ts` imports nothing from the DB or the network.
