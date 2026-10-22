import type pg from 'pg';
import type { Config } from '../config';
import { REPLY_LABELS, type ReplyLabel } from '../labels';
import { REPLY_BANK, RETURN_DATE_TOKEN, draw, formatReturnDate } from './replies';

export type SendInput = { idempotencyKey: string; to: string; subject: string; body: string; now: Date };
export type SendResult = { outcome: 'accepted' | 'bounced' };
export type Provider = { send(input: SendInput): Promise<SendResult> };

export const OOO_HEADERS = { 'Auto-Submitted': 'auto-replied' } as const;
export const LATE_REPLY_SHARE = 0.1;

type ProviderConfig = Pick<Config, 'seed' | 'bounceRate' | 'replyRate' | 'replyMix' | 'waitDays'>;
type Reply = { body: string; headers: Record<string, string>; label: ReplyLabel; deliverAt: Date };

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MIN_DELAY_MINUTES = 12 * 60;
const MAX_DELAY_MINUTES = 72 * 60;

// An integer in [min, max] from a draw.
function between(x: number, min: number, max: number): number {
  return min + Math.floor(x * (max - min + 1));
}

// Walks the mix in REPLY_LABELS order; a rounding gap at the top falls to the last label with weight.
function pickLabel(x: number, mix: ProviderConfig['replyMix']): ReplyLabel {
  let total = 0;
  let last: ReplyLabel = REPLY_LABELS[0];
  for (const label of REPLY_LABELS) {
    if (mix[label] <= 0) continue;
    total += mix[label];
    last = label;
    if (x < total) return label;
  }
  return last;
}

// The reply for an accepted email, or null. Every choice is its own draw keyed by the idempotency key (D41).
function planReply(config: ProviderConfig, key: string, now: Date): Reply | null {
  const { seed } = config;
  if (draw(seed, 'reply', key) >= config.replyRate) return null;
  const label = pickLabel(draw(seed, 'label', key), config.replyMix);
  const bank = REPLY_BANK[label];
  const template = bank[Math.floor(draw(seed, 'text', key) * bank.length)]!;
  // Some replies to follow-up 3 land after the last wait, i.e. after deactivation (D44).
  const step = key.slice(key.lastIndexOf(':') + 1);
  const late = step === 'follow_up_3' && draw(seed, 'late', key) < LATE_REPLY_SHARE;
  const lastWaitMinutes = config.waitDays[3] * 24 * 60;
  const delayMinutes = late
    ? between(draw(seed, 'delay', key), lastWaitMinutes + 24 * 60, lastWaitMinutes + 14 * 24 * 60)
    : between(draw(seed, 'delay', key), MIN_DELAY_MINUTES, MAX_DELAY_MINUTES);
  const deliverAt = new Date(now.getTime() + delayMinutes * MINUTE_MS);
  if (label !== 'out_of_office') return { body: template.body, headers: {}, label, deliverAt };

  const headers = draw(seed, 'header', key) < 0.75 ? { ...OOO_HEADERS } : {};
  const dayStart = Date.UTC(deliverAt.getUTCFullYear(), deliverAt.getUTCMonth(), deliverAt.getUTCDate());
  const returnDate = new Date(dayStart + between(draw(seed, 'return', key), 2, 14) * DAY_MS);
  const body = template.body.replace(RETURN_DATE_TOKEN, formatReturnDate(returnDate));
  return { body, headers, label, deliverAt };
}

// Takes a pool, never a client: each send runs in its own transaction on its own connection,
// so a caller's rollback can't undo it (D31).
export function createProvider(pool: pg.Pool, config: ProviderConfig): Provider {
  return {
    async send({ idempotencyKey, to, now }) {
      const outcome = draw(config.seed, 'bounce', to) < config.bounceRate ? 'bounced' : 'accepted';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query<SendResult>(
          `INSERT INTO mock_outbox (idempotency_key, outcome, received_at) VALUES ($1, $2, $3)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING outcome`,
          [idempotencyKey, outcome, now],
        );
        if (inserted.rows.length === 0) {
          // A repeated key: the first answer stands and nothing new is scheduled.
          const stored = await client.query<SendResult>('SELECT outcome FROM mock_outbox WHERE idempotency_key = $1', [
            idempotencyKey,
          ]);
          await client.query('COMMIT');
          return { outcome: stored.rows[0]!.outcome };
        }
        const reply = outcome === 'accepted' ? planReply(config, idempotencyKey, now) : null;
        if (reply) {
          await client.query(
            `INSERT INTO mock_inbox (idempotency_key, body, headers, true_label, deliver_at, delivered)
             VALUES ($1, $2, $3, $4, $5, false)`,
            [idempotencyKey, reply.body, JSON.stringify(reply.headers), reply.label, reply.deliverAt],
          );
        }
        await client.query('COMMIT');
        return { outcome };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
