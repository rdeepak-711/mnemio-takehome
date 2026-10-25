import type pg from 'pg';
import type { Config } from '../config';
import type { Provider } from '../mock/provider';
import type { AiClient } from '../ai/client';
import { createClassifier } from '../ai/classify';
import { createSequenceWriter } from '../ai/sequences';
import { advance, advanceHours, getNow } from '../clock';
import { deactivateDue } from './deactivate';
import { deliverReplies, processReplies, type ProcessSummary } from './replies';
import { sendDue, type SendSummary } from './send';

export const MAX_ADVANCE_DAYS = 365;
export type TickDeps = { pool: pg.Pool; provider: Provider; config: Config; ai?: AiClient | null | undefined };
export type TickSummary = {
  now: Date;
  delivered: number;
  labelled: ProcessSummary;
  deactivated: number;
  sent: SendSummary;
};

// Replies first, so a contact who answered today is out of the sequence before the send step claims it.
export async function runTick(deps: TickDeps): Promise<TickSummary> {
  const { pool, provider, config, ai } = deps;
  const now = await getNow(pool);
  // A new writer per tick, so a segment whose AI answer failed today is asked again tomorrow (D51, D53).
  const writer = ai ? createSequenceWriter(ai) : null;
  const classify = ai ? createClassifier(pool, ai) : undefined;

  const { delivered } = await deliverReplies(pool, now);
  const labelled = await processReplies(pool, now, { config, classify });
  const { deactivated } = await deactivateDue(pool, now);
  const sent = await sendDue(
    pool,
    now,
    writer ? { provider, config, getTemplate: writer.getTemplate } : { provider, config },
  );
  return { now, delivered, labelled, deactivated, sent };
}

export async function advanceDays(
  deps: TickDeps,
  days: number,
  // unknown, not void | Promise<void>: a void union rejects callbacks like `(s) => seen.push(s.now)`.
  onDay?: (summary: TickSummary) => unknown,
): Promise<TickSummary[]> {
  // Checked before any query, so a bad value never moves the clock.
  if (!Number.isInteger(days) || days < 1 || days > MAX_ADVANCE_DAYS) {
    throw new Error(`days: expected an integer from 1 to ${MAX_ADVANCE_DAYS}, got ${days}`);
  }
  const summaries: TickSummary[] = [];
  for (let i = 0; i < days; i++) {
    const summary = deps.config.delivery ? await hourlyDay(deps) : await dailyTick(deps);
    await onDay?.(summary); // finished before the next day's advance
    summaries.push(summary);
  }
  return summaries;
}

async function dailyTick(deps: TickDeps): Promise<TickSummary> {
  await advance(deps.pool, 1);
  return runTick(deps);
}

// With deliverability on, a day is 24 hourly ticks, so the clock passes through every local send window (D65).
// The day's summary is the 24 summed, with now = the last tick's.
async function hourlyDay(deps: TickDeps): Promise<TickSummary> {
  let day: TickSummary | null = null;
  for (let hour = 0; hour < 24; hour++) {
    await advanceHours(deps.pool, 1);
    const tick = await runTick(deps);
    day = day ? addTicks(day, tick) : tick;
  }
  return day!;
}

function addTicks(a: TickSummary, b: TickSummary): TickSummary {
  return {
    now: b.now,
    delivered: a.delivered + b.delivered,
    labelled: {
      processed: a.labelled.processed + b.labelled.processed,
      rule: a.labelled.rule + b.labelled.rule,
      ai: a.labelled.ai + b.labelled.ai,
      fallback: a.labelled.fallback + b.labelled.fallback,
    },
    deactivated: a.deactivated + b.deactivated,
    sent: {
      sent: a.sent.sent + b.sent.sent,
      bounced: a.sent.bounced + b.sent.bounced,
      suppressed: a.sent.suppressed + b.sent.suppressed,
      batches: a.sent.batches + b.sent.batches,
    },
  };
}
