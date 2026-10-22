import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { loadConfig, type Config } from '../../src/config';
import { getNow } from '../../src/clock';
import { checkInvariants } from '../../src/invariants';
import { seed, STATUS_MIX } from '../../src/seed/seed';
import { INDUSTRIES, ROLE_FAMILIES, roleFamily } from '../../src/segments';
import { STATUSES } from '../../src/lifecycle';

const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: url, CONTACT_COUNT: '1000', SEED: '42', ...overrides });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HASHED_TABLES: Record<string, string> = {
  contacts: 'id',
  sends: 'id',
  replies: 'id',
  suppression: 'email',
  events: 'id',
  sim_clock: 'id',
  mock_outbox: 'idempotency_key',
  mock_inbox: 'id',
};

async function tableHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const [table, key] of Object.entries(HASHED_TABLES)) {
    const { rows } = await pool.query<{ h: string | null; n: string }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.${key}), '')) AS h, count(*) AS n FROM ${table} t`,
    );
    hashes[table] = `${rows[0]!.n}:${rows[0]!.h}`;
  }
  return hashes;
}

async function statusCounts(): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ status: string; n: number }>(
    'SELECT status, count(*)::int AS n FROM contacts GROUP BY status',
  );
  const counts: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT (${sql})::int AS n`, params);
  return rows[0]!.n;
}

afterAll(async () => {
  await closePool();
});

describe('STATUS_MIX', () => {
  it('is the pinned mix and sums to 1', () => {
    expect(STATUS_MIX).toEqual({
      new: 0.6,
      first_sent: 0.12,
      follow_up_1_sent: 0.08,
      follow_up_2_sent: 0.05,
      follow_up_3_sent: 0.03,
      replied: 0.05,
      bounced: 0.02,
      unsubscribed: 0.02,
      deactivated: 0.03,
    });
    const sum = Object.values(STATUS_MIX).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 9);
  });
});

