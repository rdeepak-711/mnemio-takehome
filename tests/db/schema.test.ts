import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { migrate, resetDb, MIGRATIONS_DIR } from '../../src/db/migrate';

const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);

// Postgres error codes
const UNIQUE = '23505';
const CHECK = '23514';
const FOREIGN_KEY = '23503';
const NOT_NULL = '23502';

const rejectsWith = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });

let n = 0;
function contactRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  n += 1;
  return {
    first_name: 'Priya',
    last_name: 'Sharma',
    email: `priya${n}@acme.example`,
    company: 'Acme Labs',
    industry: 'saas',
    role: 'CTO',
    role_family: 'tech',
    timezone: 'Europe/London',
    segment: 'tech:saas',
    status: 'new',
    next_action: 'first',
    next_action_at: '2026-11-02T09:00:00Z',
    created_at: '2026-11-01T09:00:00Z',
    updated_at: '2026-11-01T09:00:00Z',
    ...overrides,
  };
}

async function insert(table: string, row: Record<string, unknown>): Promise<number> {
  const cols = Object.keys(row);
  const params = cols.map((_, i) => `$${i + 1}`);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${params.join(', ')}) RETURNING *`;
  const { rows } = await pool.query(sql, Object.values(row));
  return rows[0]?.id as number;
}

const insertContact = (overrides: Record<string, unknown> = {}) => insert('contacts', contactRow(overrides));

const sendRow = (contactId: number, step: string, overrides: Record<string, unknown> = {}) => ({
  contact_id: contactId,
  step,
  idempotency_key: `${contactId}:${step}`,
  outcome: 'accepted',
  subject: 'Hi',
  body: 'Hello',
  template_source: 'fallback',
  sent_at: '2026-11-02T09:00:00Z',
  ...overrides,
});

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await resetDb(pool);
  await closePool();
});

describe('migrations', () => {
  it('MIGRATIONS_DIR points at src/db/migrations', () => {
    expect(MIGRATIONS_DIR.replace(/\\/g, '/').replace(/\/$/, '')).toMatch(/src\/db\/migrations$/);
  });

  it('creates the 11 business tables plus schema_migrations in public (the AI tables are in ai, D52; mailboxes T22)', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    expect(rows.map((r) => r.table_name)).toEqual(
      [
        'contacts',
        'events',
        'mailbox_pauses',
        'mailboxes',
        'mock_inbox',
        'mock_outbox',
        'replies',
        'schema_migrations',
        'sends',
        'sim_clock',
        'suppression',
      ].sort(),
    );
  });

  it('records 001, 002 and 003, and a second migrate applies nothing', async () => {
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(['001_init.sql', '002_ai_schema.sql', '003_deliverability.sql']);
    expect(await migrate(pool)).toEqual([]);
  });

  it('resetDb empties tables that had rows', async () => {
    await insertContact();
    await resetDb(pool);
    const { rows } = await pool.query('SELECT count(*)::int AS c FROM contacts');
    expect(rows[0].c).toBe(0);
  });

  it('a failing migration file leaves nothing behind and is not recorded; earlier files stay applied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mnemio-migrations-'));
    writeFileSync(join(dir, 'a_001_ok.sql'), 'CREATE TABLE t_ok (id int);');
    writeFileSync(join(dir, 'a_002_broken.sql'), 'CREATE TABLE t_broken (id int);\nTHIS IS NOT SQL;');

    await expect(migrate(pool, dir)).rejects.toThrow();

    const recorded = await pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(recorded.rows.map((r) => r.name)).toEqual([
      '001_init.sql',
      '002_ai_schema.sql',
      '003_deliverability.sql',
      'a_001_ok.sql',
    ]);
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('t_ok', 't_broken')",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(['t_ok']);
  });

  it('applies files in file-name order and returns their names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mnemio-migrations-'));
    writeFileSync(join(dir, 'b_002.sql'), 'ALTER TABLE t_order ADD COLUMN two int;');
    writeFileSync(join(dir, 'b_001.sql'), 'CREATE TABLE t_order (one int);');
    expect(await migrate(pool, dir)).toEqual(['b_001.sql', 'b_002.sql']);
  });
});

describe('contacts', () => {
  it('accepts a valid new contact', async () => {
    expect(await insertContact()).toBeGreaterThan(0);
  });

  it('rejects a duplicate email', async () => {
    await insertContact({ email: 'same@acme.example' });
    await rejectsWith(insertContact({ email: 'same@acme.example' }), UNIQUE);
  });

  it('rejects a status that does not exist', async () => {
    await rejectsWith(insertContact({ status: 'pending' }), CHECK);
  });

  it('rejects a next_action that does not exist', async () => {
    await rejectsWith(insertContact({ next_action: 'follow_up_4' }), CHECK);
  });

  it('rejects next_action without next_action_at, and the reverse', async () => {
    await rejectsWith(insertContact({ next_action_at: null }), CHECK);
    await rejectsWith(insertContact({ status: 'replied', next_action: null }), CHECK);
  });

  it('rejects a next_action that does not match the status', async () => {
    await rejectsWith(insertContact({ status: 'new', next_action: 'follow_up_1' }), CHECK);
    await rejectsWith(insertContact({ status: 'replied', next_action: 'first' }), CHECK);
    await rejectsWith(insertContact({ status: 'first_sent', next_action: null, next_action_at: null }), CHECK);
  });

  it.each([
    ['new', 'first'],
    ['first_sent', 'follow_up_1'],
    ['follow_up_1_sent', 'follow_up_2'],
    ['follow_up_2_sent', 'follow_up_3'],
    ['follow_up_3_sent', 'deactivate'],
  ])('accepts %s with next_action %s', async (status, nextAction) => {
    expect(await insertContact({ status, next_action: nextAction })).toBeGreaterThan(0);
  });

  it.each(['replied', 'bounced', 'unsubscribed', 'deactivated'])(
    'accepts terminal %s with no next action',
    async (status) => {
      expect(await insertContact({ status, next_action: null, next_action_at: null })).toBeGreaterThan(0);
    },
  );

  it('rejects a segment that is not role_family:industry', async () => {
    await rejectsWith(insertContact({ segment: 'founder:saas' }), CHECK);
  });

  it('rejects an unknown industry or role family', async () => {
    await rejectsWith(insertContact({ industry: 'mining', segment: 'tech:mining' }), CHECK);
    await rejectsWith(insertContact({ role_family: 'marketing', segment: 'marketing:saas' }), CHECK);
  });

  it('defaults priority to false', async () => {
    const id = await insertContact();
    const { rows } = await pool.query('SELECT priority FROM contacts WHERE id = $1', [id]);
    expect(rows[0].priority).toBe(false);
  });

  it('has no real-time default: a contact without created_at is rejected', async () => {
    const { created_at: _omit, ...row } = contactRow();
    await rejectsWith(insert('contacts', row), NOT_NULL);
  });
});

describe('sends', () => {
  it('accepts one send per step', async () => {
    const id = await insertContact();
    expect(await insert('sends', sendRow(id, 'first'))).toBeGreaterThan(0);
  });

  it('rejects a second send of the same step for the same contact (the double-send guard)', async () => {
    const id = await insertContact();
    await insert('sends', sendRow(id, 'first'));
    await rejectsWith(insert('sends', sendRow(id, 'first', { idempotency_key: `${id}:first` })), UNIQUE);
  });

  it('rejects a key borrowed from another step (the format check fires first)', async () => {
    const a = await insertContact();
    await insert('sends', sendRow(a, 'first'));
    await rejectsWith(insert('sends', sendRow(a, 'follow_up_1', { idempotency_key: `${a}:first` })), CHECK);
  });

  it('rejects a key that does not match contact_id:step', async () => {
    const id = await insertContact();
    await rejectsWith(insert('sends', sendRow(id, 'first', { idempotency_key: 'something-else' })), CHECK);
  });

  it('rejects a send for a contact that does not exist', async () => {
    await rejectsWith(insert('sends', sendRow(999999, 'first')), FOREIGN_KEY);
  });

  it('rejects an unknown step, outcome or template source', async () => {
    const id = await insertContact();
    await rejectsWith(insert('sends', sendRow(id, 'follow_up_4')), CHECK);
    await rejectsWith(insert('sends', sendRow(id, 'first', { outcome: 'opened' })), CHECK);
    await rejectsWith(insert('sends', sendRow(id, 'first', { template_source: 'magic' })), CHECK);
  });
});

describe('replies', () => {
  async function sent(): Promise<{ contactId: number; sendId: number }> {
    const contactId = await insertContact({ status: 'first_sent', next_action: 'follow_up_1' });
    const sendId = await insert('sends', sendRow(contactId, 'first'));
    return { contactId, sendId };
  }

  const replyRow = (contactId: number, sendId: number, overrides: Record<string, unknown> = {}) => ({
    contact_id: contactId,
    send_id: sendId,
    body: 'Sounds good',
    received_at: '2026-11-03T09:00:00Z',
    true_label: 'interested',
    ...overrides,
  });

  it('accepts an unlabelled reply with empty headers by default', async () => {
    const { contactId, sendId } = await sent();
    const id = await insert('replies', replyRow(contactId, sendId));
    const { rows } = await pool.query('SELECT headers, label FROM replies WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ headers: {}, label: null });
  });

  it('rejects an unknown label', async () => {
    const { contactId, sendId } = await sent();
    await rejectsWith(insert('replies', replyRow(contactId, sendId, { label: 'maybe' })), CHECK);
  });

  it('rejects needs_review as a true label (the mock only sends the 4 reply labels)', async () => {
    const { contactId, sendId } = await sent();
    await rejectsWith(insert('replies', replyRow(contactId, sendId, { true_label: 'needs_review' })), CHECK);
  });

  it('accepts needs_review as a classifier label', async () => {
    const { contactId, sendId } = await sent();
    expect(
      await insert('replies', replyRow(contactId, sendId, { label: 'needs_review', label_source: 'fallback' })),
    ).toBeGreaterThan(0);
  });

  it('rejects a reply for a send that does not exist', async () => {
    const { contactId } = await sent();
    await rejectsWith(insert('replies', replyRow(contactId, 999999)), FOREIGN_KEY);
  });
});

describe('suppression, events, clock', () => {
  it('rejects a second row for the same email; ON CONFLICT DO NOTHING keeps the first reason', async () => {
    const row = { email: 'x@acme.example', reason: 'unsubscribed', added_at: '2026-11-02T09:00:00Z' };
    await insert('suppression', row);
    await rejectsWith(insert('suppression', { ...row, reason: 'bounced' }), UNIQUE);
    await pool.query(
      "INSERT INTO suppression (email, reason, added_at) VALUES ($1, 'bounced', $2) ON CONFLICT (email) DO NOTHING",
      [row.email, row.added_at],
    );
    const { rows } = await pool.query('SELECT reason FROM suppression WHERE email = $1', [row.email]);
    expect(rows).toEqual([{ reason: 'unsubscribed' }]);
  });

  it('rejects an unknown suppression reason', async () => {
    await rejectsWith(
      insert('suppression', { email: 'y@acme.example', reason: 'annoyed', added_at: '2026-11-02T09:00:00Z' }),
      CHECK,
    );
  });

  it('accepts the 4 event types and rejects any other', async () => {
    const id = await insertContact();
    for (const type of ['status_changed', 'sent', 'reply_received', 'rescheduled']) {
      await insert('events', { contact_id: id, type, data: {}, occurred_at: '2026-11-02T09:00:00Z' });
    }
    await rejectsWith(
      insert('events', { contact_id: id, type: 'opened', data: {}, occurred_at: '2026-11-02T09:00:00Z' }),
      CHECK,
    );
  });

  it('sim_clock holds one row only (id = 1)', async () => {
    await insert('sim_clock', { id: 1, now: '2026-11-02T09:00:00Z' });
    await rejectsWith(insert('sim_clock', { id: 2, now: '2026-11-02T09:00:00Z' }), CHECK);
  });
});

describe('mock tables stand in for an outside service', () => {
  it('mock_outbox accepts a key with no matching contact or send', async () => {
    await insert('mock_outbox', {
      idempotency_key: '999999:first',
      outcome: 'accepted',
      received_at: '2026-11-02T09:00:00Z',
    });
    const { rows } = await pool.query('SELECT count(*)::int AS c FROM mock_outbox');
    expect(rows[0].c).toBe(1);
  });

  it('mock_inbox stores the idempotency key, defaults delivered to false, and references nothing', async () => {
    const id = await insert('mock_inbox', {
      idempotency_key: '999999:first',
      body: 'Thanks',
      true_label: 'interested',
      deliver_at: '2026-11-03T09:00:00Z',
    });
    const { rows } = await pool.query('SELECT delivered, headers FROM mock_inbox WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ delivered: false, headers: {} });
  });

  it('mock_inbox has no send_id or contact_id column', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'mock_inbox'",
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('idempotency_key');
    expect(cols).not.toContain('send_id');
    expect(cols).not.toContain('contact_id');
  });

  it('no foreign key points from a mock table', async () => {
    const { rows } = await pool.query(
      "SELECT conname FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text LIKE 'mock_%'",
    );
    expect(rows).toEqual([]);
  });
});

describe('npm run db:reset', () => {
  it('resets the database named by DATABASE_URL and exits 0', () => {
    const out = execFileSync('npx', ['tsx', 'src/db/reset.ts'], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(out).toMatch(/database reset/);
  });
});
