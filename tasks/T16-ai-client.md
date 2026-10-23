# T16 — OpenRouter client (limiter, retries, cache, fallback)

## Goal

The one door to the AI. Every AI call goes through `complete()`: check the cache, check the daily budget and pacing, call the free models in order with retries, validate the answer, save it. When nothing works it returns `null` and the caller uses its hand-written fallback, so the AI can never stop a run. Tests use a fake HTTP server; nothing calls the real API.

## Files

Create: `src/ai/cache.ts`, `src/ai/limiter.ts`, `src/ai/client.ts`.
Tests (written by harness engineer): `tests/unit/ai-cache.test.ts`, `tests/db/ai-client.test.ts`.
No new dependencies: use Node's built-in `fetch` (D50).

## `src/ai/cache.ts`

```ts
import type { Queryable } from '../clock';
export type CacheKind = 'sequence' | 'classification';
export function normaliseReply(body: string): string;               // lowercase, whitespace runs → one space, trimmed
export function cacheKey(kind: CacheKind, promptVersion: string, input: string): string; // sha256 hex
export async function cacheGet(db: Queryable, key: string): Promise<{ response: unknown; model: string } | null>;
export async function cacheSet(db: Queryable, key: string, kind: CacheKind, response: unknown, model: string): Promise<void>;
```

- The key hashes `kind`, `promptVersion` and `input` joined with `'\u0000'`, so parts can't run into each other. **No model in the key** (D50): the model is stored in its own column.
- `cacheSet` is `INSERT … ON CONFLICT (key) DO NOTHING`.

## `src/ai/limiter.ts`

```ts
import type pg from 'pg';
export type Slot = { release(): Promise<void> };
export type Limiter = { acquire(): Promise<Slot | null>; usedToday(): Promise<number> };
export function createLimiter(
  pool: pg.Pool,
  opts: { rpm: number; dailyBudget: number; now?: () => Date; sleep?: (ms: number) => Promise<void> },
): Limiter;
```

- **Pacing:** calls within one limiter start at least `60000 / rpm` ms apart. Concurrent `acquire`s queue up (a promise chain); the wait is `max(0, lastStart + interval - now())`, done with `sleep`. The first call never waits.
- **Budget:** `dailyBudget <= 0` → `null`. Otherwise reserve one slot for today's **UTC** date in one statement: `INSERT INTO llm_usage (day, calls) VALUES ($1, 1) ON CONFLICT (day) DO UPDATE SET calls = llm_usage.calls + 1 WHERE llm_usage.calls < $2 RETURNING calls`. No row returned → `null` (budget used up). Check the budget before waiting for pacing.
- `Slot.release()` gives the slot back to the **day it was taken from**, never below 0 (`GREATEST(calls - 1, 0)`), and only once per slot (a second call does nothing).
- `usedToday()` reads today's count (0 when no row).
- Defaults: `now = () => new Date()`, `sleep = setTimeout` promise. Only `src/ai/` may read the real clock.

## `src/ai/client.ts`

```ts
import type pg from 'pg';
import type { z } from 'zod';
import type { CacheKind } from './cache';
export const RETRY_DELAYS_MS = [2000, 4000] as const;
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type AiRequest<T> = { kind: CacheKind; promptVersion: string; input: string; messages: ChatMessage[]; schema: z.ZodType<T> };
export type AiResult<T> = { value: T; model: string; source: 'ai' | 'cache' };
export type AiClient = { complete<T>(req: AiRequest<T>): Promise<AiResult<T> | null> };
export type AiClientOptions = {
  pool: pg.Pool;
  apiKey: string | null;
  models: string[];
  rpm: number;
  dailyBudget: number;
  baseUrl?: string;                       // default 'https://openrouter.ai/api/v1'
  timeoutMs?: number;                     // default 60_000 (a free model took 57 s; docs/findings.md)
  restMs?: number;                        // default 5 * 60_000
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;                  // jitter source, default Math.random
};
export function createAiClient(opts: AiClientOptions): AiClient;
```

`createAiClient` throws, naming `:free`, if any model id doesn't end in `:free`. It builds one limiter (`createLimiter`) shared by every `complete` call of that client.

**`complete(req)`, in order:**
1. **Cache:** `cacheGet(cacheKey(kind, promptVersion, input))`. A hit whose `response` passes `req.schema` → `{ value, model: <stored model>, source: 'cache' }`, no HTTP, no budget. A hit that fails the schema is ignored. The cache works even with no key.
2. **No key or no models** → `null`.
3. **For each model in order** that is not resting (see 5), up to 3 attempts (1 + 2 retries):
   - `slot = await limiter.acquire()`; `null` → return `null` at once (budget used up; no HTTP).
   - `POST {baseUrl}/chat/completions`, headers `Authorization: Bearer <key>`, `Content-Type: application/json`, body `{ model, messages, temperature: 0 }`. **No `response_format`** (not every free model supports it; the prompt asks for JSON). Abort after `timeoutMs` (`AbortSignal.timeout`).
   - **200 with `choices[0].message.content`:** strip a surrounding ```` ``` ```` / ```` ```json ```` fence, `JSON.parse`, `schema.safeParse`. Valid → `cacheSet(…, model)`, return `{ value, model, source: 'ai' }` (the slot is kept: the call counted). Invalid JSON or wrong shape → keep the slot (it counted at OpenRouter), **no retry**, next model.
   - **200 without choices** (an error body) → keep the slot, next model.
   - **429, 5xx, timeout, network error** → `slot.release()`; if attempts remain, `sleep(RETRY_DELAYS_MS[i] + random() * 500)` and retry the same model; otherwise the model rests, next model.
   - **400, 404 and other 4xx except 401/403** → `slot.release()`, the model rests, next model (no retry: the model is dead or refuses the request).
   - **401 / 403** → `slot.release()`, return `null` (the key is bad; every model would fail).
4. All models failed or resting → `null`.
5. **Resting:** a model that ran out of attempts or got a 400/404 is skipped by this client until `now() + restMs` has passed. Kept in memory, per client.

## Edge cases (each one a test)

Cache: key format, each part changes it, parts can't run together, no model in the key; `normaliseReply`; hit → no HTTP and no budget; found when the model order changes; new prompt version misses; stale-shape hit ignored; hit works with no key.
Calls: request shape (path, bearer, model, temperature 0, messages, no `response_format`), usage 1, cache row; code fence accepted; 429 then success (one 2 s wait, usage 1); jitter < 500 ms; three 5xx (2 s, 4 s) then next model; timeouts then next model; 400/404 → next model, no retry; 401/403 → `null` after one request; invalid JSON → next model, both counted; wrong shape → next model; 200 without choices → next model; all fail → `null`, usage 0, nothing cached.
Resting: a failed model is skipped on the next request and tried again after 5 minutes; all resting → `null` without HTTP.
Budget: used up → no HTTP; 0 → no HTTP; 5 at once with budget 3 → exactly 3 requests; counted per UTC day.
Other: no key → `null`; no models → `null`; non-`:free` model → throws.
Limiter: spacing 3000 ms at rpm 20; no wait when time has passed; release once and never below 0; release refunds the right day.

Expected failure before the build: `Cannot find module '../../src/ai/client'` and `'../../src/ai/cache'`.

## Explain-back

1. Why is the model not part of the cache key?
2. Why does a 404 skip to the next model, while a 429 is retried?
3. When every model fails, what happens to the reply or the email that needed the AI?

## Done when

All tests pass, `npm run typecheck` and `npm run format:check` are clean.
