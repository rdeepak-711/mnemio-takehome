import type pg from 'pg';
import { getNow } from './clock';
import { IN_SEQUENCE, STATUSES, STEPS, type Status } from './lifecycle';

export type Count = { count: number; of: number }; // a rate: count ÷ of
export type Accuracy = { labelled: number; correct: number };
export type Report = {
  now: Date;
  statuses: Record<Status, number>; // all 9 keys, 0 when none
  inSequence: number;
  sentToday: number;
  dueToday: number;
  dueTomorrow: number;
  replyRate: Count;
  bounceRate: Count;
  templateSources: { ai: number; cache: number; fallback: number };
  classifier: { rule: Accuracy; ai: Accuracy; fallback: number };
  needsReview: number;
  unlabelled: number;
  orphaned: number;
  aiCalls: { today: number; budget: number };
};

const DAY_MS = 24 * 60 * 60 * 1000;

// One row of numbers. $1 = today's start (simulated UTC day), $2 = tomorrow's start, $3 = the day after,
// $4 = simStart, $5 = now, $6 = the in-sequence statuses, $7 = the send steps. Read-only.
const SQL = `
  SELECT
    (SELECT count(*) FROM sends WHERE sent_at >= $1 AND sent_at < $2)::int AS sent_today,
    (SELECT count(*) FROM contacts WHERE status = ANY($6) AND next_action = ANY($7)
        AND next_action_at < $2)::int AS due_today,
    (SELECT count(*) FROM contacts WHERE status = ANY($6) AND next_action = ANY($7)
        AND next_action_at >= $2 AND next_action_at < $3)::int AS due_tomorrow,
    (SELECT count(DISTINCT contact_id) FROM replies)::int AS replied,
    (SELECT count(DISTINCT contact_id) FROM sends WHERE outcome = 'accepted')::int AS accepted,
    (SELECT count(*) FROM sends WHERE outcome = 'bounced')::int AS bounced,
    (SELECT count(*) FROM sends)::int AS sends,
    (SELECT count(*) FROM sends WHERE sent_at >= $4 AND template_source = 'ai')::int AS src_ai,
    (SELECT count(*) FROM sends WHERE sent_at >= $4 AND template_source = 'cache')::int AS src_cache,
    (SELECT count(*) FROM sends WHERE sent_at >= $4 AND template_source = 'fallback')::int AS src_fallback,
    (SELECT count(*) FROM replies WHERE classified_at >= $4 AND label_source = 'rule')::int AS rule_labelled,
    (SELECT count(*) FROM replies WHERE classified_at >= $4 AND label_source = 'rule'
        AND label = true_label)::int AS rule_correct,
    (SELECT count(*) FROM replies WHERE classified_at >= $4 AND label_source = 'ai')::int AS ai_labelled,
    (SELECT count(*) FROM replies WHERE classified_at >= $4 AND label_source = 'ai'
        AND label = true_label)::int AS ai_correct,
    (SELECT count(*) FROM replies WHERE classified_at >= $4 AND label_source = 'fallback')::int AS fallback,
    (SELECT count(*) FROM replies WHERE classified_at >= $4 AND label = 'needs_review')::int AS needs_review,
    (SELECT count(*) FROM replies WHERE label IS NULL)::int AS unlabelled,
    (SELECT count(*) FROM mock_inbox m WHERE NOT m.delivered AND m.deliver_at <= $5
        AND NOT EXISTS (SELECT 1 FROM sends s WHERE s.idempotency_key = m.idempotency_key))::int AS orphaned,
    -- A real day, as in src/ai/limiter.ts: OpenRouter counts real days.
    COALESCE((SELECT calls FROM ai.llm_usage WHERE day = (now() AT TIME ZONE 'UTC')::date), 0)::int AS ai_calls`;

