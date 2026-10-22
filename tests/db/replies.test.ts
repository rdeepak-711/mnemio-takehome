import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { loadConfig } from '../../src/config';
import { createProvider } from '../../src/mock/provider';
import { sendDue } from '../../src/engine/send';
import { checkInvariants } from '../../src/invariants';
import type { Label } from '../../src/labels';
import {
  deliverReplies,
  processReplies,
  REPLY_BATCH_SIZE,
  type ClassifyItem,
  type Classifier,
  type ReplyDeps,
} from '../../src/engine/replies';

const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);
const NOW = new Date('2026-11-02T09:00:00Z'); // a Monday
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const AUTO = { 'Auto-Submitted': 'auto-replied' };

// Reply texts: the first three are left alone by the rules (T07), the rest the rules label.
const TEXT = {
  interested: 'Sounds interesting, can we talk on Thursday?',
  notInterested: 'No thanks, we already have a provider for this.',
  aiOoo: 'Travelling this week, back on 2026-11-20, will reply then.',
  unsubscribe: 'Please unsubscribe me from this list.',
  oooDated: 'I am out of the office until 20 November.',
  oooUndated: 'I am out of the office with limited access to email.',
  oooFriday: 'I am out of the office, returning Friday.',
};

// A fake AI: answers by text, and remembers what it was asked.
const AI_ANSWERS: Record<string, Label> = {
  [TEXT.interested]: 'interested',
  [TEXT.notInterested]: 'not_interested',
  [TEXT.aiOoo]: 'out_of_office',
};
function fakeAi() {
  const calls: ClassifyItem[][] = [];
  const classify: Classifier = async (items) => {
    calls.push(items);
    const answers = new Map<number, Label>();
    for (const item of items) {
      const label = AI_ANSWERS[item.body];
      if (label) answers.set(item.id, label);
    }
    return answers;
  };
  return { calls, classify };
}

const deps = (classify?: Classifier): ReplyDeps => ({ config: { oooDefaultDays: 7 }, classify });

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
const STEPS = ['first', 'follow_up_1', 'follow_up_2', 'follow_up_3'];
const CHAIN = ['new', 'first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent'];
const SENDS_FOR: Record<string, number> = {
  new: 0,
  first_sent: 1,
  follow_up_1_sent: 2,
  follow_up_2_sent: 3,
  follow_up_3_sent: 4,
  replied: 1,
  deactivated: 4,
};

let n = 0;

type Made = { id: number; email: string; key: (step: string) => string };

