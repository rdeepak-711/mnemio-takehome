import { describe, it, expect } from 'vitest';
import { parseArgs, formatTick } from '../../src/cli';
import type { TickSummary } from '../../src/engine/tick';

describe('parseArgs', () => {
  it('reads the three commands', () => {
    expect(parseArgs(['run'])).toEqual({ command: 'run' });
    expect(parseArgs(['ai:warm'])).toEqual({ command: 'ai:warm' });
    expect(parseArgs(['advance', '--days', '30'])).toEqual({ command: 'advance', days: 30 });
    expect(parseArgs(['advance', '--days', '1'])).toEqual({ command: 'advance', days: 1 });
    expect(parseArgs(['advance', '--days', '365'])).toEqual({ command: 'advance', days: 365 });
  });

  it.each([
    [[]],
    [['walk']],
    [['run', 'extra']],
    [['ai:warm', '--days', '2']],
    [['advance']],
    [['advance', '--days']],
    [['advance', '--weeks', '2']],
    [['advance', '--days', '2', 'more']],
  ])('refuses %j with a usage message', (argv) => {
    expect(() => parseArgs(argv)).toThrow(/usage:/);
  });

  it.each(['0', '-3', '2.5', 'abc', '366', '1e2', '', ' 7', '07x'])('refuses --days %j', (n) => {
    expect(() => parseArgs(['advance', '--days', n])).toThrow(/usage:/);
  });
});

function summary(now: string): TickSummary {
  return {
    now: new Date(now),
    delivered: 12,
    labelled: { processed: 12, rule: 9, ai: 2, fallback: 1 },
    deactivated: 4,
    sent: { sent: 310, bounced: 6, suppressed: 1, batches: 2 },
  };
}

describe('formatTick', () => {
  it('prints one line per day in the agreed layout', () => {
    expect(formatTick(summary('2026-11-03T09:00:00Z'), 3, 50)).toBe(
      '2026-11-03  delivered 12 · labelled 12 (rule 9, ai 2, fallback 1) · deactivated 4 · sent 310 (bounced 6, suppressed 1) · AI calls today 3/50',
    );
  });

  it('uses the UTC calendar day, whatever the machine time zone', () => {
    expect(formatTick(summary('2026-11-03T23:59:59Z'), 0, 50).slice(0, 12)).toBe('2026-11-03  ');
    expect(formatTick(summary('2026-12-31T23:30:00-02:00'), 0, 50).slice(0, 12)).toBe('2027-01-01  ');
  });
});
