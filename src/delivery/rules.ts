import { createHash } from 'node:crypto';
import type { Delivery } from '../config';

// Pure deliverability rules (D66–D70, D72). No database, no real clock.

export const PAUSE_SAMPLE = 100; // the last N sends since the warm-up (re)started (D67)
export const PAUSE_MIN_SENDS = 50; // a smaller sample never pauses (D67)
export const UNSUBSCRIBE_MAILTO = 'unsubscribe@mnemio.example';
export const UNSUBSCRIBE_BASE_URL = 'https://mnemio.example/unsubscribe';

// A mailbox's limit on a UTC day, `ageDays` whole days after its warm-up started (D66).
export function warmupLimit(ageDays: number, warmup: Delivery['warmup']): number {
  if (!Number.isInteger(ageDays)) throw new Error(`ageDays: expected an integer, got ${ageDays}`);
  if (ageDays < 0) return 0;
  return Math.min(warmup.max, warmup.start + warmup.step * ageDays);
}

// A mailbox's most sends in one UTC hour: its daily limit spread over the window's hours, rounded up (D72).
export function hourlyLimit(daily: number, window: Delivery['sendWindow']): number {
  return Math.ceil(daily / (window.endHour - window.startHour));
}

const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

// Monday to Friday and startHour <= hour < endHour, in `timeZone` (D68). Same rule as the claim's SQL.
export function inSendWindow(at: Date, timeZone: string, window: Delivery['sendWindow']): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return WEEKDAYS.has(weekday) && hour >= window.startHour && hour < window.endHour;
}

// Strictly above the rate, and only on a big enough sample (D67).
export function shouldPause(sample: { sends: number; bounced: number }, rate: number): boolean {
  return sample.sends >= PAUSE_MIN_SENDS && sample.bounced / sample.sends > rate;
}

// outreach-01@mail1.mnemio.example …, spread over five sending domains (D66).
export function mailboxAddress(id: number): string {
  if (!Number.isInteger(id) || id < 1) throw new Error(`id: expected an integer >= 1, got ${id}`);
  return `outreach-${String(id).padStart(2, '0')}@mail${((id - 1) % 5) + 1}.mnemio.example`;
}

// The part after the last @, lower-cased (D69).
export function recipientDomain(email: string): string {
  const at = email.lastIndexOf('@');
  const domain = at < 0 ? '' : email.slice(at + 1).toLowerCase();
  if (!domain) throw new Error(`email: expected an address with a domain after @, got "${email}"`);
  return domain;
}

// Derived from SEED, so it is forgeable; a real system would use an HMAC with a secret (D70).
export function unsubscribeToken(seed: number, contactId: number): string {
  return createHash('sha256').update(`unsubscribe:${seed}:${contactId}`).digest('hex').slice(0, 16);
}

export function unsubscribeLink(seed: number, contactId: number): string {
  return `${UNSUBSCRIBE_BASE_URL}/${contactId}/${unsubscribeToken(seed, contactId)}`;
}

// RFC 8058 one-click, plus a mailto for clients that only do mail (D70).
export function unsubscribeHeaders(
  seed: number,
  contactId: number,
): { 'List-Unsubscribe': string; 'List-Unsubscribe-Post': string } {
  const token = unsubscribeToken(seed, contactId);
  return {
    'List-Unsubscribe': `<mailto:${UNSUBSCRIBE_MAILTO}?subject=unsubscribe%20${contactId}-${token}>, <${unsubscribeLink(seed, contactId)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export function withUnsubscribeFooter(body: string, link: string): string {
  return `${body.trimEnd()}\n\n--\nNot interested? Unsubscribe here: ${link}`;
}
