import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { loadConfig, type Config } from '../../src/config';
import { createProvider } from '../../src/mock/provider';
import { contactVars, sendDue, type SendDeps, type Template } from '../../src/engine/send';
import { checkInvariants } from '../../src/invariants';
import { seed } from '../../src/seed/seed';

const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);
// The provider's own pool (D43): a real email service has its own connections.
const providerPool = new pg.Pool({ connectionString: url });
const NOW = new Date('2026-11-02T09:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: url, BOUNCE_RATE: '0', REPLY_RATE: '0', DELIVERABILITY: 'off', ...overrides });
}

function deps(overrides: Record<string, string> = {}, extra: Partial<SendDeps> = {}): SendDeps {
  const cfg = config(overrides);
  return { provider: createProvider(providerPool, cfg), config: cfg, ...extra };
}

const NEXT: Record<string, string | null> = {
  new: 'first',
  first_sent: 'follow_up_1',
  follow_up_1_sent: 'follow_up_2',
  follow_up_2_sent: 'follow_up_3',
  follow_up_3_sent: 'deactivate',
  replied: null,
  bounced: null,
  unsubscribed: null,
  deactivated: null,
};
const PRIOR_STEPS: Record<string, string[]> = {
  new: [],
  first_sent: ['first'],
  follow_up_1_sent: ['first', 'follow_up_1'],
  follow_up_2_sent: ['first', 'follow_up_1', 'follow_up_2'],
  follow_up_3_sent: ['first', 'follow_up_1', 'follow_up_2', 'follow_up_3'],
};
const CHAIN = ['new', 'first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent'];

let n = 0;

