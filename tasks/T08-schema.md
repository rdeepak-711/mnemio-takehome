# T08 — Schema + migrations

## Goal

Create every table from `spec/site.md` "Data model" with constraints strict enough that the database itself refuses impossible data: a second send of the same step, a status that doesn't exist, an in-sequence contact with no next action. Add a tiny migration runner and `npm run db:reset`.

## Files

Create: `src/db/migrations/001_init.sql`, `src/db/migrate.ts`, `src/db/reset.ts`. Change: `package.json` (add the `db:reset` script).
Tests (written by harness engineer): `tests/db/schema.test.ts`.

## Behaviour

### `src/db/migrate.ts`

```ts
import type pg from 'pg';
export const MIGRATIONS_DIR: string;                         // absolute path of src/db/migrations
export async function migrate(pool: pg.Pool, dir?: string): Promise<string[]>;   // returns the file names it applied
export async function resetDb(pool: pg.Pool, dir?: string): Promise<void>;
```

- `migrate` creates `schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())` if missing, reads every `*.sql` file in `dir` (default `MIGRATIONS_DIR`) sorted by file name, and applies each one not yet recorded. Each file runs **in its own transaction together with its `schema_migrations` row**, so a file that fails leaves nothing behind and isn't recorded. A second call applies nothing and returns `[]`.
- `resetDb` runs `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` and then `migrate(pool, dir)`.
- No other file may run DDL.

### `src/db/reset.ts` and `npm run db:reset`

`"db:reset": "tsx src/db/reset.ts"`. The script loads `.env` if present (`dotenv`), calls `loadConfig(process.env)`, runs `resetDb(getPool(config.databaseUrl))`, prints `database reset: <n> migration(s) applied`, closes the pool, and exits 0. On error it prints the message and exits 1.

### `src/db/migrations/001_init.sql`

Every table and column from the data model, with these rules. `NOT NULL` on every column unless the data model says `NULL`.

| Table | Constraints |
|---|---|
| `contacts` | `email UNIQUE`; `status` CHECK in the 9 statuses; `next_action` NULL, CHECK in the 5 actions; `industry` CHECK in the 5 industries; `role_family` CHECK in the 4 families; CHECK `segment = role_family \|\| ':' \|\| industry`; `priority boolean NOT NULL DEFAULT false`; CHECK `(next_action IS NULL) = (next_action_at IS NULL)`; CHECK that `(status, next_action)` is one of: `new`/`first`, `first_sent`/`follow_up_1`, `follow_up_1_sent`/`follow_up_2`, `follow_up_2_sent`/`follow_up_3`, `follow_up_3_sent`/`deactivate`, or a terminal status with `next_action IS NULL`. Partial index on `(next_action_at) WHERE next_action_at IS NOT NULL`. |
| `sends` | FK `contact_id → contacts`; `step` CHECK in the 4 steps; `UNIQUE (contact_id, step)`; `idempotency_key UNIQUE`, CHECK `idempotency_key = contact_id \|\| ':' \|\| step`; `outcome` CHECK in (`accepted`, `bounced`); `template_source` CHECK in (`cache`, `ai`, `fallback`). |
| `replies` | FKs `contact_id → contacts`, `send_id → sends`; `headers jsonb NOT NULL DEFAULT '{}'`; `true_label` CHECK in the 4 reply labels; `label` NULL, CHECK in the 5 labels; `label_source` NULL, CHECK in (`rule`, `ai`, `fallback`); `return_date date NULL`; `classified_at` NULL. Partial index on `(id) WHERE label IS NULL`. |
| `suppression` | `email` PRIMARY KEY; `reason` CHECK in (`unsubscribed`, `bounced`). |
| `events` | `id bigserial`; FK `contact_id → contacts`; `type` CHECK in the 4 event types; `data jsonb NOT NULL`; indexes on `(contact_id)` and `(occurred_at)`. |
| `sim_clock` | `id int PRIMARY KEY CHECK (id = 1)`; `now timestamptz NOT NULL`. |
| `mock_outbox` | `idempotency_key` PRIMARY KEY; `outcome` CHECK in (`accepted`, `bounced`). **No foreign keys.** |
| `mock_inbox` | `id`, **`idempotency_key`** (not `contact_id`/`send_id`, see below), `body`, `headers jsonb NOT NULL DEFAULT '{}'`, `true_label` CHECK in the 4 reply labels, `deliver_at`, `delivered boolean NOT NULL DEFAULT false`. **No foreign keys.** Partial index on `(deliver_at) WHERE NOT delivered`. |
| `llm_cache` | `key` PRIMARY KEY; `kind` CHECK in (`sequence`, `classification`); `response jsonb`; `model`; `created_at timestamptz NOT NULL DEFAULT now()`. |
| `llm_usage` | `day date` PRIMARY KEY; `calls int NOT NULL DEFAULT 0 CHECK (calls >= 0)`. |

