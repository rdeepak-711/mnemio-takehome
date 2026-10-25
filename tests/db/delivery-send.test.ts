import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { loadConfig, type Config } from '../../src/config';
import { createProvider, type Provider, type SendInput } from '../../src/mock/provider';
import { claimDue } from '../../src/engine/claim';
import { sendDue } from '../../src/engine/send';
import { checkInvariants } from '../../src/invariants';
import { inSendWindow, mailboxAddress, unsubscribeHeaders, unsubscribeLink } from '../../src/delivery/rules';

// T22: the send step with deliverability on (D66–D70).
const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);
const providerPool = new pg.Pool({ connectionString: url });
const NOW = new Date('2026-11-02T09:00:00Z'); // a Monday
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const at = (ms: number) => new Date(NOW.getTime() + ms);

// Wide window and caps by default, so each test only turns on the rule it is about.
function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: url,
    BOUNCE_RATE: '0',
    REPLY_RATE: '0',
    DELIVERABILITY: 'on',
    MAILBOX_COUNT: '2',
    WARMUP_START: '50',
    WARMUP_STEP: '0',
    WARMUP_MAX: '50',
    SEND_WINDOW: '0-24',
    DOMAIN_DAILY_CAP: '1000',
    ...overrides,
  });
}

function deps(cfg: Config, provider: Provider = createProvider(providerPool, cfg)) {
  return { provider, config: cfg };
}

let n = 0;

