import { MAX_ADVANCE_DAYS, type TickSummary } from './engine/tick';

export type Command = { command: 'run' } | { command: 'advance'; days: number } | { command: 'ai:warm' };

const USAGE = `usage: main.ts run | main.ts advance --days N (N from 1 to ${MAX_ADVANCE_DAYS}) | main.ts ai:warm`;

function usage(problem: string): Error {
  return new Error(`${problem}\n${USAGE}`);
}

export function parseArgs(argv: string[]): Command {
  const [command, ...rest] = argv;
  if (command === undefined) throw usage('no command given');
  if (command === 'run' || command === 'ai:warm') {
    if (rest.length > 0) throw usage(`unexpected arguments after ${command}: ${rest.join(' ')}`);
    return { command };
  }
  if (command === 'advance') {
    const [flag, value, ...extra] = rest;
    if (flag !== '--days' || value === undefined) throw usage('advance needs --days N');
    if (extra.length > 0) throw usage(`unexpected arguments: ${extra.join(' ')}`);
    // A plain whole number only: Number() would accept '1e2', ' 7' and '0x10'.
    const days = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(days) || days < 1 || days > MAX_ADVANCE_DAYS) throw usage(`bad --days value: '${value}'`);
    return { command, days };
  }
  throw usage(`unknown command: ${command}`);
}

export function formatTick(s: TickSummary, callsToday: number, budget: number): string {
  const day = s.now.toISOString().slice(0, 10); // UTC calendar day
  const l = s.labelled;
  return [
    `${day}  delivered ${s.delivered}`,
    `labelled ${l.processed} (rule ${l.rule}, ai ${l.ai}, fallback ${l.fallback})`,
    `deactivated ${s.deactivated}`,
    `sent ${s.sent.sent} (bounced ${s.sent.bounced}, suppressed ${s.sent.suppressed})`,
    `AI calls today ${callsToday}/${budget}`,
  ].join(' · ');
}
