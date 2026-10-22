import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { loadConfig } from '../../src/config';
import { createProvider, OOO_HEADERS, type SendInput } from '../../src/mock/provider';
import { REPLY_BANK, RETURN_DATE_TOKEN } from '../../src/mock/replies';
import { classifyByRules, findReturnDate } from '../../src/classify/rules';
import { REPLY_LABELS } from '../../src/labels';

const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);
const NOW = new Date('2026-11-02T09:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function provider(overrides: Record<string, string> = {}) {
  return createProvider(pool, loadConfig({ DATABASE_URL: url, SEED: '42', ...overrides }));
}

const input = (i: number, step = 'first', now = NOW): SendInput => ({
  idempotencyKey: `${i}:${step}`,
  to: `person${i}@acme.example`,
  subject: 'Hello',
  body: 'Hi there',
  now,
});

// Sends inputs `parallel` at a time, in the given order.
async function sendAll(p: ReturnType<typeof provider>, inputs: SendInput[], parallel = 20) {
  const outcomes: string[] = [];
  for (let i = 0; i < inputs.length; i += parallel) {
    const chunk = await Promise.all(inputs.slice(i, i + parallel).map((x) => p.send(x)));
    outcomes.push(...chunk.map((r) => r.outcome));
  }
  return outcomes;
}

type InboxRow = {
  idempotency_key: string;
  body: string;
  headers: Record<string, string>;
  true_label: string;
  deliver_at: Date;
  delivered: boolean;
};

async function inbox(): Promise<InboxRow[]> {
  const { rows } = await pool.query<InboxRow>(
    'SELECT idempotency_key, body, headers, true_label, deliver_at, delivered FROM mock_inbox ORDER BY idempotency_key',
  );
  return rows;
}

async function outbox() {
  const { rows } = await pool.query<{ idempotency_key: string; outcome: string; received_at: Date }>(
    'SELECT idempotency_key, outcome, received_at FROM mock_outbox ORDER BY idempotency_key',
  );
  return rows;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const startOfUtcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const ALL_OOO = 'interested:0,not_interested:0,out_of_office:1,unsubscribe:0';

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await closePool();
});

describe('one send', () => {
  it('returns an outcome and writes one outbox row with received_at = now', async () => {
    const result = await provider().send(input(1));
    expect(['accepted', 'bounced']).toContain(result.outcome);
    expect(await outbox()).toEqual([{ idempotency_key: '1:first', outcome: result.outcome, received_at: NOW }]);
  });

  it('a scheduled reply is undelivered, keyed by the idempotency key, and due 12–72 h later', async () => {
    await provider({ REPLY_RATE: '1', BOUNCE_RATE: '0' }).send(input(1));
    const rows = await inbox();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.idempotency_key).toBe('1:first');
    expect(row.delivered).toBe(false);
    expect(REPLY_LABELS).toContain(row.true_label);
    const delay = row.deliver_at.getTime() - NOW.getTime();
    expect(delay).toBeGreaterThanOrEqual(12 * HOUR_MS);
    expect(delay).toBeLessThanOrEqual(72 * HOUR_MS);
    expect(delay % 60_000).toBe(0);
  });
});

describe('repeated keys', () => {
  it('the same key twice → same outcome, one outbox row, no extra reply; first received_at kept', async () => {
    const p = provider({ REPLY_RATE: '1', BOUNCE_RATE: '0' });
    const first = await p.send(input(1));
    const later = new Date(NOW.getTime() + 3 * DAY_MS);
    const second = await p.send(input(1, 'first', later));
    expect(second).toEqual(first);
    expect(await outbox()).toEqual([{ idempotency_key: '1:first', outcome: first.outcome, received_at: NOW }]);
    expect(await inbox()).toHaveLength(1);
  });

  it('a repeated bounced key still answers bounced', async () => {
    const p = provider({ BOUNCE_RATE: '1' });
    expect(await p.send(input(1))).toEqual({ outcome: 'bounced' });
    expect(await p.send(input(1))).toEqual({ outcome: 'bounced' });
    expect(await outbox()).toHaveLength(1);
  });

  it('five simultaneous sends of one key → one outbox row, at most one reply, one outcome', async () => {
    const p = provider({ REPLY_RATE: '1', BOUNCE_RATE: '0' });
    const results = await Promise.all(range(5).map(() => p.send(input(1))));
    expect(new Set(results.map((r) => r.outcome)).size).toBe(1);
    expect(await outbox()).toHaveLength(1);
    expect((await inbox()).length).toBeLessThanOrEqual(1);
  });

  it('the stored answer wins even if the settings change between calls', async () => {
    await provider({ BOUNCE_RATE: '1' }).send(input(1));
    expect(await provider({ BOUNCE_RATE: '0' }).send(input(1))).toEqual({ outcome: 'bounced' });
  });
});

