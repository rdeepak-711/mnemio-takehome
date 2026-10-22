# T11 — Mock email provider

## Goal

A pretend email company that lives in this repo. The engine hands it an email with a unique key; it answers `accepted` or `bounced`, remembers the key, and sometimes schedules a reply to arrive later. Every outcome is decided by hashing the seed with the email's key (or address), so the same email always gets the same answer no matter which worker sends it or in what order. It behaves like an outside service: it writes on its own connection, so its records survive even if the caller's transaction is rolled back.

## Files

Create: `src/mock/provider.ts`, `src/mock/replies.ts`.
Tests (written by harness engineer): `tests/unit/mock-replies.test.ts`, `tests/db/provider.test.ts`.

## Part 1 — `src/mock/replies.ts` (pure)

```ts
import type { ReplyLabel } from '../labels';
export type ReplyTemplate = { body: string; ambiguous: boolean };
export const REPLY_BANK: Record<ReplyLabel, readonly ReplyTemplate[]>;
export const RETURN_DATE_TOKEN = '{return_date}';
export function draw(seed: number, ...parts: string[]): number;   // uniform in [0, 1)
export function formatReturnDate(date: Date): string;             // 2026-11-09 → 'Monday 9 November' (UTC)
```

- **`draw`**: SHA-256 (`node:crypto`) of `[seed, ...parts].join('\u0000')`, the first 6 bytes read as an integer and divided by 2^48. Same inputs → same number; any change → an unrelated number. Each decision uses its own `parts` (`'bounce'`, `'reply'`, `'label'`, …), so decisions don't influence each other.
- **`REPLY_BANK`**: at least 4 texts per label, at least 1 of them `ambiguous: true` per label. Ambiguous texts are the hard cases for the classifier ("Not right now, maybe next quarter", "Who gave you my address?" as not_interested; "Could be relevant, what does it cost?" as interested; a polite "please don't email me again" as unsubscribe; a travelling note with no office phrase as out_of_office).
  - **The rule:** `classifyByRules` (T07) must never give a mock text a *wrong* label. For each text it returns either `null` or the true label. Non-ambiguous `unsubscribe` texts are caught by the rules (`'unsubscribe'`); non-ambiguous `out_of_office` texts are caught by the office phrase even without the header; `interested` and `not_interested` texts always give `null` (only the AI labels those).
  - `{return_date}` appears only in `out_of_office` texts, at most once, right after a trigger word `findReturnDate` knows (`until`, `back on`, `returning on`). At least one non-ambiguous `out_of_office` text has no token (no return date → the engine uses `OOO_DEFAULT_DAYS`). No other `{…}` appears anywhere.
- **`formatReturnDate`**: `<Weekday> <day> <Month>` in UTC, full names, no leading zero, no year.

## Part 2 — `src/mock/provider.ts`

```ts
import type pg from 'pg';
import type { Config } from '../config';
export type SendInput = { idempotencyKey: string; to: string; subject: string; body: string; now: Date };
export type SendResult = { outcome: 'accepted' | 'bounced' };
export type Provider = { send(input: SendInput): Promise<SendResult> };
export const OOO_HEADERS = { 'Auto-Submitted': 'auto-replied' } as const;
export function createProvider(pool: pg.Pool, config: Pick<Config, 'seed' | 'bounceRate' | 'replyRate' | 'replyMix'>): Provider;
```

- **Takes a pool, never a client.** Every write goes through the provider's own transaction on a connection it checks out itself, so it is outside any transaction the caller has open (D31). A caller's `ROLLBACK` does not undo the provider's rows.
- **One transaction for its writes**: `mock_outbox` and (if any) `mock_inbox` are written together, so a crash between them can't leave a remembered email whose reply was lost.
- **Repeated key**: `INSERT INTO mock_outbox … ON CONFLICT (idempotency_key) DO NOTHING RETURNING outcome`. If nothing was inserted, read the stored outcome and return it; schedule nothing. Five simultaneous sends of one key → one outbox row, at most one inbox row, the same outcome for all five. A repeat at a later `now` keeps the first `received_at`.
- **Bounce is per address, not per email** (D41): `draw(seed, 'bounce', to) < bounceRate`. A dead address bounces every email sent to it; in practice only the first, because a bounce ends the sequence. About `BOUNCE_RATE` of addresses are dead.
- **Reply, only on accepted** (each from its own draw keyed by `idempotencyKey`):
  - whether: `draw(seed, 'reply', key) < replyRate`;
  - label: walk `REPLY_MIX` in `REPLY_LABELS` order with `draw(seed, 'label', key)`;
  - text: a template from `REPLY_BANK[label]` chosen by `draw(seed, 'text', key)`;
  - delay: 12–72 hours (`draw(seed, 'delay', key)`, whole minutes); `deliver_at = now + delay`;
  - out_of_office only: headers `OOO_HEADERS` when `draw(seed, 'header', key) < 0.75`, else `{}`; the return date is `deliver_at`'s UTC date + 2–14 days (`draw(seed, 'return', key)`), written into `{return_date}` with `formatReturnDate`.
  - Row: `mock_inbox (idempotency_key, body, headers, true_label, deliver_at, delivered = false)`.