type Row = Record<
  | 'sent_today'
  | 'due_today'
  | 'due_tomorrow'
  | 'replied'
  | 'accepted'
  | 'bounced'
  | 'sends'
  | 'src_ai'
  | 'src_cache'
  | 'src_fallback'
  | 'rule_labelled'
  | 'rule_correct'
  | 'ai_labelled'
  | 'ai_correct'
  | 'fallback'
  | 'needs_review'
  | 'unlabelled'
  | 'orphaned'
  | 'ai_calls',
  number
>;

export async function report(pool: pg.Pool, opts: { simStart: Date; dailyAiBudget: number }): Promise<Report> {
  const now = await getNow(pool);
  // "Today" is the simulated UTC calendar day of now; no real clock is read.
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrow = new Date(dayStart.getTime() + DAY_MS);
  const dayAfter = new Date(dayStart.getTime() + 2 * DAY_MS);

  const statuses = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  const byStatus = await pool.query<{ status: Status; n: number }>(
    'SELECT status, count(*)::int AS n FROM contacts GROUP BY status',
  );
  for (const { status, n } of byStatus.rows) statuses[status] = n;

  const { rows } = await pool.query<Row>(SQL, [dayStart, tomorrow, dayAfter, opts.simStart, now, IN_SEQUENCE, STEPS]);
  const r = rows[0];
  if (!r) throw new Error('report query returned no row');

  return {
    now,
    statuses,
    inSequence: IN_SEQUENCE.reduce((sum, s) => sum + statuses[s], 0),
    sentToday: r.sent_today,
    dueToday: r.due_today,
    dueTomorrow: r.due_tomorrow,
    replyRate: { count: r.replied, of: r.accepted },
    bounceRate: { count: r.bounced, of: r.sends },
    templateSources: { ai: r.src_ai, cache: r.src_cache, fallback: r.src_fallback },
    classifier: {
      rule: { labelled: r.rule_labelled, correct: r.rule_correct },
      ai: { labelled: r.ai_labelled, correct: r.ai_correct },
      fallback: r.fallback,
    },
    needsReview: r.needs_review,
    unlabelled: r.unlabelled,
    orphaned: r.orphaned,
    aiCalls: { today: r.ai_calls, budget: opts.dailyAiBudget },
  };
}

// One decimal place; n/a when there is nothing to divide by.
function pct(count: number, of: number): string {
  return of === 0 ? 'n/a' : `${((count / of) * 100).toFixed(1)}%`;
}

function accuracy(name: string, a: Accuracy): string {
  return `${name} ${a.correct} of ${a.labelled} correct (${pct(a.correct, a.labelled)})`;
}

export function formatReport(r: Report): string {
  const total = STATUSES.reduce((sum, s) => sum + r.statuses[s], 0);
  const t = r.templateSources;
  const c = r.classifier;
  return [
    `Report for ${r.now.toISOString().slice(0, 10)} (simulated)`,
    `Contacts: ${total} · ${STATUSES.map((s) => `${s} ${r.statuses[s]}`).join(' · ')}`,
    `In sequence: ${r.inSequence} · sent today: ${r.sentToday} · due today: ${r.dueToday} · due tomorrow: ${r.dueTomorrow}`,
    `Reply rate: ${pct(r.replyRate.count, r.replyRate.of)} (${r.replyRate.count} of ${r.replyRate.of} contacts with an accepted send)`,
    `Bounce rate: ${pct(r.bounceRate.count, r.bounceRate.of)} (${r.bounceRate.count} of ${r.bounceRate.of} sends)`,
    `Emails since start by template: ai ${t.ai} · cache ${t.cache} · fallback ${t.fallback}`,
    `Classifier since start, against the mock's true label: ${accuracy('rule', c.rule)} · ${accuracy('ai', c.ai)} · fallback ${c.fallback}`,
    `Needs review: ${r.needsReview} · unlabelled: ${r.unlabelled} · orphaned mock replies: ${r.orphaned}`,
    `AI calls today: ${r.aiCalls.today}/${r.aiCalls.budget}`,
  ].join('\n');
}
