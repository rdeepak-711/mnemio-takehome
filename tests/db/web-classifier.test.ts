import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { setNow } from '../../src/clock';
import { report } from '../../src/report';
import { classifierStats } from '../../src/web/classifier';

const pool = getPool(process.env.TEST_DATABASE_URL!);
const SIM_START = new Date('2026-11-02T09:00:00Z');
const ids: Record<string, number> = {};

// One contact with one send; every reply hangs off it. Labels, sources and times are the whole point of this file.
async function setup() {
  await setNow(pool, new Date('2026-11-06T09:00:00Z'));
  const c = await pool.query<{ id: number }>(
    `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
       status, next_action, next_action_at, created_at, updated_at)
     VALUES ('Ann', 'Lee', 'ann@acme.example', 'Acme', 'saas', 'CTO', 'tech', 'UTC', 'tech:saas',
       'replied', NULL, NULL, '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z') RETURNING id`,
  );
  const contactId = c.rows[0]!.id;
  const s = await pool.query<{ id: number }>(
    `INSERT INTO sends (contact_id, step, idempotency_key, outcome, subject, body, template_source, sent_at)
     VALUES ($1, 'first', $1::int::text || ':first', 'accepted', 's', 'b', 'fallback', '2026-10-02T09:00:00Z')
     RETURNING id`,
    [contactId],
  );
  const sendId = s.rows[0]!.id;
  // name, body, true label, predicted label, source, classified at (null = not labelled yet)
  const rows: [string, string, string, string | null, string | null, string | null][] = [
    ['seed1', 'Seeded yes', 'interested', 'interested', 'ai', '2026-10-20T10:00:00Z'],
    ['seed2', 'Seeded stop', 'unsubscribe', 'unsubscribe', 'rule', '2026-11-02T08:59:59Z'],
    ['r1', 'Please remove me', 'unsubscribe', 'unsubscribe', 'rule', '2026-11-02T09:00:00Z'],
    ['r2', 'I am away until Monday', 'out_of_office', 'out_of_office', 'rule', '2026-11-02T10:00:00Z'],
    ['r3', 'Out of office? No, I am interested', 'interested', 'out_of_office', 'rule', '2026-11-03T10:00:00Z'],
    ['r4', 'Sounds good, call me', 'interested', 'interested', 'ai', '2026-11-03T11:00:00Z'],
    ['r5', 'Not for us right now', 'not_interested', 'interested', 'ai', '2026-11-04T10:00:00Z'],
    ['r6', 'No thanks', 'not_interested', 'not_interested', 'ai', '2026-11-04T11:00:00Z'],
    ['r7', 'Maybe, tell me more?', 'interested', 'needs_review', 'ai', '2026-11-05T10:00:00Z'],
    ['r8', 'We already use something', 'not_interested', 'needs_review', 'fallback', '2026-11-05T11:00:00Z'],
    ['r9', 'Not labelled yet', 'interested', null, null, null],
  ];
  for (const [name, body, trueLabel, label, source, at] of rows) {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO replies (contact_id, send_id, body, received_at, true_label, label, label_source, classified_at)
       VALUES ($1, $2, $3, '2026-10-15T09:00:00Z', $4, $5, $6, $7) RETURNING id`,
      [contactId, sendId, body, trueLabel, label, source, at],
    );
    ids[name] = r.rows[0]!.id;
  }
}

beforeAll(async () => {
  await resetDb(pool);
  await setup();
});

afterAll(async () => {
  await resetDb(pool);
  await closePool();
});

describe('classifierStats (D60)', () => {
  it('counts only labels written at or after SIM_START, and says how many seeded ones were left out', async () => {
    const s = await classifierStats(pool, SIM_START);
    expect(s.simStart).toBe('2026-11-02');
    expect(s.total).toBe(8);
    expect(s.excludedSeeded).toBe(2);
    expect(s.unlabelled).toBe(1);
  });

  it('counts per predicted label and per source', async () => {
    const s = await classifierStats(pool, SIM_START);
    expect(s.byLabel).toEqual({ interested: 2, not_interested: 1, out_of_office: 2, unsubscribe: 1, needs_review: 2 });
    expect(s.bySource).toEqual({ rule: 3, ai: 4, fallback: 1 });
  });

  it('scores rules and AI against the mock true label, like the report', async () => {
    const s = await classifierStats(pool, SIM_START);
    expect(s.accuracy).toEqual({ rule: { labelled: 3, correct: 2 }, ai: { labelled: 4, correct: 2 } });
    const r = await report(pool, { simStart: SIM_START, dailyAiBudget: 45 });
    expect(s.accuracy).toEqual({ rule: r.classifier.rule, ai: r.classifier.ai });
    expect(s.byLabel.needs_review).toBe(r.needsReview);
  });

  it('has a true-label × predicted-label table in label order, non-zero cells only', async () => {
    const s = await classifierStats(pool, SIM_START);
    expect(s.confusion).toEqual([
      { trueLabel: 'interested', label: 'interested', count: 1 },
      { trueLabel: 'interested', label: 'out_of_office', count: 1 },
      { trueLabel: 'interested', label: 'needs_review', count: 1 },
      { trueLabel: 'not_interested', label: 'interested', count: 1 },
      { trueLabel: 'not_interested', label: 'not_interested', count: 1 },
      { trueLabel: 'not_interested', label: 'needs_review', count: 1 },
      { trueLabel: 'out_of_office', label: 'out_of_office', count: 1 },
      { trueLabel: 'unsubscribe', label: 'unsubscribe', count: 1 },
    ]);
  });

  it('gives up to 3 examples per predicted label, newest classification first', async () => {
    const s = await classifierStats(pool, SIM_START);
    expect(Object.keys(s.examples)).toEqual([
      'interested',
      'not_interested',
      'out_of_office',
      'unsubscribe',
      'needs_review',
    ]);
    expect(s.examples.interested.map((e) => e.id)).toEqual([ids.r5, ids.r4]);
    expect(s.examples.out_of_office.map((e) => e.id)).toEqual([ids.r3, ids.r2]);
    expect(s.examples.unsubscribe.map((e) => e.id)).toEqual([ids.r1]);
    expect(s.examples.needs_review[0]).toEqual({
      id: ids.r8,
      contactId: expect.any(Number),
      body: 'We already use something',
      label: 'needs_review',
      labelSource: 'fallback',
      trueLabel: 'not_interested',
      receivedAt: new Date('2026-10-15T09:00:00Z'),
      classifiedAt: new Date('2026-11-05T11:00:00Z'),
    });
  });

  it('caps examples at 3', async () => {
    await pool.query(
      `INSERT INTO replies (contact_id, send_id, body, received_at, true_label, label, label_source, classified_at)
       SELECT contact_id, send_id, 'extra ' || n, received_at, 'interested', 'interested', 'ai',
              ('2026-11-06T0' || n || ':00:00Z')::timestamptz
         FROM replies, generate_series(1, 3) AS n WHERE id = $1`,
      [ids.r4],
    );
    const s = await classifierStats(pool, SIM_START);
    expect(s.examples.interested.map((e) => e.body)).toEqual(['extra 3', 'extra 2', 'extra 1']);
    expect(s.byLabel.interested).toBe(5);
  });
});

describe('classifierStats with no replies', () => {
  beforeAll(async () => {
    await resetDb(pool);
    await setNow(pool, new Date('2026-11-06T09:00:00Z'));
  });

  it('is all zeros with empty example lists', async () => {
    const s = await classifierStats(pool, SIM_START);
    expect(s.total).toBe(0);
    expect(s.byLabel).toEqual({ interested: 0, not_interested: 0, out_of_office: 0, unsubscribe: 0, needs_review: 0 });
    expect(s.bySource).toEqual({ rule: 0, ai: 0, fallback: 0 });
    expect(s.accuracy).toEqual({ rule: { labelled: 0, correct: 0 }, ai: { labelled: 0, correct: 0 } });
    expect(s.confusion).toEqual([]);
    expect(s.examples.interested).toEqual([]);
  });
});