// A `new` contact due at `due`, on its own domain unless one is given.
async function contact(opts: { tz?: string; domain?: string; due?: Date } = {}): Promise<number> {
  n += 1;
  const email = `person${n}@${opts.domain ?? `co${n}.example`}`;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
       status, next_action, next_action_at, created_at, updated_at)
     VALUES ('Ann', 'Lee', $1, 'Acme', 'saas', 'CTO', 'tech', $2, 'tech:saas', 'new', 'first', $3, $4, $4)
     RETURNING id`,
    [email, opts.tz ?? 'Europe/London', opts.due ?? NOW, at(-30 * DAY_MS)],
  );
  return rows[0]!.id;
}

async function contacts(count: number, opts: { tz?: string; domain?: string; due?: Date } = {}): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(await contact(opts));
  return ids;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params);
  return rows[0]!.n;
}

const engineSends = () => count('SELECT count(*)::int AS n FROM sends WHERE mailbox_id IS NOT NULL');

beforeEach(async () => {
  await resetDb(pool);
  n = 0;
});

afterAll(async () => {
  await providerPool.end();
  await closePool();
});

describe('mailboxes are created on the first send (D66)', () => {
  it('creates MAILBOX_COUNT mailboxes with warm-up starting now, once', async () => {
    const cfg = config({ MAILBOX_COUNT: '3' });
    await sendDue(pool, NOW, deps(cfg)); // nothing due: still creates them
    await sendDue(pool, at(DAY_MS), deps(cfg));
    const { rows } = await pool.query(
      'SELECT id, address, warmup_started_at, created_at, paused_until FROM mailboxes ORDER BY id',
    );
    expect(rows).toEqual(
      [1, 2, 3].map((id) => ({
        id,
        address: mailboxAddress(id),
        warmup_started_at: NOW,
        created_at: NOW,
        paused_until: null,
      })),
    );
  });

  it('throws a message naming db:reset when the mailboxes table is missing', async () => {
    await pool.query('DROP TABLE mailbox_pauses, mailboxes CASCADE');
    await expect(sendDue(pool, NOW, deps(config()))).rejects.toThrow(/db:reset/);
  });
});

describe('warm-up limits (D66)', () => {
  it('2 mailboxes starting at 5 and adding 5 a day send 10, then 0 the same day, then 20 the next', async () => {
    const cfg = config({ WARMUP_START: '5', WARMUP_STEP: '5', WARMUP_MAX: '50' });
    await contacts(40);
    await sendDue(pool, NOW, deps(cfg));
    expect(await engineSends()).toBe(10);
    await sendDue(pool, at(HOUR_MS), deps(cfg));
    expect(await engineSends()).toBe(10);
    await sendDue(pool, at(DAY_MS), deps(cfg));
    expect(await engineSends()).toBe(30);
    const perMailbox = await pool.query(
      `SELECT mailbox_id, (sent_at AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS n
         FROM sends GROUP BY 1, 2 ORDER BY 2, 1`,
    );
    expect(perMailbox.rows).toEqual([
      { mailbox_id: 1, day: '2026-11-02', n: 5 },
      { mailbox_id: 2, day: '2026-11-02', n: 5 },
      { mailbox_id: 1, day: '2026-11-03', n: 10 },
      { mailbox_id: 2, day: '2026-11-03', n: 10 },
    ]);
  });

  it('a contact keeps the mailbox of its first send for its follow-ups', async () => {
    const cfg = config({ WARMUP_START: '2', WARMUP_STEP: '0', WARMUP_MAX: '2' });
    const ids = await contacts(4);
    await sendDue(pool, NOW, deps(cfg));
    const first = await pool.query<{ id: number; mailbox_id: number }>(
      'SELECT id, mailbox_id FROM contacts ORDER BY id',
    );
    expect(first.rows.map((r) => r.mailbox_id).sort()).toEqual([1, 1, 2, 2]);

    await sendDue(pool, at(3 * DAY_MS), deps(cfg)); // WAIT_DAYS A = 3
    const { rows } = await pool.query<{ contact_id: number; step: string; mailbox_id: number }>(
      'SELECT contact_id, step, mailbox_id FROM sends ORDER BY contact_id, id',
    );
    expect(rows).toHaveLength(8);
    for (const id of ids) {
      const mine = rows.filter((r) => r.contact_id === id);
      const sticky = first.rows.find((r) => r.id === id)!.mailbox_id;
      expect(mine.map((r) => r.step)).toEqual(['first', 'follow_up_1']);
      expect(mine.map((r) => r.mailbox_id)).toEqual([sticky, sticky]);
    }
  });
});

describe('send windows (D68)', () => {
  it('a Los Angeles contact is not emailed at 09:00 UTC (01:00 local) and is at 17:00 UTC (09:00 local)', async () => {
    const cfg = config({ SEND_WINDOW: '9-17' });
    await contact({ tz: 'America/Los_Angeles' });
    await sendDue(pool, NOW, deps(cfg));
    expect(await engineSends()).toBe(0);
    await sendDue(pool, at(8 * HOUR_MS), deps(cfg));
    expect(await engineSends()).toBe(1);
  });

  it('nobody is emailed on a local Saturday', async () => {
    const cfg = config({ SEND_WINDOW: '9-17' });
    await contact({ tz: 'Europe/London' });
    await sendDue(pool, new Date('2026-11-07T10:00:00Z'), deps(cfg));
    expect(await engineSends()).toBe(0);
    await sendDue(pool, new Date('2026-11-09T10:00:00Z'), deps(cfg)); // Monday
    expect(await engineSends()).toBe(1);
  });

  it('the claim query agrees with inSendWindow for every hour across both daylight-saving changes', async () => {
    const window = { startHour: 9, endHour: 17 };
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
    const byZone = new Map<number, string>();
    for (const tz of zones) byZone.set(await contact({ tz, due: at(-30 * DAY_MS) }), tz);

    const start = new Date('2026-10-23T00:00:00Z').getTime();
    const mismatches: string[] = [];
    const client = await pool.connect();
    try {
      for (let h = 0; h < 12 * 24; h++) {
        const t = new Date(start + h * HOUR_MS);
        await client.query('BEGIN');
        const claimed = await claimDue(client, t, 100, { window });
        await client.query('ROLLBACK');
        const got = claimed.map((c) => byZone.get(c.id)).sort();
        const want = zones.filter((tz) => inSendWindow(t, tz, window)).sort();
        if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`${t.toISOString()}: ${got} vs ${want}`);
      }
    } finally {
      client.release();
    }
    expect(mismatches).toEqual([]);
  });
});

describe('per-domain caps (D69)', () => {
  it('sends at most DOMAIN_DAILY_CAP to one domain per UTC day, and the rest the next day', async () => {
    const cfg = config({ DOMAIN_DAILY_CAP: '3' });
    await contacts(5, { domain: 'Big.Example' });
    await contacts(2);
    await sendDue(pool, NOW, deps(cfg));
    expect(await engineSends()).toBe(5);
    expect(await count(`SELECT count(*)::int AS n FROM sends WHERE recipient_domain = 'big.example'`)).toBe(3);
    await sendDue(pool, at(4 * HOUR_MS), deps(cfg));
    expect(await engineSends()).toBe(5);
    await sendDue(pool, at(DAY_MS), deps(cfg));
    expect(await count(`SELECT count(*)::int AS n FROM sends WHERE recipient_domain = 'big.example'`)).toBe(5);
  });
});

describe('auto-pause on bounces (D67)', () => {
  it('pauses after 50 sends that all bounced, for PAUSE_DAYS, then restarts the warm-up', async () => {
    const cfg = config({ BOUNCE_RATE: '1', MAILBOX_COUNT: '1', WARMUP_START: '80', WARMUP_MAX: '80' });
    await contacts(70);
    await sendDue(pool, NOW, deps(cfg));
    expect(await engineSends()).toBe(50);

    const box = await pool.query('SELECT paused_until, warmup_started_at FROM mailboxes WHERE id = 1');
    expect(box.rows[0]).toEqual({ paused_until: at(3 * DAY_MS), warmup_started_at: at(3 * DAY_MS) });
    const pauses = await pool.query('SELECT mailbox_id, paused_at, resume_at, bounce_rate, sample FROM mailbox_pauses');
    expect(pauses.rows).toEqual([
      { mailbox_id: 1, paused_at: NOW, resume_at: at(3 * DAY_MS), bounce_rate: 1, sample: 50 },
    ]);

    await sendDue(pool, at(DAY_MS), deps(cfg));
    expect(await engineSends()).toBe(50); // still paused

    // Back after 3 days; the old bounces are not in the new sample, so 20 more go out without a new pause.
    await sendDue(pool, at(3 * DAY_MS), deps(cfg));
    expect(await engineSends()).toBe(70);
    expect(await count('SELECT count(*)::int AS n FROM mailbox_pauses')).toBe(1);
    expect(await checkInvariants(pool, 50, cfg)).toEqual([]);
  });

  it('does not pause at the 3% background rate on a small mailbox', async () => {
    const cfg = config({ BOUNCE_RATE: '0.03', MAILBOX_COUNT: '1', WARMUP_START: '200', WARMUP_MAX: '200' });
    await contacts(40);
    await sendDue(pool, NOW, deps(cfg));
    expect(await engineSends()).toBe(40); // under PAUSE_MIN_SENDS, so never paused
    expect(await count('SELECT count(*)::int AS n FROM mailbox_pauses')).toBe(0);
  });
});

describe('List-Unsubscribe and the footer (D70)', () => {
  it('every email carries the headers and link, and the provider gets the sender and headers', async () => {
    const cfg = config();
    const real = createProvider(providerPool, cfg);
    const seen: SendInput[] = [];
    const recording: Provider = {
      send: (input) => {
        seen.push(input);
        return real.send(input);
      },
    };
    await contacts(3);
    await sendDue(pool, NOW, deps(cfg, recording));

    const { rows } = await pool.query<{
      contact_id: number;
      idempotency_key: string;
      mailbox_id: number;
      body: string;
      headers: Record<string, string>;
    }>('SELECT contact_id, idempotency_key, mailbox_id, body, headers FROM sends ORDER BY id');
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      const link = unsubscribeLink(cfg.seed, r.contact_id);
      expect(r.headers).toEqual(unsubscribeHeaders(cfg.seed, r.contact_id));
      expect(r.body.endsWith(`\n\n--\nNot interested? Unsubscribe here: ${link}`)).toBe(true);
      const input = seen.find((s) => s.idempotencyKey === r.idempotency_key)!;
      expect(input.from).toBe(mailboxAddress(r.mailbox_id));
      expect(input.headers).toEqual(r.headers);
      expect(input.body).toBe(r.body);
    }
  });
});

describe('with DELIVERABILITY=off nothing changes (D64)', () => {
  it('no mailboxes, no headers, no footer, no window', async () => {
    const cfg = config({ DELIVERABILITY: 'off', SEND_WINDOW: '9-17' });
    await contact({ tz: 'America/Los_Angeles' }); // 01:00 local: would be outside the window
    await sendDue(pool, NOW, deps(cfg));
    const { rows } = await pool.query('SELECT mailbox_id, recipient_domain, headers, body FROM sends');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mailbox_id: null, recipient_domain: null, headers: {} });
    expect(rows[0].body).not.toMatch(/Unsubscribe here/);
    expect(await count('SELECT count(*)::int AS n FROM mailboxes')).toBe(0);
  });
});

describe('parallel workers (D66, D69)', () => {
  it('4 workers use exactly the capacity, never over a mailbox limit or a domain cap, no duplicates', async () => {
    const cfg = config({
      MAILBOX_COUNT: '10',
      WARMUP_START: '30',
      WARMUP_MAX: '30',
      DOMAIN_DAILY_CAP: '5',
      SEND_BATCH_SIZE: '7',
    });
    for (let d = 0; d < 100; d++) await contacts(10, { domain: `d${d}.example` });
    const provider = createProvider(providerPool, cfg);
    await Promise.all([1, 2, 3, 4].map(() => sendDue(pool, NOW, deps(cfg, provider))));

    expect(await engineSends()).toBe(300);
    expect(
      await count('SELECT count(*)::int AS n FROM (SELECT mailbox_id FROM sends GROUP BY 1 HAVING count(*) > 30) x'),
    ).toBe(0);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM (SELECT recipient_domain FROM sends GROUP BY 1 HAVING count(*) > 5) x',
      ),
    ).toBe(0);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM (SELECT contact_id, step FROM sends GROUP BY 1, 2 HAVING count(*) > 1) x',
      ),
    ).toBe(0);
    expect(await checkInvariants(pool, 50, cfg)).toEqual([]);
  }, 60_000);
});