describe('bounces are per address', () => {
  it('two keys for the same address get the same outcome', async () => {
    const p = provider({ BOUNCE_RATE: '0.5' });
    for (const i of range(40)) {
      const a = await p.send(input(i, 'first'));
      const b = await p.send(input(i, 'follow_up_1'));
      expect(b).toEqual(a);
    }
  });

  it('BOUNCE_RATE=0 → nothing bounces', async () => {
    const outcomes = await sendAll(
      provider({ BOUNCE_RATE: '0' }),
      range(200).map((i) => input(i)),
    );
    expect(outcomes.every((o) => o === 'accepted')).toBe(true);
  });

  it('BOUNCE_RATE=1 → everything bounces and no reply is scheduled', async () => {
    const outcomes = await sendAll(
      provider({ BOUNCE_RATE: '1', REPLY_RATE: '1' }),
      range(200).map((i) => input(i)),
    );
    expect(outcomes.every((o) => o === 'bounced')).toBe(true);
    expect(await inbox()).toEqual([]);
  });
});

describe('reply settings', () => {
  it('REPLY_RATE=0 → no replies', async () => {
    await sendAll(
      provider({ REPLY_RATE: '0', BOUNCE_RATE: '0' }),
      range(200).map((i) => input(i)),
    );
    expect(await inbox()).toEqual([]);
  });

  it('REPLY_RATE=1 → exactly one reply per accepted send', async () => {
    const outcomes = await sendAll(
      provider({ REPLY_RATE: '1' }),
      range(300).map((i) => input(i)),
    );
    const accepted = (await outbox()).filter((r) => r.outcome === 'accepted').map((r) => r.idempotency_key);
    expect(accepted.length).toBe(outcomes.filter((o) => o === 'accepted').length);
    expect((await inbox()).map((r) => r.idempotency_key)).toEqual(accepted);
  });

  it('REPLY_MIX all unsubscribe → every reply is unsubscribe', async () => {
    const mix = 'interested:0,not_interested:0,out_of_office:0,unsubscribe:1';
    await sendAll(
      provider({ REPLY_RATE: '1', REPLY_MIX: mix }),
      range(200).map((i) => input(i)),
    );
    const rows = await inbox();
    expect(rows.length).toBeGreaterThan(150);
    expect(rows.every((r) => r.true_label === 'unsubscribe')).toBe(true);
    expect(rows.every((r) => Object.keys(r.headers).length === 0)).toBe(true);
  });
});

describe('rates over 10,000 sends', () => {
  it('bounce 3% ± 0.6, replies 8% ± 0.9 of accepted, labels within 5 points of the mix, delays 12–72 h', async () => {
    const cfg = { BOUNCE_RATE: '0.03', REPLY_RATE: '0.08' };
    const outcomes = await sendAll(
      provider(cfg),
      range(10_000).map((i) => input(i)),
      50,
    );
    const bounced = outcomes.filter((o) => o === 'bounced').length;
    expect(bounced / 10_000).toBeGreaterThan(0.024);
    expect(bounced / 10_000).toBeLessThan(0.036);

    const rows = await inbox();
    const accepted = 10_000 - bounced;
    expect(rows.length / accepted).toBeGreaterThan(0.071);
    expect(rows.length / accepted).toBeLessThan(0.089);

    const mix = loadConfig({ DATABASE_URL: url }).replyMix;
    for (const label of REPLY_LABELS) {
      const share = rows.filter((r) => r.true_label === label).length / rows.length;
      expect(Math.abs(share - mix[label])).toBeLessThan(0.05);
    }
    for (const r of rows) {
      const delay = r.deliver_at.getTime() - NOW.getTime();
      expect(delay).toBeGreaterThanOrEqual(12 * HOUR_MS);
      expect(delay).toBeLessThanOrEqual(72 * HOUR_MS);
    }
  }, 120_000);
});