// Inserts a contact with consistent prior sends, outbox rows and events (so checkInvariants holds).
async function contact(
  status: string,
  opts: { due?: Date; company?: string; firstName?: string } = {},
): Promise<{ id: number; email: string }> {
  n += 1;
  const email = `person${n}@acme.example`;
  const next = NEXT[status] ?? null;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
       status, next_action, next_action_at, created_at, updated_at)
     VALUES ($1, 'Lee', $2, $3, 'saas', 'CTO', 'tech', 'Europe/London', 'tech:saas', $4, $5, $6, $7, $7)
     RETURNING id`,
    [
      opts.firstName ?? 'Ann',
      email,
      opts.company ?? 'Acme',
      status,
      next,
      next ? (opts.due ?? NOW) : null,
      at(-60 * DAY_MS),
    ],
  );
  const id = rows[0]!.id;
  const prior = PRIOR_STEPS[status] ?? [];
  for (const [i, step] of prior.entries()) {
    const sentAt = at(-(30 - i) * DAY_MS);
    const key = `${id}:${step}`;
    await pool.query(
      `INSERT INTO sends (contact_id, step, idempotency_key, outcome, subject, body, template_source, sent_at)
       VALUES ($1, $2, $3, 'accepted', 's', 'b', 'fallback', $4)`,
      [id, step, key, sentAt],
    );
    await pool.query(`INSERT INTO mock_outbox (idempotency_key, outcome, received_at) VALUES ($1, 'accepted', $2)`, [
      key,
      sentAt,
    ]);
    await pool.query(`INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, 'status_changed', $2, $3)`, [
      id,
      JSON.stringify({ from: CHAIN[i], to: CHAIN[i + 1], reason: 'sent' }),
      sentAt,
    ]);
  }
  return { id, email };
}

async function many(count: number, status = 'new') {
  for (let i = 0; i < count; i += 1) await contact(status);
}

async function q<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows;
}
const count = async (sql: string, params: unknown[] = []) =>
  (await q<{ n: number }>(`SELECT (${sql})::int AS n`, params))[0]!.n;

beforeEach(async () => {
  await resetDb(pool);
  n = 0;
});

afterAll(async () => {
  await providerPool.end();
  await closePool();
});

describe('one accepted send', () => {
  it('a due new contact gets its first email, recorded and moved on', async () => {
    const c = await contact('new', { firstName: 'Priya', company: 'Globex' });
    const summary = await sendDue(pool, NOW, deps());
    expect(summary).toEqual({ sent: 1, bounced: 0, suppressed: 0, batches: 1 });

    const sends = await q<Record<string, unknown>>('SELECT * FROM sends');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      contact_id: c.id,
      step: 'first',
      idempotency_key: `${c.id}:first`,
      outcome: 'accepted',
      template_source: 'fallback',
      sent_at: NOW,
    });
    expect(String(sends[0]!.body)).toContain('Priya');
    expect(`${String(sends[0]!.subject)} ${String(sends[0]!.body)}`).toContain('Globex');

    const [row] = await q('SELECT status, next_action, next_action_at, updated_at FROM contacts');
    expect(row).toEqual({
      status: 'first_sent',
      next_action: 'follow_up_1',
      next_action_at: at(3 * DAY_MS),
      updated_at: NOW,
    });

    const events = await q<{ type: string; data: Record<string, unknown>; occurred_at: Date }>(
      'SELECT type, data, occurred_at FROM events ORDER BY id',
    );
    expect(events).toEqual([
      { type: 'sent', data: { step: 'first', outcome: 'accepted', send_id: sends[0]!.id }, occurred_at: NOW },
      { type: 'status_changed', data: { from: 'new', to: 'first_sent', reason: 'sent' }, occurred_at: NOW },
    ]);
    expect(await count('SELECT count(*) FROM mock_outbox')).toBe(1);
  });

  it('follow_up_2_sent sends follow_up_3 and waits 7 days to deactivate', async () => {
    await contact('follow_up_2_sent');
    await sendDue(pool, NOW, deps());
    const [row] = await q('SELECT status, next_action, next_action_at FROM contacts');
    expect(row).toEqual({ status: 'follow_up_3_sent', next_action: 'deactivate', next_action_at: at(7 * DAY_MS) });
    expect(await count(`SELECT count(*) FROM sends WHERE step = 'follow_up_3' AND sent_at = $1`, [NOW])).toBe(1);
  });

  it('not-yet-due, terminal and follow_up_3_sent contacts are untouched', async () => {
    await contact('new', { due: at(1) });
    for (const s of ['replied', 'bounced', 'unsubscribed', 'deactivated']) await contact(s);
    await contact('follow_up_3_sent', { due: at(-DAY_MS) });
    const before = await q('SELECT * FROM contacts ORDER BY id');
    const sendsBefore = await count('SELECT count(*) FROM sends');
    expect(await sendDue(pool, NOW, deps())).toEqual({ sent: 0, bounced: 0, suppressed: 0, batches: 0 });
    expect(await q('SELECT * FROM contacts ORDER BY id')).toEqual(before);
    expect(await count('SELECT count(*) FROM sends')).toBe(sendsBefore);
  });
});

describe('bounces and suppression', () => {
  it('a bounce records the send, closes the contact and suppresses the address', async () => {
    const c = await contact('new');
    const summary = await sendDue(pool, NOW, deps({ BOUNCE_RATE: '1' }));
    expect(summary).toEqual({ sent: 0, bounced: 1, suppressed: 0, batches: 1 });
    expect(await q('SELECT step, outcome FROM sends')).toEqual([{ step: 'first', outcome: 'bounced' }]);
    expect(await q('SELECT status, next_action, next_action_at FROM contacts')).toEqual([
      { status: 'bounced', next_action: null, next_action_at: null },
    ]);
    expect(await q('SELECT email, reason, added_at FROM suppression')).toEqual([
      { email: c.email, reason: 'bounced', added_at: NOW },
    ]);
    const events = await q<{ type: string; data: Record<string, unknown> }>(
      'SELECT type, data FROM events ORDER BY id',
    );
    expect(events.map((e) => e.type)).toEqual(['sent', 'status_changed']);
    expect(events[0]!.data).toMatchObject({ step: 'first', outcome: 'bounced' });
    expect(events[1]!.data).toEqual({ from: 'new', to: 'bounced', reason: 'bounced' });
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it.each(['bounced', 'unsubscribed'])(
    'a contact whose address is suppressed (%s) is closed, never sent',
    async (reason) => {
      const c = await contact('first_sent');
      await pool.query('INSERT INTO suppression (email, reason, added_at) VALUES ($1, $2, $3)', [
        c.email,
        reason,
        at(-DAY_MS),
      ]);
      const sendsBefore = await count('SELECT count(*) FROM sends');
      const outboxBefore = await count('SELECT count(*) FROM mock_outbox');
      const summary = await sendDue(pool, NOW, deps());
      expect(summary).toEqual({ sent: 0, bounced: 0, suppressed: 1, batches: 1 });
      expect(await count('SELECT count(*) FROM sends')).toBe(sendsBefore);
      expect(await count('SELECT count(*) FROM mock_outbox')).toBe(outboxBefore);
      expect(await q('SELECT status, next_action, next_action_at, updated_at FROM contacts')).toEqual([
        { status: reason, next_action: null, next_action_at: null, updated_at: NOW },
      ]);
      const events = await q<{ type: string; data: Record<string, unknown> }>(
        'SELECT type, data FROM events WHERE occurred_at = $1',
        [NOW],
      );
      expect(events).toEqual([
        { type: 'status_changed', data: { from: 'first_sent', to: reason, reason: 'suppressed' } },
      ]);
    },
  );
});

describe('never twice', () => {
  it('a second run at the same time does nothing', async () => {
    await many(10);
    await sendDue(pool, NOW, deps({ BOUNCE_RATE: '0.3' }));
    const before = {
      sends: await count('SELECT count(*) FROM sends'),
      contacts: await q('SELECT * FROM contacts ORDER BY id'),
    };
    expect(await sendDue(pool, NOW, deps({ BOUNCE_RATE: '0.3' }))).toEqual({
      sent: 0,
      bounced: 0,
      suppressed: 0,
      batches: 0,
    });
    expect(await count('SELECT count(*) FROM sends')).toBe(before.sends);
    expect(await q('SELECT * FROM contacts ORDER BY id')).toEqual(before.contacts);
  });

  it('the summary counts match the rows', async () => {
    await many(40);
    const summary = await sendDue(pool, NOW, deps({ BOUNCE_RATE: '0.3' }));
    expect(summary.sent).toBe(await count(`SELECT count(*) FROM sends WHERE outcome = 'accepted'`));
    expect(summary.bounced).toBe(await count(`SELECT count(*) FROM sends WHERE outcome = 'bounced'`));
    expect(summary.sent + summary.bounced).toBe(40);
    expect(summary.bounced).toBeGreaterThan(0);
  });

  it('works through many batches', async () => {
    await many(20);
    const summary = await sendDue(pool, NOW, deps({ SEND_BATCH_SIZE: '7' }));
    expect(summary.sent).toBe(20);
    expect(summary.batches).toBeGreaterThanOrEqual(3);
    expect(await count(`SELECT count(*) FROM contacts WHERE status = 'first_sent'`)).toBe(20);
  });

  it('4 workers in parallel over 2,000 due contacts send exactly 2,000 emails', async () => {
    await pool.query(
      `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
         status, next_action, next_action_at, created_at, updated_at)
       SELECT 'Ann', 'Lee', 'p' || g || '@acme.example', 'Acme', 'saas', 'CTO', 'tech', 'Europe/London', 'tech:saas',
         'new', 'first', $1, $2, $2
       FROM generate_series(1, 2000) g`,
      [NOW, at(-DAY_MS)],
    );
    const d = deps({ BOUNCE_RATE: '0.03', SEND_BATCH_SIZE: '50' });
    const results = await Promise.all(Array.from({ length: 4 }, () => sendDue(pool, NOW, d)));
    const total = results.reduce((sum, r) => sum + r.sent + r.bounced, 0);
    expect(total).toBe(2000);
    expect(await count('SELECT count(*) FROM sends')).toBe(2000);
    expect(await count('SELECT count(DISTINCT idempotency_key) FROM sends')).toBe(2000);
    expect(await count('SELECT count(*) FROM mock_outbox')).toBe(2000);
    expect(results.filter((r) => r.batches > 0).length).toBeGreaterThan(1);
    expect(await checkInvariants(pool)).toEqual([]);
  }, 120_000);

  it('12 workers on an engine pool of 10 finish (the provider has its own pool)', async () => {
    await many(60);
    const d = deps({ SEND_BATCH_SIZE: '2' });
    const run = Promise.all(Array.from({ length: 12 }, () => sendDue(pool, NOW, d)));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 20_000));
    await Promise.race([run, timeout]);
    expect(await count('SELECT count(*) FROM sends WHERE sent_at = $1', [NOW])).toBe(60);
  }, 30_000);
});

describe('a crash between the provider call and the commit', () => {
  it('undoes our side, keeps the provider’s, and the re-run sends each email once', async () => {
    await many(5);
    let calls = 0;
    const crash = deps(
      {},
      {
        afterProviderCall: () => {
          calls += 1;
          if (calls === 3) throw new Error('simulated crash');
        },
      },
    );
    await expect(sendDue(pool, NOW, crash)).rejects.toThrow('simulated crash');
    expect(await count('SELECT count(*) FROM sends')).toBe(0);
    expect(await count(`SELECT count(*) FROM contacts WHERE status = 'new'`)).toBe(5);
    expect(await count('SELECT count(*) FROM events')).toBe(0);
    expect(await count('SELECT count(*) FROM mock_outbox')).toBe(3);

    const summary = await sendDue(pool, NOW, deps());
    expect(summary.sent).toBe(5);
    expect(await count('SELECT count(*) FROM sends')).toBe(5);
    expect(await count('SELECT count(*) FROM mock_outbox')).toBe(5);
    expect(await checkInvariants(pool)).toEqual([]);
  });
});

describe('templates', () => {
  it('a company called {{evil}} Ltd is sent with the braces removed', async () => {
    await contact('new', { company: '{{evil}} Ltd' });
    expect((await sendDue(pool, NOW, deps())).sent).toBe(1);
    const [s] = await q<{ subject: string; body: string }>('SELECT subject, body FROM sends');
    expect(`${s!.subject} ${s!.body}`).toContain('evil Ltd');
    expect(`${s!.subject} ${s!.body}`).not.toMatch(/[{}]/);
  });

  const AI: Template = {
    subject: 'Quick question for {{company}}',
    body: 'Hi {{first_name}}, how does {{company}} handle onboarding today?',
    source: 'ai',
  };

  it('a valid template from getTemplate is used and its source recorded', async () => {
    await contact('new', { firstName: 'Zoe' });
    const seen: string[] = [];
    await sendDue(pool, NOW, deps({}, { getTemplate: async (segment, step) => (seen.push(`${segment}/${step}`), AI) }));
    expect(seen).toEqual(['tech:saas/first']);
    expect(await q('SELECT subject, body, template_source FROM sends')).toEqual([
      {
        subject: 'Quick question for Acme',
        body: 'Hi Zoe, how does Acme handle onboarding today?',
        template_source: 'ai',
      },
    ]);
  });

  it.each([
    ['a spam word', { ...AI, body: 'Hi {{first_name}}, guaranteed results, act now.' }],
    ['an unknown slot', { ...AI, body: 'Hi {{nickname}}!' }],
    ['an empty subject', { ...AI, subject: '   ' }],
  ])('a template with %s falls back', async (_label, template) => {
    await contact('new');
    await sendDue(pool, NOW, deps({}, { getTemplate: async () => template }));
    expect(await q('SELECT template_source FROM sends')).toEqual([{ template_source: 'fallback' }]);
  });

  it('getTemplate returning null falls back', async () => {
    await contact('new');
    await sendDue(pool, NOW, deps({}, { getTemplate: async () => null }));
    expect(await q('SELECT template_source FROM sends')).toEqual([{ template_source: 'fallback' }]);
  });
});

describe('on seeded data', () => {
  it('one run at SIM_START handles every due contact and keeps every invariant', async () => {
    const cfg = loadConfig({ DATABASE_URL: url, CONTACT_COUNT: '1000', DELIVERABILITY: 'off' });
    await seed(pool, cfg);
    const summary = await sendDue(pool, cfg.simStart, { provider: createProvider(providerPool, cfg), config: cfg });
    expect(summary.sent + summary.bounced).toBeGreaterThan(600);
    expect(
      await count(
        `SELECT count(*) FROM contacts WHERE next_action IN ('first','follow_up_1','follow_up_2','follow_up_3')
           AND next_action_at <= $1`,
        [cfg.simStart],
      ),
    ).toBe(0);
    expect(await checkInvariants(pool)).toEqual([]);
  }, 60_000);
});

describe('contact data never stops the run (probe after build)', () => {
  it.each([
    ['an empty first name', { firstName: '' }],
    ['a company that is only braces', { company: '{{}}' }],
    ['a first name of spaces', { firstName: '   ' }],
  ])('%s still gets an email with a sensible stand-in', async (_label, opts) => {
    await contact('new', opts);
    expect((await sendDue(pool, NOW, deps())).sent).toBe(1);
    const [s] = await q<{ subject: string; body: string }>('SELECT subject, body FROM sends');
    expect(s!.body).toMatch(/^Hi \S/);
    expect(`${s!.subject} ${s!.body}`).not.toMatch(/[{}]|\s,|\s{3,}/);
  });
});

describe('contactVars', () => {
  const base = {
    id: 1,
    email: 'a@b.example',
    firstName: 'Ann',
    lastName: 'Lee',
    company: 'Acme',
    industry: 'saas' as const,
    role: 'CTO',
    roleFamily: 'tech' as const,
    timezone: 'Europe/London',
    segment: 'tech:saas',
    status: 'new' as const,
    nextAction: 'first' as const,
    nextActionAt: NOW,
  };

  it.each([
    ['saas', 'SaaS'],
    ['ecommerce', 'e-commerce'],
    ['fintech', 'fintech'],
    ['healthcare', 'healthcare'],
    ['logistics', 'logistics'],
  ] as const)('industry %s reads as %s', (industry, text) => {
    expect(contactVars({ ...base, industry, segment: `tech:${industry}` }).industry).toBe(text);
  });

  it('empty values get stand-ins, never an empty string', () => {
    const vars = contactVars({ ...base, firstName: ' ', company: '{}', role: '' });
    expect(vars.first_name).toBe('there');
    expect(vars.company).toBe('your company');
    expect(vars.role).toBe('your role');
    for (const v of Object.values(vars)) expect(v.trim().length).toBeGreaterThan(0);
  });

  it('trims surrounding spaces', () => {
    expect(contactVars({ ...base, firstName: '  Ann ' }).first_name).toBe('Ann');
  });
});