- `mock_outbox.received_at = now`. No real clock anywhere (the no-real-clock scan covers `src/mock/`).
- `subject` and `body` are accepted but not used.

## Part 3 — late replies to follow-up 3 (added 23 Oct, D44)

So that "a deactivated contact can still reply" actually happens in a run:
- `export const LATE_REPLY_SHARE = 0.1;` in `src/mock/provider.ts`, and the provider config also takes `waitDays` (`Pick<Config, 'seed' | 'bounceRate' | 'replyRate' | 'replyMix' | 'waitDays'>`).
- Only when the idempotency key's step (the part after the last `:`) is `follow_up_3`: if `draw(seed, 'late', key) < LATE_REPLY_SHARE`, the delay is `waitDays[3] + 1` to `waitDays[3] + 14` days (whole minutes, `draw(seed, 'delay', key)`) instead of 12–72 hours. The reply then arrives after the contact has been deactivated.
- Every other step, and the other 90% of follow-up 3 replies, keep 12–72 hours. Labels, texts and OOO details are chosen exactly as before.

## Edge cases (each one a test)

**Unit (`tests/unit/mock-replies.test.ts`):**
- `draw`: in [0, 1); same inputs → same value; a different seed or part → a different value; 10,000 draws average 0.5 ± 0.02 and fill all 10 tenths.
- `REPLY_BANK`: every label has ≥ 4 texts and ≥ 1 ambiguous; tokens only as specified; at least one dateless non-ambiguous OOO text.
- Rules never mislabel a bank text (with the date filled in, no headers); non-ambiguous unsubscribe → `'unsubscribe'`, non-ambiguous OOO → `'out_of_office'`, interested / not_interested → `null`.
- Each OOO text with the token, filled with a date, gives that exact date back from `findReturnDate`.
- `formatReturnDate`: 2026-11-09 → `Monday 9 November`; 2027-01-01 → `Friday 1 January`.

**DB (`tests/db/provider.test.ts`, `resetDb` before each):**
- A send returns an outcome and writes one outbox row with `received_at = now`.
- The same key twice → same outcome, one outbox row, no extra inbox row; a later `now` keeps the first `received_at`.
- Five simultaneous sends of one key → one outbox row, at most one inbox row, one outcome.
- Two keys for the same address → the same outcome.
- A send during a caller's open transaction that then rolls back → the outbox row is still there.
- `BOUNCE_RATE=0` → nothing bounces; `=1` → everything bounces and no reply is scheduled.
- `REPLY_RATE=0` → no inbox rows; `REPLY_RATE=1` → exactly one inbox row per accepted send.
- `REPLY_MIX=unsubscribe:1,…0` → every reply is `unsubscribe`.
- Over 10,000 sends to distinct addresses: bounce share 3% ± 0.6 points; replies per accepted 8% ± 0.9 points; each label within 5 points of `REPLY_MIX`; every delay 12–72 h.
- OOO rows (`REPLY_RATE=1`, mix all OOO, 400 sends): headers are exactly `OOO_HEADERS` or `{}`, both appear; rows with a date, rows without; every dated row's `findReturnDate(body, deliver_at)` is 2–14 days after `deliver_at`'s UTC date.
- Rules never mislabel any generated inbox row (`classifyByRules(row, deliver_at)` is `null` or `true_label`), and ambiguous texts do get generated.
- Order doesn't matter: 300 keys sent in order, then (after a reset) shuffled and 10 at a time → identical outbox and inbox contents (ignoring inbox `id`).
- A different seed → different outcomes.
- Late replies: 2,000 `follow_up_3` sends with `REPLY_RATE=1` → about 10% (± 3 points) arrive later than `waitDays[3]` days, all within `waitDays[3] + 1 … + 14` days; the rest within 12–72 h. With `WAIT_DAYS=3,5,7,2` the late ones are 3–16 days. `first`, `follow_up_1` and `follow_up_2` replies are never late.

## Tests that prove it

Expected failure before the build: `Cannot find module '../../src/mock/replies'` and `'../../src/mock/provider'`.

## Explain-back

1. Why does the provider write on its own connection instead of inside the engine's transaction?
2. Why is every random choice a hash of the seed and the key, not the next number from one random generator?
3. Why does a repeated key return the first answer and create nothing new?

## Done when

All tests pass, `npm run typecheck` and `npm run format:check` are clean.
