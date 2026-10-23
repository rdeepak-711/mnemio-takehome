import type pg from 'pg';
import type { z } from 'zod';
import { cacheGet, cacheKey, cacheSet, type CacheKind } from './cache';
import { createLimiter } from './limiter';

export const RETRY_DELAYS_MS = [2000, 4000] as const;
const MAX_JITTER_MS = 500;
const ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type AiRequest<T> = {
  kind: CacheKind;
  promptVersion: string;
  input: string;
  messages: ChatMessage[];
  schema: z.ZodType<T>;
};
export type AiResult<T> = { value: T; model: string; source: 'ai' | 'cache' };
export type AiClient = { complete<T>(req: AiRequest<T>): Promise<AiResult<T> | null> };
export type AiClientOptions = {
  pool: pg.Pool;
  apiKey: string | null;
  models: string[];
  rpm: number;
  dailyBudget: number;
  baseUrl?: string; // default 'https://openrouter.ai/api/v1'
  timeoutMs?: number; // default 60_000 (a free model took 57 s; docs/findings.md)
  restMs?: number; // default 5 * 60_000
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number; // jitter source, default Math.random
};

// What one HTTP attempt came to; decides whether the slot is kept, the model retried, rested or given up on.
type Outcome<T> =
  | { kind: 'answer'; value: T } // a valid answer
  | { kind: 'bad_answer' } // 200 but no content, not JSON or the wrong shape: counted, no retry
  | { kind: 'transient' } // 429, 5xx, timeout, network error: not counted, retried
  | { kind: 'dead' } // 400, 404, other 4xx: not counted, no retry, the model rests
  | { kind: 'bad_key' }; // 401, 403: every model would fail the same way

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Models that are asked for JSON in the prompt sometimes wrap it in a ``` or ```json fence.
function stripFence(content: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(content.trim());
  return match?.[1] ?? content.trim();
}

function parseAnswer<T>(raw: string, schema: z.ZodType<T>): Outcome<T> {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { kind: 'bad_answer' }; // a 200 whose body isn't JSON at all
  }
  const content = (body as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return { kind: 'bad_answer' }; // an error body sent with 200
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(content));
  } catch {
    return { kind: 'bad_answer' };
  }
  const checked = schema.safeParse(parsed);
  return checked.success ? { kind: 'answer', value: checked.data } : { kind: 'bad_answer' };
}

function classifyStatus(status: number): Outcome<never> {
  if (status === 401 || status === 403) return { kind: 'bad_key' };
  if (status === 429 || status >= 500) return { kind: 'transient' };
  return { kind: 'dead' };
}

export function createAiClient(opts: AiClientOptions): AiClient {
  // Paid models are refused up front, so a typo in OPENROUTER_MODELS can never cost money (D50).
  const paid = opts.models.filter((model) => !model.endsWith(':free'));
  if (paid.length > 0) throw new Error(`every model must end in ":free"; refused: ${paid.join(', ')}`);

  const baseUrl = (opts.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const restMs = opts.restMs ?? 5 * 60_000;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  const limiter = createLimiter(opts.pool, { rpm: opts.rpm, dailyBudget: opts.dailyBudget, now, sleep });

  // model → time (ms) it may be tried again; in memory, per client (D50). A dead or worn-out model rests for every
  // kind; a bad answer rests it for that kind only, since a model that writes bad emails may still label well (D51).
  const restingUntil = new Map<string, number>();
  const restingForKind = new Map<string, number>(); // keyed `${kind}\u0000${model}`
  const kindKey = (kind: CacheKind, model: string) => `${kind}\u0000${model}`;
  const isResting = (model: string, kind: CacheKind) =>
    now().getTime() <
    Math.max(restingUntil.get(model) ?? -Infinity, restingForKind.get(kindKey(kind, model)) ?? -Infinity);
  const rest = (model: string) => restingUntil.set(model, now().getTime() + restMs);
  const restForKind = (model: string, kind: CacheKind) =>
    restingForKind.set(kindKey(kind, model), now().getTime() + restMs);

  // One POST. The key goes only into the header; nothing here throws or logs, so it can't leak into a message.
  async function attempt<T>(apiKey: string, model: string, req: AiRequest<T>): Promise<Outcome<T>> {
    let status: number;
    let raw: string;
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: req.messages, temperature: 0 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      raw = await response.text(); // read every body, so the connection is freed
    } catch {
      return { kind: 'transient' }; // timeout or network error
    }
    return status >= 200 && status < 300 ? parseAnswer(raw, req.schema) : classifyStatus(status);
  }

  return {
    async complete<T>(req: AiRequest<T>): Promise<AiResult<T> | null> {
      const key = cacheKey(req.kind, req.promptVersion, req.input);

      // A saved answer that no longer fits the schema (an older prompt's shape) is asked again.
      const hit = await cacheGet(opts.pool, key);
      if (hit) {
        const checked = req.schema.safeParse(hit.response);
        if (checked.success) return { value: checked.data, model: hit.model, source: 'cache' };
      }

      const apiKey = opts.apiKey;
      if (!apiKey || opts.models.length === 0) return null;

      for (const model of opts.models) {
        if (isResting(model, req.kind)) continue;
        for (let i = 0; i < ATTEMPTS; i += 1) {
          const slot = await limiter.acquire();
          if (!slot) return null; // budget used up: no HTTP call at all

          const outcome = await attempt(apiKey, model, req);
          // An answer or a bad answer counted at OpenRouter, so the slot is kept; anything else is refunded.
          if (outcome.kind === 'answer') {
            await cacheSet(opts.pool, key, req.kind, outcome.value, model);
            return { value: outcome.value, model, source: 'ai' };
          }
          if (outcome.kind === 'bad_answer') {
            restForKind(model, req.kind); // the same model would likely say the same: next model
            break;
          }
          await slot.release();
          if (outcome.kind === 'bad_key') return null;
          if (outcome.kind === 'dead') {
            rest(model);
            break;
          }
          // transient: wait and retry the same model, or rest it once out of attempts
          const delay = RETRY_DELAYS_MS[i];
          if (delay === undefined) {
            rest(model);
            break;
          }
          await sleep(delay + random() * MAX_JITTER_MS);
        }
      }
      return null; // every model failed or is resting: the caller uses its hand-written fallback
    },
  };
}