// A contact with consistent prior sends, outbox rows, events and (for a bounce) a suppression row,
// so checkInvariants holds before processing. `bouncedAt` makes that step's send bounce.
async function contact(status: string, opts: { due?: Date; bouncedAt?: string } = {}): Promise<Made> {
  n += 1;
  const email = `person${n}@acme.example`;
  const next = NEXT[status] ?? null;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
       status, next_action, next_action_at, created_at, updated_at)
     VALUES ('Ann', 'Lee', $1, 'Acme', 'saas', 'CTO', 'tech', 'Europe/London', 'tech:saas', $2, $3, $4, $5, $5)
     RETURNING id`,
    [email, status, next, next ? (opts.due ?? at(DAY_MS)) : null, at(-60 * DAY_MS)],
  );
  const id = rows[0]!.id;
  const count = opts.bouncedAt ? STEPS.indexOf(opts.bouncedAt) + 1 : (SENDS_FOR[status] ?? 0);
  let from = 'new';
  for (let i = 0; i < count; i += 1) {
    const step = STEPS[i]!;
    const sentAt = at(-(30 - i) * DAY_MS);
    const outcome = step === opts.bouncedAt ? 'bounced' : 'accepted';
    await pool.query(
      `INSERT INTO sends (contact_id, step, idempotency_key, outcome, subject, body, template_source, sent_at)
       VALUES ($1, $2, $3, $4, 's', 'b', 'fallback', $5)`,
      [id, step, `${id}:${step}`, outcome, sentAt],
    );
    await pool.query(`INSERT INTO mock_outbox (idempotency_key, outcome, received_at) VALUES ($1, $2, $3)`, [
      `${id}:${step}`,
      outcome,
      sentAt,
    ]);
    const to = outcome === 'bounced' ? 'bounced' : CHAIN[i + 1]!;
    await changed(id, from, to, sentAt);
    if (outcome === 'bounced') await pool.query(`INSERT INTO suppression VALUES ($1, 'bounced', $2)`, [email, sentAt]);
    from = to;
  }
  if (from !== status) await changed(id, from, status, at(-2 * DAY_MS));
  return { id, email, key: (step) => `${id}:${step}` };
}

async function changed(id: number, from: string, to: string, occurredAt: Date) {
  await pool.query(`INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, 'status_changed', $2, $3)`, [
    id,
    JSON.stringify({ from, to, reason: 'test' }),
    occurredAt,
  ]);
}

// A reply waiting in the mock inbox.
async function inbox(
  key: string,
  body: string,
  opts: { deliverAt?: Date; headers?: Record<string, string>; trueLabel?: string } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO mock_inbox (idempotency_key, body, headers, true_label, deliver_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [key, body, JSON.stringify(opts.headers ?? {}), opts.trueLabel ?? 'interested', opts.deliverAt ?? at(-HOUR_MS)],
  );
  return rows[0]!.id;
}

// Deliver and process at `now`, the way a tick does.
async function tick(classify?: Classifier, now = NOW) {
  await deliverReplies(pool, now);
  return processReplies(pool, now, deps(classify));
}

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await pool.query<T>(sql, params)).rows;
}
const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;
const count = async (sql: string, params: unknown[] = []) =>
  Number((await q<{ n: string }>(`SELECT (${sql}) AS n`, params))[0]!.n);
const contactRow = (id: number) =>
  one('SELECT status, next_action, next_action_at, updated_at FROM contacts WHERE id = $1', [id]);
const newEvents = (id: number) =>
  q('SELECT type, data, occurred_at FROM events WHERE contact_id = $1 AND occurred_at = $2 ORDER BY id', [id, NOW]);
const replyRow = (id: number) =>
  one('SELECT label, label_source, return_date, classified_at FROM replies WHERE contact_id = $1 ORDER BY id', [id]);

beforeEach(async () => {
  await resetDb(pool);
  n = 0;
});

afterAll(async () => {
  await closePool();
});

describe('deliverReplies', () => {
  it('moves a due mock reply into replies, linked to its send, and marks it delivered', async () => {
    const c = await contact('first_sent');
    const inboxId = await inbox(c.key('first'), TEXT.interested, {
      headers: { 'X-Test': '1' },
      trueLabel: 'interested',
    });
    expect(await deliverReplies(pool, NOW)).toEqual({ delivered: 1 });

    const sendId = (await one('SELECT id FROM sends WHERE idempotency_key = $1', [c.key('first')])).id;
    expect(await q('SELECT * FROM replies')).toEqual([
      expect.objectContaining({
        contact_id: c.id,
        send_id: sendId,
        body: TEXT.interested,
        headers: { 'X-Test': '1' },
        received_at: at(-HOUR_MS),
        true_label: 'interested',
        label: null,
        label_source: null,
        return_date: null,
        classified_at: null,
      }),
    ]);
    expect(await one('SELECT delivered FROM mock_inbox WHERE id = $1', [inboxId])).toEqual({ delivered: true });
  });

  it('delivers a reply due exactly now, and not one due a millisecond later', async () => {
    const a = await contact('first_sent');
    const b = await contact('first_sent');
    await inbox(a.key('first'), TEXT.interested, { deliverAt: NOW });
    await inbox(b.key('first'), TEXT.interested, { deliverAt: at(1) });
    expect(await deliverReplies(pool, NOW)).toEqual({ delivered: 1 });
    expect(await q('SELECT contact_id FROM replies')).toEqual([{ contact_id: a.id }]);
    expect(await count('SELECT count(*) FROM mock_inbox WHERE NOT delivered')).toBe(1);
  });

  it('a second run at the same now delivers nothing more', async () => {
    const c = await contact('first_sent');
    await inbox(c.key('first'), TEXT.interested);
    await deliverReplies(pool, NOW);
    expect(await deliverReplies(pool, NOW)).toEqual({ delivered: 0 });
    expect(await count('SELECT count(*) FROM replies')).toBe(1);
  });

  it('a reply whose send does not exist yet waits, then arrives once the send commits (D35)', async () => {
    const c = await contact('new', { due: NOW });
    await inbox(c.key('first'), TEXT.interested, { deliverAt: at(-2 * DAY_MS) });
    expect(await deliverReplies(pool, NOW)).toEqual({ delivered: 0 });
    expect(await count('SELECT count(*) FROM mock_inbox WHERE NOT delivered')).toBe(1);

    // The retried send commits on this tick.
    await pool.query(
      `INSERT INTO sends (contact_id, step, idempotency_key, outcome, subject, body, template_source, sent_at)
       VALUES ($1, 'first', $2, 'accepted', 's', 'b', 'fallback', $3)`,
      [c.id, c.key('first'), NOW],
    );
    await pool.query(`INSERT INTO mock_outbox VALUES ($1, 'accepted', $2)`, [c.key('first'), NOW]);
    await pool.query(
      `UPDATE contacts SET status = 'first_sent', next_action = 'follow_up_1', next_action_at = $2 WHERE id = $1`,
      [c.id, at(3 * DAY_MS)],
    );
    await changed(c.id, 'new', 'first_sent', NOW);

    const next = at(DAY_MS);
    expect(await deliverReplies(pool, next)).toEqual({ delivered: 1 });
    // deliver_at is before the retried send, so the reply is dated when we actually got it.
    expect(await one('SELECT received_at FROM replies')).toEqual({ received_at: next });
    await processReplies(pool, next, deps(fakeAi().classify));
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('4 workers at once over 200 due replies deliver each exactly once', async () => {
    for (let i = 0; i < 200; i += 1) {
      const c = await contact('first_sent');
      await inbox(c.key('first'), TEXT.interested);
    }
    const results = await Promise.all(Array.from({ length: 4 }, () => deliverReplies(pool, NOW)));
    expect(results.reduce((sum, r) => sum + r.delivered, 0)).toBe(200);
    expect(await count('SELECT count(*) FROM replies')).toBe(200);
    expect(await count('SELECT count(DISTINCT send_id) FROM replies')).toBe(200);
    expect(await count('SELECT count(*) FROM mock_inbox WHERE NOT delivered')).toBe(0);
  });
});

describe('processReplies: interested and not interested', () => {
  it.each(['first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent'])(
    'interested from %s → replied, sequence stopped, events written',
    async (status) => {
      const c = await contact(status);
      await inbox(c.key(STEPS[(SENDS_FOR[status] ?? 1) - 1]!), TEXT.interested);
      const summary = await tick(fakeAi().classify);
      expect(summary).toEqual({ processed: 1, rule: 0, ai: 1, fallback: 0 });

      expect(await contactRow(c.id)).toEqual({
        status: 'replied',
        next_action: null,
        next_action_at: null,
        updated_at: NOW,
      });
      expect(await replyRow(c.id)).toEqual({
        label: 'interested',
        label_source: 'ai',
        return_date: null,
        classified_at: NOW,
      });
      const replyId = (await one('SELECT id FROM replies')).id;
      expect(await newEvents(c.id)).toEqual([
        {
          type: 'reply_received',
          data: { reply_id: replyId, label: 'interested', label_source: 'ai' },
          occurred_at: NOW,
        },
        { type: 'status_changed', data: { from: status, to: 'replied', reason: 'reply' }, occurred_at: NOW },
      ]);
      expect(await checkInvariants(pool)).toEqual([]);
    },
  );

  it('not interested → replied', async () => {
    const c = await contact('first_sent');
    await inbox(c.key('first'), TEXT.notInterested);
    await tick(fakeAi().classify);
    expect((await contactRow(c.id)).status).toBe('replied');
    expect((await replyRow(c.id)).label).toBe('not_interested');
  });

  it('the AI is only asked about replies the rules left alone, and never sees the true label', async () => {
    const a = await contact('first_sent');
    const b = await contact('first_sent');
    await inbox(a.key('first'), TEXT.unsubscribe);
    await inbox(b.key('first'), TEXT.interested);
    const ai = fakeAi();
    await tick(ai.classify);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.map((item) => Object.keys(item).sort())).toEqual([['body', 'id']]);
    expect(ai.calls[0]!.map((item) => item.body)).toEqual([TEXT.interested]);
  });
});

describe('processReplies: no answer from the AI', () => {
  it('with no classifier, a reply the rules leave alone is needs_review (fallback) and the contact is replied', async () => {
    const c = await contact('first_sent');
    await inbox(c.key('first'), TEXT.interested);
    expect(await tick(undefined)).toEqual({ processed: 1, rule: 0, ai: 0, fallback: 1 });
    expect(await replyRow(c.id)).toMatchObject({ label: 'needs_review', label_source: 'fallback' });
    expect((await contactRow(c.id)).status).toBe('replied');
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('a classifier that throws gives needs_review (fallback) instead of stopping the run', async () => {
    const c = await contact('first_sent');
    await inbox(c.key('first'), TEXT.interested);
    const failing: Classifier = async () => {
      throw new Error('AI down');
    };
    expect(await tick(failing)).toEqual({ processed: 1, rule: 0, ai: 0, fallback: 1 });
    expect(await replyRow(c.id)).toMatchObject({ label: 'needs_review', label_source: 'fallback' });
  });

  it('a classifier that resolves to something other than a Map gives needs_review (fallback)', async () => {
    const c = await contact('first_sent');
    await inbox(c.key('first'), TEXT.interested);
    const broken = (async () => undefined) as unknown as Classifier;
    expect(await tick(broken)).toEqual({ processed: 1, rule: 0, ai: 0, fallback: 1 });
    expect(await replyRow(c.id)).toMatchObject({ label: 'needs_review', label_source: 'fallback' });
  });

  it('a missing answer or an unknown label gives needs_review (fallback)', async () => {
    const a = await contact('first_sent');
    const b = await contact('first_sent');
    await inbox(a.key('first'), TEXT.interested);
    await inbox(b.key('first'), TEXT.notInterested);
    const odd: Classifier = async (items) => new Map([[items[0]!.id, 'maybe' as Label]]);
    expect(await tick(odd)).toEqual({ processed: 2, rule: 0, ai: 0, fallback: 2 });
    expect((await replyRow(a.id)).label).toBe('needs_review');
    expect((await replyRow(b.id)).label).toBe('needs_review');
  });
});

describe('processReplies: unsubscribe', () => {
  it('an unsubscribe (by rule) closes the contact and adds a suppression row', async () => {
    const c = await contact('follow_up_1_sent');
    await inbox(c.key('follow_up_1'), TEXT.unsubscribe, { trueLabel: 'unsubscribe' });
    const ai = fakeAi();
    expect(await tick(ai.classify)).toEqual({ processed: 1, rule: 1, ai: 0, fallback: 0 });
    expect(ai.calls).toEqual([]);
    expect(await contactRow(c.id)).toEqual({
      status: 'unsubscribed',
      next_action: null,
      next_action_at: null,
      updated_at: NOW,
    });
    expect(await q('SELECT email, reason, added_at FROM suppression')).toEqual([
      { email: c.email, reason: 'unsubscribed', added_at: NOW },
    ]);
    expect((await newEvents(c.id)).map((e) => e.data)).toEqual([
      expect.objectContaining({ label: 'unsubscribe', label_source: 'rule' }),
      { from: 'follow_up_1_sent', to: 'unsubscribed', reason: 'unsubscribe' },
    ]);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('a late unsubscribe after a later email bounced → unsubscribed; the bounced suppression row stays', async () => {
    const c = await contact('bounced', { bouncedAt: 'follow_up_1' });
    await inbox(c.key('first'), TEXT.unsubscribe, { trueLabel: 'unsubscribe' });
    await tick(fakeAi().classify);
    expect((await contactRow(c.id)).status).toBe('unsubscribed');
    expect(await q('SELECT reason FROM suppression')).toEqual([{ reason: 'bounced' }]);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('a replied contact that later unsubscribes → unsubscribed', async () => {
    const c = await contact('replied');
    await inbox(c.key('first'), TEXT.unsubscribe, { trueLabel: 'unsubscribe' });
    await tick(fakeAi().classify);
    expect((await contactRow(c.id)).status).toBe('unsubscribed');
    expect(await checkInvariants(pool)).toEqual([]);
  });
});

describe('processReplies: out of office', () => {
  it('a dated out-of-office keeps the status and moves the next email to the day after the return date', async () => {
    const c = await contact('first_sent', { due: at(DAY_MS) });
    await inbox(c.key('first'), TEXT.oooDated, { headers: AUTO, trueLabel: 'out_of_office' });
    expect(await tick(fakeAi().classify)).toEqual({ processed: 1, rule: 1, ai: 0, fallback: 0 });

    const moved = new Date('2026-11-21T00:00:00Z');
    expect(await contactRow(c.id)).toEqual({
      status: 'first_sent',
      next_action: 'follow_up_1',
      next_action_at: moved,
      updated_at: NOW,
    });
    expect(await replyRow(c.id)).toMatchObject({ label: 'out_of_office', label_source: 'rule' });
    expect(
      await one(`SELECT to_char(return_date, 'YYYY-MM-DD') AS d FROM replies WHERE contact_id = $1`, [c.id]),
    ).toEqual({ d: '2026-11-20' });
    expect((await newEvents(c.id)).map((e) => [e.type, e.data])).toEqual([
      ['reply_received', expect.objectContaining({ label: 'out_of_office', label_source: 'rule' })],
      ['rescheduled', { from: at(DAY_MS).toISOString(), to: moved.toISOString(), cause: 'ooo' }],
    ]);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('an out-of-office with no return date waits OOO_DEFAULT_DAYS from now', async () => {
    const c = await contact('first_sent', { due: at(DAY_MS) });
    await inbox(c.key('first'), TEXT.oooUndated, { headers: AUTO, trueLabel: 'out_of_office' });
    await tick(fakeAi().classify);
    expect((await contactRow(c.id)).next_action_at).toEqual(at(7 * DAY_MS));
    expect((await replyRow(c.id)).return_date).toBeNull();
  });

  it('the return date is read from when the reply arrived, not from today', async () => {
    const c = await contact('first_sent', { due: at(DAY_MS) });
    // Arrived Wednesday 28 Oct: "returning Friday" means Friday 30 Oct, which has already passed.
    await inbox(c.key('first'), TEXT.oooFriday, {
      headers: AUTO,
      trueLabel: 'out_of_office',
      deliverAt: new Date('2026-10-28T10:00:00Z'),
    });
    await tick(fakeAi().classify);
    expect(
      await one(`SELECT to_char(return_date, 'YYYY-MM-DD') AS d FROM replies WHERE contact_id = $1`, [c.id]),
    ).toEqual({ d: '2026-10-30' });
    expect((await contactRow(c.id)).next_action_at).toEqual(at(7 * DAY_MS));
  });

  it('an out-of-office labelled by the AI also gets its return date from the text', async () => {
    const c = await contact('first_sent', { due: at(DAY_MS) });
    await inbox(c.key('first'), TEXT.aiOoo, { trueLabel: 'out_of_office' });
    expect(await tick(fakeAi().classify)).toEqual({ processed: 1, rule: 0, ai: 1, fallback: 0 });
    expect(await replyRow(c.id)).toMatchObject({ label: 'out_of_office', label_source: 'ai' });
    expect((await contactRow(c.id)).next_action_at).toEqual(new Date('2026-11-21T00:00:00Z'));
  });

  it('never moves the next email earlier; no rescheduled event when the date does not move', async () => {
    const due = new Date('2026-12-01T09:00:00Z');
    const c = await contact('first_sent', { due });
    await inbox(c.key('first'), TEXT.oooDated, { headers: AUTO, trueLabel: 'out_of_office' });
    await tick(fakeAi().classify);
    expect(await contactRow(c.id)).toMatchObject({ status: 'first_sent', next_action_at: due });
    expect((await newEvents(c.id)).map((e) => e.type)).toEqual(['reply_received']);
  });

  it('for follow_up_3_sent it pushes back deactivation', async () => {
    const c = await contact('follow_up_3_sent', { due: at(DAY_MS) });
    await inbox(c.key('follow_up_3'), TEXT.oooDated, { headers: AUTO, trueLabel: 'out_of_office' });
    await tick(fakeAi().classify);
    expect(await contactRow(c.id)).toMatchObject({
      status: 'follow_up_3_sent',
      next_action: 'deactivate',
      next_action_at: new Date('2026-11-21T00:00:00Z'),
    });
  });

  it('a reply processed at the same tick as a due follow-up stops that follow-up', async () => {
    const c = await contact('first_sent', { due: NOW });
    await inbox(c.key('first'), TEXT.interested);
    await tick(fakeAi().classify);
    const cfg = loadConfig({ DATABASE_URL: url, BOUNCE_RATE: '0', REPLY_RATE: '0' });
    const providerPool = new pg.Pool({ connectionString: url });
    try {
      const summary = await sendDue(pool, NOW, { provider: createProvider(providerPool, cfg), config: cfg });
      expect(summary.sent).toBe(0);
    } finally {
      await providerPool.end();
    }
    expect(await count(`SELECT count(*) FROM sends WHERE contact_id = $1 AND step = 'follow_up_1'`, [c.id])).toBe(0);
  });
});

describe('processReplies: contacts that have finished', () => {
  it('a late interested reply from a deactivated contact → replied (D44)', async () => {
    const c = await contact('deactivated');
    await inbox(c.key('follow_up_3'), TEXT.interested);
    await tick(fakeAi().classify);
    expect((await contactRow(c.id)).status).toBe('replied');
    expect((await newEvents(c.id)).map((e) => e.data)).toContainEqual({
      from: 'deactivated',
      to: 'replied',
      reason: 'reply',
    });
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('a late out-of-office from a deactivated contact is recorded and changes nothing', async () => {
    const c = await contact('deactivated');
    await inbox(c.key('follow_up_3'), TEXT.oooDated, { headers: AUTO, trueLabel: 'out_of_office' });
    await tick(fakeAi().classify);
    expect(await contactRow(c.id)).toEqual({
      status: 'deactivated',
      next_action: null,
      next_action_at: null,
      updated_at: at(-60 * DAY_MS),
    });
    expect((await replyRow(c.id)).label).toBe('out_of_office');
    expect((await newEvents(c.id)).map((e) => e.type)).toEqual(['reply_received']);
  });

  it('a late unsubscribe from a deactivated contact → unsubscribed + suppression', async () => {
    const c = await contact('deactivated');
    await inbox(c.key('follow_up_3'), TEXT.unsubscribe, { trueLabel: 'unsubscribe' });
    await tick(fakeAi().classify);
    expect((await contactRow(c.id)).status).toBe('unsubscribed');
    expect(await count('SELECT count(*) FROM suppression WHERE email = $1', [c.email])).toBe(1);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('a second reply from an already replied contact is recorded and changes nothing', async () => {
    const c = await contact('replied');
    await inbox(c.key('first'), TEXT.notInterested);
    await tick(fakeAi().classify);
    expect((await contactRow(c.id)).status).toBe('replied');
    expect((await replyRow(c.id)).label).toBe('not_interested');
    expect((await newEvents(c.id)).map((e) => e.type)).toEqual(['reply_received']);
  });
});

describe('processReplies: order, batches and repeats', () => {
  it('out-of-office then interested from the same contact in one tick → replied', async () => {
    const c = await contact('follow_up_1_sent', { due: at(DAY_MS) });
    await inbox(c.key('first'), TEXT.oooDated, { headers: AUTO, deliverAt: at(-3 * HOUR_MS) });
    await inbox(c.key('follow_up_1'), TEXT.interested, { deliverAt: at(-1 * HOUR_MS) });
    await tick(fakeAi().classify);
    expect((await contactRow(c.id)).status).toBe('replied');
    expect((await newEvents(c.id)).map((e) => e.type)).toEqual([
      'reply_received',
      'rescheduled',
      'reply_received',
      'status_changed',
    ]);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('interested then out-of-office from the same contact in one tick → replied, nothing rescheduled', async () => {
    const c = await contact('follow_up_1_sent', { due: at(DAY_MS) });
    await inbox(c.key('first'), TEXT.interested, { deliverAt: at(-3 * HOUR_MS) });
    await inbox(c.key('follow_up_1'), TEXT.oooDated, { headers: AUTO, deliverAt: at(-1 * HOUR_MS) });
    await tick(fakeAi().classify);
    expect(await contactRow(c.id)).toMatchObject({ status: 'replied', next_action_at: null });
    expect((await newEvents(c.id)).map((e) => e.type)).toEqual(['reply_received', 'status_changed', 'reply_received']);
  });

  it(`works in batches of ${REPLY_BATCH_SIZE}: 60 replies, every AI call at most ${REPLY_BATCH_SIZE}`, async () => {
    expect(REPLY_BATCH_SIZE).toBe(25);
    for (let i = 0; i < 60; i += 1) {
      const c = await contact('first_sent');
      await inbox(c.key('first'), i % 3 === 0 ? TEXT.unsubscribe : TEXT.interested);
    }
    const ai = fakeAi();
    expect(await tick(ai.classify)).toEqual({ processed: 60, rule: 20, ai: 40, fallback: 0 });
    expect(ai.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of ai.calls) expect(call.length).toBeLessThanOrEqual(REPLY_BATCH_SIZE);
    expect(ai.calls.flat()).toHaveLength(40);
    expect(await count('SELECT count(*) FROM replies WHERE label IS NULL')).toBe(0);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('a second run processes nothing', async () => {
    const c = await contact('first_sent');
    await inbox(c.key('first'), TEXT.interested);
    await tick(fakeAi().classify);
    const before = await q('SELECT * FROM events ORDER BY id');
    expect(await processReplies(pool, NOW, deps(fakeAi().classify))).toEqual({
      processed: 0,
      rule: 0,
      ai: 0,
      fallback: 0,
    });
    expect(await q('SELECT * FROM events ORDER BY id')).toEqual(before);
  });

  it('replies already labelled (the seed) are left alone', async () => {
    const c = await contact('replied');
    const sendId = (await one('SELECT id FROM sends WHERE contact_id = $1', [c.id])).id;
    await pool.query(
      `INSERT INTO replies (contact_id, send_id, body, received_at, true_label, label, label_source, classified_at)
       VALUES ($1, $2, 'Yes please', $3, 'interested', 'interested', 'ai', $3)`,
      [c.id, sendId, at(-3 * DAY_MS)],
    );
    const ai = fakeAi();
    expect(await processReplies(pool, NOW, deps(ai.classify))).toEqual({ processed: 0, rule: 0, ai: 0, fallback: 0 });
    expect(ai.calls).toEqual([]);
  });
});
