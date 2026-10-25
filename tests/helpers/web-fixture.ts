import type pg from 'pg';
import { setNow } from '../../src/clock';

// The fixed dataset behind the dashboard read tests (T21a). Every expected number in tests/db/web-*.test.ts is worked
// out by hand from the table below. SIM_START is 2026-11-02T09:00Z, the clock is 2026-11-04T09:00Z, so 30 Oct to
// 1 Nov are seeded history and 2 to 4 Nov are simulated.
//
//  contact  created       status changes (UTC)                                   sends (UTC)
//  A        30 Oct 10:00  new→first_sent 31 Oct 23:59:59                         first 31 Oct 23:59:59
//  B        30 Oct 10:00  new→first_sent 1 Nov 08:00, →replied 3 Nov 12:00      first 1 Nov 08:00; reply 3 Nov 12:00
//  C        31 Oct 00:00  new→bounced 2 Nov 10:00                                first 2 Nov 10:00 (bounced)
//  D        1 Nov 00:00   none (still new)                                       none
//  E        3 Nov 05:00   new→first_sent 3 Nov 06:00, →follow_up_1_sent 4 Nov 07:00   first 3 Nov 06:00, follow_up_1 4 Nov 07:00
//  F        30 Oct 09:00  new→first_sent 30 Oct 12:00, →unsubscribed 2 Nov 00:00:00   first 30 Oct 12:00; reply 2 Nov 00:00
//  G        30 Oct 09:00  new→first_sent 30 Oct 13:00, →fu1 31 Oct 13:00, →fu2 1 Nov 13:00, →fu3 2 Nov 13:00,
//                         →deactivated 4 Nov 08:00                               first, fu1, fu2, fu3 at those times

export const FIXTURE_SIM_START = new Date('2026-11-02T09:00:00Z');
export const FIXTURE_NOW = new Date('2026-11-04T09:00:00Z');

export type FixtureIds = Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', number>;

type Spec = {
  key: keyof FixtureIds;
  created: string;
  status: string;
  next: [string, string] | null;
  moves: [string, string, string][]; // from, to, at
  sends: [string, string, string][]; // step, outcome, at
  replies: [string, string][]; // at, true label (each to the contact's last send)
};

const SPECS: Spec[] = [
  {
    key: 'A',
    created: '2026-10-30T10:00:00Z',
    status: 'first_sent',
    next: ['follow_up_1', '2026-11-07T09:00:00Z'],
    moves: [['new', 'first_sent', '2026-10-31T23:59:59Z']],
    sends: [['first', 'accepted', '2026-10-31T23:59:59Z']],
    replies: [],
  },
  {
    key: 'B',
    created: '2026-10-30T10:00:00Z',
    status: 'replied',
    next: null,
    moves: [
      ['new', 'first_sent', '2026-11-01T08:00:00Z'],
      ['first_sent', 'replied', '2026-11-03T12:00:00Z'],
    ],
    sends: [['first', 'accepted', '2026-11-01T08:00:00Z']],
    replies: [['2026-11-03T12:00:00Z', 'interested']],
  },
  {
    key: 'C',
    created: '2026-10-31T00:00:00Z',
    status: 'bounced',
    next: null,
    moves: [['new', 'bounced', '2026-11-02T10:00:00Z']],
    sends: [['first', 'bounced', '2026-11-02T10:00:00Z']],
    replies: [],
  },
  {
    key: 'D',
    created: '2026-11-01T00:00:00Z',
    status: 'new',
    next: ['first', '2026-11-05T09:00:00Z'],
    moves: [],
    sends: [],
    replies: [],
  },
  {
    key: 'E',
    created: '2026-11-03T05:00:00Z',
    status: 'follow_up_1_sent',
    next: ['follow_up_2', '2026-11-08T09:00:00Z'],
    moves: [
      ['new', 'first_sent', '2026-11-03T06:00:00Z'],
      ['first_sent', 'follow_up_1_sent', '2026-11-04T07:00:00Z'],
    ],
    sends: [
      ['first', 'accepted', '2026-11-03T06:00:00Z'],
      ['follow_up_1', 'accepted', '2026-11-04T07:00:00Z'],
    ],
    replies: [],
  },
  {
    key: 'F',
    created: '2026-10-30T09:00:00Z',
    status: 'unsubscribed',
    next: null,
    moves: [
      ['new', 'first_sent', '2026-10-30T12:00:00Z'],
      ['first_sent', 'unsubscribed', '2026-11-02T00:00:00Z'],
    ],
    sends: [['first', 'accepted', '2026-10-30T12:00:00Z']],
    replies: [['2026-11-02T00:00:00Z', 'unsubscribe']],
  },
  {
    key: 'G',
    created: '2026-10-30T09:00:00Z',
    status: 'deactivated',
    next: null,
    moves: [
      ['new', 'first_sent', '2026-10-30T13:00:00Z'],
      ['first_sent', 'follow_up_1_sent', '2026-10-31T13:00:00Z'],
      ['follow_up_1_sent', 'follow_up_2_sent', '2026-11-01T13:00:00Z'],
      ['follow_up_2_sent', 'follow_up_3_sent', '2026-11-02T13:00:00Z'],
      ['follow_up_3_sent', 'deactivated', '2026-11-04T08:00:00Z'],
    ],
    sends: [
      ['first', 'accepted', '2026-10-30T13:00:00Z'],
      ['follow_up_1', 'accepted', '2026-10-31T13:00:00Z'],
      ['follow_up_2', 'accepted', '2026-11-01T13:00:00Z'],
      ['follow_up_3', 'accepted', '2026-11-02T13:00:00Z'],
    ],
    replies: [],
  },
];