describe('seed with 1000 contacts', () => {
  const cfg = config();
  let elapsedMs = 0;

  beforeAll(async () => {
    await resetDb(pool);
    const started = performance.now();
    const result = await seed(pool, cfg);
    elapsedMs = performance.now() - started;
    expect(result).toEqual({ contacts: 1000 });
  }, 60_000);

  it('creates exactly CONTACT_COUNT contacts in the largest-remainder split', async () => {
    expect(await count('SELECT count(*) FROM contacts')).toBe(1000);
    expect(await statusCounts()).toEqual({
      new: 600,
      first_sent: 120,
      follow_up_1_sent: 80,
      follow_up_2_sent: 50,
      follow_up_3_sent: 30,
      replied: 50,
      bounced: 20,
      unsubscribed: 20,
      deactivated: 30,
    });
  });

  it('leaves no invariant violations', async () => {
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('takes well under the 30 second budget for 1000', () => {
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('sets the clock to SIM_START', async () => {
    expect((await getNow(pool)).toISOString()).toBe(cfg.simStart.toISOString());
  });

  it('emails are unique, on .example and in the pinned shape', async () => {
    const { rows } = await pool.query<{ id: number; email: string }>('SELECT id, email FROM contacts');
    expect(new Set(rows.map((r) => r.email)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.email).toMatch(/^[a-z0-9]+\.[a-z0-9]+\.[0-9]+@[a-z0-9-]+\.example$/);
      expect(r.email).toContain(`.${r.id}@`);
    }
  });

  it('segments, roles and families are consistent, and every industry and family appears', async () => {
    const { rows } = await pool.query<{ role: string; role_family: string; industry: string; segment: string }>(
      'SELECT role, role_family, industry, segment FROM contacts',
    );
    for (const r of rows) {
      expect(r.segment).toBe(`${r.role_family}:${r.industry}`);
      expect(roleFamily(r.role)).toBe(r.role_family);
    }
    expect(new Set(rows.map((r) => r.industry))).toEqual(new Set(INDUSTRIES));
    expect(new Set(rows.map((r) => r.role_family))).toEqual(new Set(ROLE_FAMILIES));
  });

  it('every role family covers about a quarter of the contacts', async () => {
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts GROUP BY role_family');
    for (const r of rows) expect(r.n).toBe(250);
  });

  it('every timezone is one of the 8 pinned IANA zones', async () => {
    const { rows } = await pool.query<{ timezone: string }>('SELECT DISTINCT timezone FROM contacts');
    const zones = [
      'America/New_York',
      'America/Chicago',
      'America/Los_Angeles',
      'Europe/London',
      'Europe/Berlin',
      'Asia/Kolkata',
      'Asia/Singapore',
      'Australia/Sydney',
    ];
    for (const r of rows) expect(zones).toContain(r.timezone);
  });

  it('every history timestamp is before SIM_START', async () => {
    const t = cfg.simStart;
    expect(await count('SELECT count(*) FROM sends WHERE sent_at >= $1', [t])).toBe(0);
    expect(await count('SELECT count(*) FROM replies WHERE received_at >= $1', [t])).toBe(0);
    expect(await count('SELECT count(*) FROM suppression WHERE added_at >= $1', [t])).toBe(0);
    expect(await count('SELECT count(*) FROM events WHERE occurred_at >= $1', [t])).toBe(0);
    expect(await count('SELECT count(*) FROM mock_outbox WHERE received_at >= $1', [t])).toBe(0);
    expect(await count('SELECT count(*) FROM contacts WHERE created_at > $1 OR updated_at > $1', [t])).toBe(0);
  });

  it('every send is at 09:00–09:59 UTC', async () => {
    expect(await count(`SELECT count(*) FROM sends WHERE extract(hour FROM sent_at AT TIME ZONE 'UTC') <> 9`)).toBe(0);
  });

  it('some in-sequence contacts are due at SIM_START and some are not, all within the window', async () => {
    const t = cfg.simStart;
    const inSeq = `status IN ('first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent')`;
    expect(await count(`SELECT count(*) FROM contacts WHERE ${inSeq} AND next_action_at <= $1`, [t])).toBeGreaterThan(
      0,
    );
    expect(await count(`SELECT count(*) FROM contacts WHERE ${inSeq} AND next_action_at > $1`, [t])).toBeGreaterThan(0);
    expect(
      await count(
        `SELECT count(*) FROM contacts WHERE ${inSeq} AND next_action_at < $1::timestamptz - interval '2 days'`,
        [t],
      ),
    ).toBe(0);
  });

  it('next_action_at is the last send plus its wait', async () => {
    const waits = cfg.waitDays;
    const { rows } = await pool.query<{ step: string; sent_at: Date; next_action_at: Date }>(
      `SELECT s.step, s.sent_at, c.next_action_at
         FROM contacts c
         JOIN LATERAL (SELECT step, sent_at FROM sends WHERE contact_id = c.id ORDER BY sent_at DESC LIMIT 1) s ON true
        WHERE c.status IN ('first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent')`,
    );
    const index: Record<string, number> = { first: 0, follow_up_1: 1, follow_up_2: 2, follow_up_3: 3 };
    expect(rows.length).toBe(280);
    for (const r of rows) {
      const wait = waits[index[r.step]!]!;
      expect(r.next_action_at.getTime() - r.sent_at.getTime()).toBe(wait * DAY_MS);
    }
  });

  it('new contacts: all 600 due at SIM_START (one wave)', async () => {
    const t = cfg.simStart;
    expect(await count(`SELECT count(*) FROM contacts WHERE status = 'new' AND next_action_at = $1`, [t])).toBe(600);
  });

  it('bounced contacts have exactly one send, first, bounced', async () => {
    const { rows } = await pool.query<{ n: number; step: string; outcome: string }>(
      `SELECT count(s.id)::int AS n, min(s.step) AS step, min(s.outcome) AS outcome
         FROM contacts c LEFT JOIN sends s ON s.contact_id = c.id
        WHERE c.status = 'bounced' GROUP BY c.id`,
    );
    expect(rows).toHaveLength(20);
    for (const r of rows) expect(r).toEqual({ n: 1, step: 'first', outcome: 'bounced' });
  });

  it('replied contacts have one interested or not_interested reply; unsubscribed one unsubscribe reply', async () => {
    const { rows } = await pool.query<{ status: string; label: string; source: string; n: number }>(
      `SELECT c.status, r.label, r.label_source AS source, count(*)::int AS n
         FROM replies r JOIN contacts c ON c.id = r.contact_id
        GROUP BY c.status, r.label, r.label_source`,
    );
    for (const r of rows) {
      if (r.status === 'replied') {
        expect(['interested', 'not_interested']).toContain(r.label);
        expect(r.source).toBe('ai');
      } else {
        expect(r.status).toBe('unsubscribed');
        expect(r.label).toBe('unsubscribe');
        expect(r.source).toBe('rule');
      }
    }
    expect(await count('SELECT count(*) FROM replies')).toBe(70);
    expect(await count('SELECT count(DISTINCT contact_id) FROM replies')).toBe(70);
    expect(await count('SELECT count(*) FROM replies WHERE true_label <> label')).toBe(0);
  });

  it('deactivated contacts have all 4 sends', async () => {
    expect(
      await count(
        `SELECT count(*) FROM (SELECT c.id FROM contacts c JOIN sends s ON s.contact_id = c.id
          WHERE c.status = 'deactivated' GROUP BY c.id HAVING count(*) = 4) x`,
      ),
    ).toBe(30);
  });

  it('every send has a sent event, every reply a reply_received event', async () => {
    expect(await count(`SELECT count(*) FROM events WHERE type = 'sent'`)).toBe(
      await count('SELECT count(*) FROM sends'),
    );
    expect(await count(`SELECT count(*) FROM events WHERE type = 'reply_received'`)).toBe(
      await count('SELECT count(*) FROM replies'),
    );
  });

  it('uses only fallback templates and writes no mock_inbox or llm rows', async () => {
    expect(await count(`SELECT count(*) FROM sends WHERE template_source <> 'fallback'`)).toBe(0);
    expect(await count('SELECT count(*) FROM mock_inbox')).toBe(0);
    expect(await count('SELECT count(*) FROM llm_cache')).toBe(0);
    expect(await count('SELECT count(*) FROM llm_usage')).toBe(0);
  });

  it('a second seed without a reset throws "already seeded" and changes nothing', async () => {
    const before = await tableHashes();
    await expect(seed(pool, cfg)).rejects.toThrow(/already seeded.*db:reset/);
    expect(await tableHashes()).toEqual(before);
  });
});

describe('seed determinism', () => {
  it('the same seed twice gives identical rows; a different seed gives different contacts', async () => {
    await resetDb(pool);
    await seed(pool, config());
    const first = await tableHashes();

    await resetDb(pool);
    await seed(pool, config());
    expect(await tableHashes()).toEqual(first);

    await resetDb(pool);
    await seed(pool, config({ SEED: '43' }));
    const other = await tableHashes();
    expect(other.contacts).not.toBe(first.contacts);
  }, 120_000);
});

describe('seed with small counts', () => {
  it('13 contacts split by largest remainder and stay consistent', async () => {
    await resetDb(pool);
    expect(await seed(pool, config({ CONTACT_COUNT: '13' }))).toEqual({ contacts: 13 });
    expect(await statusCounts()).toEqual({
      new: 8,
      first_sent: 2,
      follow_up_1_sent: 1,
      follow_up_2_sent: 1,
      follow_up_3_sent: 0,
      replied: 1,
      bounced: 0,
      unsubscribed: 0,
      deactivated: 0,
    });
    expect(await checkInvariants(pool)).toEqual([]);
  }, 30_000);

  it('1 contact is a single new contact due at SIM_START', async () => {
    await resetDb(pool);
    const cfg = config({ CONTACT_COUNT: '1' });
    await seed(pool, cfg);
    const { rows } = await pool.query('SELECT status, next_action, next_action_at FROM contacts');
    expect(rows).toEqual([{ status: 'new', next_action: 'first', next_action_at: cfg.simStart }]);
    expect(await checkInvariants(pool)).toEqual([]);
  }, 30_000);
});

describe('seed with the real 10,000 contacts', () => {
  it('finishes in under 30 seconds and is consistent, with new contacts in daily waves of 1000', async () => {
    await resetDb(pool);
    const cfg = config({ CONTACT_COUNT: '10000' });
    const started = performance.now();
    await seed(pool, cfg);
    expect(performance.now() - started).toBeLessThan(30_000);

    expect(await statusCounts()).toEqual({
      new: 6000,
      first_sent: 1200,
      follow_up_1_sent: 800,
      follow_up_2_sent: 500,
      follow_up_3_sent: 300,
      replied: 500,
      bounced: 200,
      unsubscribed: 200,
      deactivated: 300,
    });
    expect(await checkInvariants(pool)).toEqual([]);

    // The k-th new contact by id (0-based) is due at SIM_START + floor(k / 1000) days.
    const off = await count(
      `SELECT count(*) FROM (
         SELECT next_action_at, (row_number() OVER (ORDER BY id) - 1) / 1000 AS wave
           FROM contacts WHERE status = 'new') x
        WHERE next_action_at <> $1::timestamptz + make_interval(days => wave::int)`,
      [cfg.simStart],
    );
    expect(off).toBe(0);
    expect(
      await count(`SELECT count(*) FROM contacts WHERE status = 'new' AND next_action_at = $1`, [cfg.simStart]),
    ).toBe(1000);
  }, 90_000);
});
