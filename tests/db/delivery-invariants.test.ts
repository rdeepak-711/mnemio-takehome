import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { loadConfig, type Config } from '../../src/config';
import { createProvider } from '../../src/mock/provider';
import { sendDue } from '../../src/engine/send';
import { checkInvariants } from '../../src/invariants';

// T22: invariants 8–12 (spec/site.md, Layer 7). Each test breaks one rule on purpose and expects
// exactly that invariant to report it; checkInvariants without the config never runs them.
const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);
const providerPool = new pg.Pool({ connectionString: url });
const NOW = new Date('2026-11-02T09:00:00Z'); // Monday; 09:00 in London
const HOUR_MS = 60 * 60 * 1000;

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: url,
    BOUNCE_RATE: '0',
    REPLY_RATE: '0',
    DELIVERABILITY: 'on',
    MAILBOX_COUNT: '1',
    WARMUP_START: '10',
    WARMUP_STEP: '0',
    WARMUP_MAX: '10',
    SEND_WINDOW: '0-24',
    DOMAIN_DAILY_CAP: '10',
    ...overrides,
  });
}

const RUN = config();
let ids: number[] = [];

beforeEach(async () => {
  await resetDb(pool);
  ids = [];
  // 6 contacts in London, 4 of them on one domain.
  for (let i = 1; i <= 6; i++) {
    const domain = i <= 4 ? 'shared.example' : `own${i}.example`;
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
         status, next_action, next_action_at, created_at, updated_at)
       VALUES ('Ann', 'Lee', $1, 'Acme', 'saas', 'CTO', 'tech', 'Europe/London', 'tech:saas', 'new', 'first', $2, $2, $2)
       RETURNING id`,
      [`p${i}@${domain}`, NOW],
    );
    ids.push(rows[0]!.id);
  }
  await sendDue(pool, NOW, { provider: createProvider(providerPool, RUN), config: RUN });
});

afterAll(async () => {
  await providerPool.end();
  await closePool();
});

const numbers = async (cfg?: Config) => [...new Set((await checkInvariants(pool, 50, cfg)).map((v) => v.invariant))];

describe('invariants 8–12', () => {
  it('a clean run has none, with or without the config', async () => {
    expect(await checkInvariants(pool, 50, RUN)).toEqual([]);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('8: more sends than the warm-up limit on a day', async () => {
    expect(await numbers(config({ WARMUP_START: '5', WARMUP_MAX: '5' }))).toEqual([8]);
  });

  it('8: a send on the restart day counts against the restarted limit', async () => {
    // Make the mailbox 5 days old: at 3 + 10 a day it is at the max of 10, so 6 sends are fine.
    const fiveDaysAgo = new Date(NOW.getTime() - 5 * 24 * HOUR_MS);
    await pool.query('UPDATE mailboxes SET created_at = $1, warmup_started_at = $1', [fiveDaysAgo]);
    const cfg = config({ WARMUP_START: '3', WARMUP_STEP: '10', WARMUP_MAX: '10' });
    expect(await numbers(cfg)).toEqual([]);
    // Now a pause that ended an hour before the sends: the warm-up restarted that day, so the limit was 3.
    await pool.query(
      `INSERT INTO mailbox_pauses (mailbox_id, paused_at, resume_at, bounce_rate, sample)
       VALUES (1, $1, $2, 0.5, 50)`,
      [new Date(NOW.getTime() - 4 * 24 * HOUR_MS), new Date(NOW.getTime() - HOUR_MS)],
    );
    expect(await numbers(cfg)).toEqual([8]);
  });

  it('9: more sends to one domain than the cap', async () => {
    const violations = await checkInvariants(pool, 50, config({ DOMAIN_DAILY_CAP: '3' }));
    expect(violations.map((v) => v.invariant)).toEqual([9]);
    expect(violations[0]!.message).toMatch(/shared\.example/);
  });

  it('10: a send outside the window', async () => {
    const violations = await checkInvariants(pool, 50, config({ SEND_WINDOW: '10-17' }));
    expect(violations.map((v) => v.invariant)).toEqual([10, 10, 10, 10, 10, 10]);
    expect(violations.map((v) => v.contactId).sort()).toEqual([...ids].sort());
  });

  it('11: a send while the mailbox was paused', async () => {
    await pool.query(
      `INSERT INTO mailbox_pauses (mailbox_id, paused_at, resume_at, bounce_rate, sample)
       VALUES (1, $1, $2, 0.5, 50)`,
      [new Date(NOW.getTime() - HOUR_MS), new Date(NOW.getTime() + HOUR_MS)],
    );
    expect(await numbers(RUN)).toEqual([11]);
  });

  it('11: sends at the very moment of the pause (same batch, before it) are fine', async () => {
    await pool.query(
      `INSERT INTO mailbox_pauses (mailbox_id, paused_at, resume_at, bounce_rate, sample)
       VALUES (1, $1, $2, 0.5, 50)`,
      [NOW, new Date(NOW.getTime() + 72 * HOUR_MS)],
    );
    expect(await numbers(RUN)).toEqual([]);
  });

  it('12: missing or wrong List-Unsubscribe headers', async () => {
    await pool.query(`UPDATE sends SET headers = '{}' WHERE contact_id = $1`, [ids[0]]);
    await pool.query(
      `UPDATE sends SET headers = jsonb_set(headers, '{List-Unsubscribe}', to_jsonb('<mailto:x@y.example>'::text))
        WHERE contact_id = $1`,
      [ids[1]],
    );
    const violations = await checkInvariants(pool, 50, RUN);
    expect(violations.map((v) => [v.invariant, v.contactId])).toEqual([
      [12, ids[0]],
      [12, ids[1]],
    ]);
  });

  it('12: a body without the unsubscribe link at the end', async () => {
    await pool.query(`UPDATE sends SET body = body || ' P.S. hi' WHERE contact_id = $1`, [ids[2]]);
    const violations = await checkInvariants(pool, 50, RUN);
    expect(violations.map((v) => [v.invariant, v.contactId])).toEqual([[12, ids[2]]]);
  });

  it('without the config, 8–12 are not checked', async () => {
    await pool.query(`UPDATE sends SET headers = '{}'`);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('with DELIVERABILITY=off, 8–12 are not checked either', async () => {
    await pool.query(`UPDATE sends SET headers = '{}'`);
    expect(await checkInvariants(pool, 50, config({ DELIVERABILITY: 'off' }))).toEqual([]);
  });
});
