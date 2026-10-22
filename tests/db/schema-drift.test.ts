import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { STATUSES, STEPS, TERMINAL, IN_SEQUENCE, expectedStep } from '../../src/lifecycle';
import { REPLY_LABELS, LABELS } from '../../src/labels';
import { ROLE_FAMILIES, INDUSTRIES } from '../../src/segments';

// The allowed values live in TypeScript and in the SQL CHECKs (D32). These tests read the
// constraints Postgres actually enforces and compare them, value for value, with the TS lists.
const pool = getPool(process.env.TEST_DATABASE_URL!);

async function allowedValues(constraint: string): Promise<string[]> {
  const { rows } = await pool.query<{ def: string }>(
    'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1',
    [constraint],
  );
  expect(rows, `constraint ${constraint} exists`).toHaveLength(1);
  return [...rows[0]!.def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!).sort();
}

const sorted = (values: readonly string[]) => [...values].sort();

beforeAll(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await closePool();
});

describe('SQL CHECK lists match the TypeScript constants', () => {
  it.each([
    ['contacts_status_check', STATUSES],
    ['contacts_next_action_check', [...STEPS, 'deactivate']],
    ['contacts_industry_check', INDUSTRIES],
    ['contacts_role_family_check', ROLE_FAMILIES],
    ['sends_step_check', STEPS],
    ['replies_true_label_check', REPLY_LABELS],
    ['mock_inbox_true_label_check', REPLY_LABELS],
    ['replies_label_check', LABELS],
  ] as const)('%s', async (constraint, values) => {
    expect(await allowedValues(constraint)).toEqual(sorted(values));
  });

  it('the terminal list in the status/next_action CHECK matches TERMINAL', async () => {
    const def = (
      await pool.query<{ def: string }>(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'contacts_status_next_action_check'",
      )
    ).rows[0]!.def;
    const terminalPart = def.slice(0, def.indexOf('THEN'));
    expect([...terminalPart.matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort()).toEqual(sorted(TERMINAL));
  });

  it('every in-sequence status is accepted with the next action lifecycle.ts expects', async () => {
    for (const [i, status] of IN_SEQUENCE.entries()) {
      const nextAction = expectedStep(status) ?? 'deactivate';
      await pool.query(
        `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
           status, next_action, next_action_at, created_at, updated_at)
         VALUES ('A', 'B', $1, 'C', 'saas', 'CTO', 'tech', 'UTC', 'tech:saas', $2, $3,
           '2026-11-02T09:00:00Z', '2026-11-01T09:00:00Z', '2026-11-01T09:00:00Z')`,
        [`drift${i}@acme.example`, status, nextAction],
      );
    }
    const { rows } = await pool.query('SELECT count(*)::int AS c FROM contacts');
    expect(rows[0].c).toBe(IN_SEQUENCE.length);
  });
});
