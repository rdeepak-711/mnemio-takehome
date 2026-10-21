# T05 — Template render + content check

## Goal

Turn a segment template with blanks into a finished email for one person, and catch broken or spammy emails before they're sent.

## Files

Create: `src/templates/render.ts`.
Tests: `tests/unit/render.test.ts`.

## Behaviour

```ts
export const ALLOWED_SLOTS = ['first_name','last_name','company','role','industry'] as const;   // each is a column on contacts
export type Slot = typeof ALLOWED_SLOTS[number];
export function render(template: string, vars: Partial<Record<Slot, string>>): string;
export function findSlots(template: string): string[];        // slot names found, deduplicated, in order of first appearance
export function checkContent(email: { subject: string; body: string }): string[];   // list of problems, [] = OK
```

- `render`: replaces every `{{slot}}` (spaces inside the braces allowed: `{{ first_name }}`). A slot name not in `ALLOWED_SLOTS` throws. An allowed slot with no value in `vars` throws, naming the slot. The same slot can appear many times.
- `checkContent` returns a problem for each of: leftover `{{` or `}}` in subject or body · empty or whitespace-only subject · subject over 120 characters · body over 1,200 characters · any entry from `SPAM_WORDS` (exported; at least: `free money`, `guarantee`, `act now`, `100% free`, `winner`, `risk-free`), matched as a case-insensitive substring, so `guarantee` also catches `guaranteed`.

## Edge cases

- Template with no slots → returned unchanged.
- `{{first_name}}` twice → both replaced.
- `{{ company }}` with spaces → replaced.
- `{{discount}}` (not allowed) → throws naming `discount`.
- `{{company}}` with `vars.company` undefined → throws naming `company`.
- A value containing `{{` (e.g. company named `{{evil}}`) is inserted literally and not processed again. `checkContent` then flags the leftover braces.
- "Guarantee" in mixed case → flagged. "Guaranteed" → flagged.

## Tests that prove it

Each edge case, plus a full example: a follow-up template written inline in the test (the real fallback templates don't exist until T17), rendered for Priya Sharma at Acme Labs, then `checkContent` returns `[]`.

Expected failure before the build: `Cannot find module '../../src/templates/render'`.

## Explain-back

1. Why does an unknown slot throw instead of being left blank?
2. Why is `checkContent` a separate function from `render`?
3. A company literally named `{{evil}}`: what happens, and why is that the safe outcome?

## Done when

All render tests pass and `npm run typecheck` is clean.
