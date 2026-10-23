-- 002_ai_schema: llm_cache and llm_usage move to their own `ai` schema, which `npm run db:reset` keeps (D52).
-- Runs again after every reset, when `ai` already exists and 001 has just recreated the public tables,
-- so every statement is safe to repeat.

CREATE SCHEMA IF NOT EXISTS ai;

CREATE TABLE IF NOT EXISTS ai.llm_cache (
  key text PRIMARY KEY,
  kind text NOT NULL,
  response jsonb NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_cache_kind_check CHECK (kind IN ('sequence', 'classification'))
);

CREATE TABLE IF NOT EXISTS ai.llm_usage (
  day date PRIMARY KEY,
  calls int NOT NULL DEFAULT 0,
  CONSTRAINT llm_usage_calls_check CHECK (calls >= 0)
);

-- Rows saved before this migration move across; a kept answer or a higher kept count wins.
INSERT INTO ai.llm_cache (key, kind, response, model, created_at)
SELECT key, kind, response, model, created_at FROM public.llm_cache
ON CONFLICT (key) DO NOTHING;

INSERT INTO ai.llm_usage (day, calls)
SELECT day, calls FROM public.llm_usage
ON CONFLICT (day) DO UPDATE SET calls = GREATEST(ai.llm_usage.calls, EXCLUDED.calls);

DROP TABLE public.llm_cache, public.llm_usage;