describe('out-of-office replies', () => {
  it('carry OOO_HEADERS or none, with and without a date; dated ones return 2–14 days after delivery', async () => {
    await sendAll(
      provider({ REPLY_RATE: '1', BOUNCE_RATE: '0', REPLY_MIX: ALL_OOO }),
      range(400).map((i) => input(i)),
    );
    const rows = await inbox();
    expect(rows).toHaveLength(400);
    const withHeader = rows.filter((r) => Object.keys(r.headers).length > 0);
    for (const r of withHeader) expect(r.headers).toEqual(OOO_HEADERS);
    expect(withHeader.length).toBeGreaterThan(240); // ~75%
    expect(withHeader.length).toBeLessThan(360);

    let dated = 0;
    for (const r of rows) {
      expect(r.body).not.toContain(RETURN_DATE_TOKEN);
      const found = findReturnDate(r.body, r.deliver_at);
      if (found === null) continue;
      dated += 1;
      const days = (found.getTime() - startOfUtcDay(r.deliver_at)) / DAY_MS;
      expect(days).toBeGreaterThanOrEqual(2);
      expect(days).toBeLessThanOrEqual(14);
    }
    expect(dated).toBeGreaterThan(0);
    expect(dated).toBeLessThan(400);
  });
});

describe('generated replies', () => {
  it('rules never mislabel any generated reply, and ambiguous texts are generated', async () => {
    await sendAll(
      provider({ REPLY_RATE: '1', BOUNCE_RATE: '0' }),
      range(600).map((i) => input(i)),
    );
    const rows = await inbox();
    for (const r of rows) {
      const result = classifyByRules({ body: r.body, headers: r.headers }, r.deliver_at);
      if (result !== null) expect(result.label).toBe(r.true_label);
    }
    const ambiguousBodies = REPLY_LABELS.flatMap((label) =>
      REPLY_BANK[label].filter((t) => t.ambiguous && !t.body.includes(RETURN_DATE_TOKEN)).map((t) => t.body),
    );
    expect(rows.some((r) => ambiguousBodies.includes(r.body))).toBe(true);
    for (const label of REPLY_LABELS) expect(rows.some((r) => r.true_label === label)).toBe(true);
  });
});

describe('order independence', () => {
  it('the same keys in order, then shuffled and in parallel, give identical outbox and inbox', async () => {
    const cfg = { BOUNCE_RATE: '0.2', REPLY_RATE: '0.5' };
    const inputs = range(300).map((i) => input(i));
    await sendAll(provider(cfg), inputs, 1);
    const firstOut = await outbox();
    const firstIn = await inbox();

    await resetDb(pool);
    // Odd positions first, then even, all reversed: a fixed reordering that breaks every neighbour pair.
    const shuffled = [...inputs.filter((_, i) => i % 2 === 1), ...inputs.filter((_, i) => i % 2 === 0)].reverse();
    await sendAll(provider(cfg), shuffled, 10);
    expect(await outbox()).toEqual(firstOut);
    expect(await inbox()).toEqual(firstIn);
  }, 60_000);

  it('a different seed gives different outcomes', async () => {
    const cfg = { BOUNCE_RATE: '0.5', REPLY_RATE: '0.5' };
    const a = await sendAll(
      provider({ ...cfg, SEED: '1' }),
      range(100).map((i) => input(i)),
    );
    await resetDb(pool);
    const b = await sendAll(
      provider({ ...cfg, SEED: '2' }),
      range(100).map((i) => input(i)),
    );
    expect(b).not.toEqual(a);
  });
});

describe('an outside service', () => {
  it("a send during the caller's open transaction survives the caller's rollback", async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await provider().send(input(1));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await outbox()).toHaveLength(1);
  });
});