Two rules about time and the mock:

- **No `DEFAULT now()` on business tables** (`contacts`, `sends`, `replies`, `suppression`, `events`, `sim_clock`, `mock_*`). Their timestamps are simulated time and must be written by the code. A `DEFAULT now()` would quietly fill in real time and break the "same seed → identical rows" check in T10. Only `llm_cache`, `llm_usage` and `schema_migrations` use real time.
- **The mock tables reference nothing.** The mock provider stands in for an outside service: it writes on its own connection, outside our send transaction, and is called *before* our `sends` row exists. So it can't know a `send_id`, and a foreign key would make it depend on our uncommitted data. It stores the idempotency key (`"<contact_id>:<step>"`); T14 finds the send with `sends.idempotency_key`.

## Edge cases (each one a test)

- All 11 tables plus `schema_migrations` exist after `resetDb`.
- `migrate` a second time applies nothing and returns `[]`.
- `resetDb` empties a table that had rows.
- Second `sends` row for the same `(contact_id, step)` with a different key → unique violation (`23505`).
- A key that doesn't match `contact_id:step` (including one borrowed from another step) → check violation (`23514`). Because the key must equal `contact_id:step`, a duplicate key can only happen together with a duplicate `(contact_id, step)`, which the test above already covers; `UNIQUE` on the key stays as a second guard.
- `sends.contact_id` that doesn't exist → foreign key violation (`23503`).
- Contact with status `pending` → `23514`. `next_action` `follow_up_4` → `23514`.
- `next_action` set and `next_action_at` NULL (or the reverse) → `23514`.
- `new` with `next_action = 'follow_up_1'` → `23514`. `replied` with any `next_action` → `23514`. `first_sent` with NULL → `23514`.
- `segment` that doesn't equal `role_family:industry` → `23514`. Unknown industry or role family → `23514`.
- Duplicate contact email → `23505`.
- Second `suppression` row for the same email → `23505`; with `ON CONFLICT DO NOTHING` the first reason stays.
- `sim_clock` row with `id = 2` → `23514`.
- `events.type = 'opened'` → `23514`.
- `replies.label = 'maybe'` → `23514`; `replies.true_label = 'needs_review'` → `23514`.
- A `contacts` row without `created_at` → not-null violation (`23502`) (no real-time default).
- `mock_inbox` and `mock_outbox` accept a key with no matching contact or send.
- `migrate` with a test folder of `a_001_ok.sql` (creates a table) and `a_002_broken.sql` (invalid SQL): throws; `a_001_ok.sql` is recorded and its table exists; `a_002_broken.sql` is not recorded and none of its statements took effect.
- `npm run db:reset` against the test database exits 0 and prints `database reset`.

## Tests that prove it

`tests/db/schema.test.ts`, against `TEST_DATABASE_URL`, one test per edge case. Errors are checked by Postgres error code (`err.code`), not message text.

Expected failure before the build: `Cannot find module '../../src/db/migrate'`.

## Explain-back

1. Why does the database refuse a second send of the same step, when the code already checks?
2. Why do the mock tables have no foreign keys and store the idempotency key instead of `send_id`?
3. Why no `DEFAULT now()` on the business tables?

## Done when

All tests pass (`npm test`, Docker DB up), `npm run typecheck` and `npm run format:check` are clean, `npm run db:reset` works against `DATABASE_URL`, and no file outside the list above was created.
