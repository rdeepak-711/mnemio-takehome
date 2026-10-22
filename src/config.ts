import { z } from 'zod';
import { REPLY_LABELS, type ReplyLabel } from './labels';

export type Config = {
  databaseUrl: string;
  seed: number;
  contactCount: number;
  simStart: Date;
  waitDays: [number, number, number, number];
  bounceRate: number;
  replyRate: number;
  replyMix: Record<ReplyLabel, number>;
  oooDefaultDays: number;
  sendBatchSize: number;
  openrouterApiKey: string | null;
  openrouterModels: string[];
  aiRpm: number;
  dailyAiBudget: number;
};

type Env = Record<string, string | undefined>;

// Strict text checks run before Number(), so '', '1.5', 'x' and '3e0' never coerce.
// z.number().int() also rejects values beyond Number.MAX_SAFE_INTEGER.
const int = (min = -Infinity, max = Infinity) =>
  z.string().trim()
    .regex(/^-?\d+$/, 'expected an integer')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

// ISO 8601 with date, time and an explicit zone, so the result never depends on the machine's timezone.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const rate = z.string().trim()
  .regex(/^-?\d*\.?\d+$/, 'expected a number')
  .transform(Number)
  .pipe(z.number().min(0).max(1));

// Runs a schema and rethrows the first problem prefixed with the variable name.
function check<T>(name: string, schema: z.ZodType<T, string>, raw: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${name}: ${result.error.issues[0]?.message ?? 'invalid value'} (got "${raw}")`);
  }
  return result.data;
}

// Empty or whitespace-only counts as unset, so `.env` lines like `X=` fall back to the default.
function read(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

function parseWaitDays(raw: string): [number, number, number, number] {
  const parts = raw.split(',');
  if (parts.length !== 4) throw new Error(`WAIT_DAYS: expected 4 values, got ${parts.length}`);
  const [a, b, c, d] = parts.map((part) => check('WAIT_DAYS', int(1), part)) as [number, number, number, number];
  return [a, b, c, d];
}

function parseReplyMix(raw: string): Record<ReplyLabel, number> {
  const mix: Record<ReplyLabel, number> = { interested: 0, not_interested: 0, out_of_office: 0, unsubscribe: 0 };
  const seen = new Set<string>();
  for (const pair of raw.split(',')) {
    const [label = '', value = '', ...rest] = pair.split(':').map((s) => s.trim());
    if (rest.length > 0 || !value) throw new Error(`REPLY_MIX: expected label:value, got "${pair}"`);
    if (!(REPLY_LABELS as readonly string[]).includes(label)) throw new Error(`REPLY_MIX: unknown label "${label}"`);
    if (seen.has(label)) throw new Error(`REPLY_MIX: duplicate label "${label}"`);
    seen.add(label);
    mix[label as ReplyLabel] = check(`REPLY_MIX ${label}`, rate, value);
  }
  const sum = Object.values(mix).reduce((total, n) => total + n, 0);
  if (Math.abs(sum - 1) > 0.001) throw new Error(`REPLY_MIX: values must sum to 1, got ${sum}`);
  return mix;
}

export function loadConfig(env: Env): Config {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL: required but missing or empty');

  const simStartRaw = read(env, 'SIM_START', '2026-11-02T09:00:00Z');
  const simStart = new Date(simStartRaw.trim());
  if (!ISO_WITH_ZONE.test(simStartRaw.trim()) || Number.isNaN(simStart.getTime())) {
    throw new Error(`SIM_START: expected an ISO date-time with zone like 2026-11-02T09:00:00Z, got "${simStartRaw}"`);
  }

  return {
    databaseUrl,
    seed: check('SEED', int(), read(env, 'SEED', '42')),
    contactCount: check('CONTACT_COUNT', int(1, 1_000_000), read(env, 'CONTACT_COUNT', '10000')),
    simStart,
    waitDays: parseWaitDays(read(env, 'WAIT_DAYS', '3,5,7,7')),
    bounceRate: check('BOUNCE_RATE', rate, read(env, 'BOUNCE_RATE', '0.03')),
    replyRate: check('REPLY_RATE', rate, read(env, 'REPLY_RATE', '0.08')),
    replyMix: parseReplyMix(
      read(env, 'REPLY_MIX', 'interested:0.30,not_interested:0.35,out_of_office:0.20,unsubscribe:0.15'),
    ),
    oooDefaultDays: check('OOO_DEFAULT_DAYS', int(1), read(env, 'OOO_DEFAULT_DAYS', '7')),
    sendBatchSize: check('SEND_BATCH_SIZE', int(1), read(env, 'SEND_BATCH_SIZE', '200')),
    openrouterApiKey: env.OPENROUTER_API_KEY?.trim() || null,
    openrouterModels: read(env, 'OPENROUTER_MODELS', '').split(',').map((s) => s.trim()).filter(Boolean),
    aiRpm: check('AI_RPM', int(1), read(env, 'AI_RPM', '20')),
    dailyAiBudget: check('DAILY_AI_BUDGET', int(0), read(env, 'DAILY_AI_BUDGET', '45')),
  };
}