// Inserts the dataset into an empty, migrated database and sets the clock. Also writes `sent` and `reply_received`
// events, which the dashboard must ignore when it rebuilds statuses.
export async function loadWebFixture(pool: pg.Pool): Promise<FixtureIds> {
  await setNow(pool, FIXTURE_NOW);
  const ids = {} as FixtureIds;
  for (const s of SPECS) {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
         status, next_action, next_action_at, created_at, updated_at)
       VALUES ($1, 'Fixture', $2, $3, 'saas', 'CTO', 'tech', 'UTC', 'tech:saas', $4, $5, $6, $7, $7) RETURNING id`,
      [
        s.key,
        `${s.key.toLowerCase()}@fixture.example`,
        `Company ${s.key}`,
        s.status,
        s.next?.[0] ?? null,
        s.next?.[1] ?? null,
        s.created,
      ],
    );
    const id = rows[0]!.id;
    ids[s.key] = id;
    let lastSend = 0;
    for (const [step, outcome, at] of s.sends) {
      const sent = await pool.query<{ id: number }>(
        `INSERT INTO sends (contact_id, step, idempotency_key, outcome, subject, body, template_source, sent_at)
         VALUES ($1, $2, $1::int::text || ':' || $2, $3, 'Subject ' || $2, 'Body', 'fallback', $4) RETURNING id`,
        [id, step, outcome, at],
      );
      lastSend = sent.rows[0]!.id;
      await pool.query(`INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, 'sent', $2, $3)`, [
        id,
        JSON.stringify({ step, outcome }),
        at,
      ]);
    }
    for (const [at, trueLabel] of s.replies) {
      await pool.query(
        `INSERT INTO replies (contact_id, send_id, body, received_at, true_label, label, label_source, classified_at)
         VALUES ($1, $2, 'Reply text', $3, $4, $4, 'rule', $3)`,
        [id, lastSend, at, trueLabel],
      );
      await pool.query(
        `INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, 'reply_received', '{}', $2)`,
        [id, at],
      );
    }
    for (const [from, to, at] of s.moves) {
      await pool.query(
        `INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, 'status_changed', $2, $3)`,
        [id, JSON.stringify({ from, to, reason: 'fixture' }), at],
      );
    }
  }
  return ids;
}
