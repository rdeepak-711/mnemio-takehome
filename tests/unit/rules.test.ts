import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { classifyByRules, findReturnDate, type RuleResult } from '../../src/classify/rules';

const at = (iso: string) => new Date(iso);
const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const AUTO = { 'Auto-Submitted': 'auto-replied' };

// Compares results with dates turned into ISO strings, so failures are readable.
const show = (result: RuleResult) =>
  result && result.label === 'out_of_office'
    ? { label: result.label, returnDate: result.returnDate ? result.returnDate.toISOString() : null }
    : result;

describe('classifyByRules: the table from the task file', () => {
  it.each([
    [AUTO, "I'm away until 3 Nov", '2026-10-30T09:00:00Z', { label: 'out_of_office', returnDate: '2026-11-03' }],
    [AUTO, 'I am currently away from my desk.', '2026-10-30T09:00:00Z', { label: 'out_of_office', returnDate: null }],
    [{ 'auto-submitted': 'no' }, 'Thanks', '2026-10-30T09:00:00Z', null],
    [{}, 'Please remove me from your list.', '2026-10-30T09:00:00Z', { label: 'unsubscribe' }],
    [{}, 'UNSUBSCRIBE', '2026-10-30T09:00:00Z', { label: 'unsubscribe' }],
    [{}, "Don't unsubscribe me, but send less often", '2026-10-30T09:00:00Z', null],
    [{}, 'Not interested, please unsubscribe me', '2026-10-30T09:00:00Z', { label: 'unsubscribe' }],
    [
      {},
      "I'm on annual leave, back on 2026-11-10",
      '2026-10-30T09:00:00Z',
      { label: 'out_of_office', returnDate: '2026-11-10' },
    ],
    [{}, "Out of office? No, I'm here, just not interested.", '2026-10-30T09:00:00Z', null],
    [{}, 'Yes, keen to chat. Thursday?', '2026-10-30T09:00:00Z', null],
    [AUTO, 'Out of office until 5 Jan', '2026-12-20T09:00:00Z', { label: 'out_of_office', returnDate: '2027-01-05' }],
    [AUTO, 'Away, returning Monday', '2026-11-04T09:00:00Z', { label: 'out_of_office', returnDate: '2026-11-09' }],
    [AUTO, 'away until 22 Oct', '2026-10-22T09:00:00Z', { label: 'out_of_office', returnDate: '2026-10-22' }],
  ] as const)('headers %o, body %j, now %s → %o', (headers, body, now, expected) => {
    const want =
      expected && expected.label === 'out_of_office'
        ? { ...expected, returnDate: expected.returnDate ? day(expected.returnDate).toISOString() : null }
        : expected;
    expect(show(classifyByRules({ body, headers: { ...headers } }, at(now)))).toEqual(want);
  });
});

describe('classifyByRules: header rule', () => {
  const now = at('2026-10-30T09:00:00Z');

  it('reads the header name in any case', () => {
    expect(classifyByRules({ body: 'Away.', headers: { 'AUTO-SUBMITTED': 'auto-replied' } }, now)).toEqual({
      label: 'out_of_office',
      returnDate: null,
    });
  });

  it('treats the value "no" in any case and with spaces as not automatic', () => {
    expect(classifyByRules({ body: 'Thanks', headers: { 'Auto-Submitted': ' No ' } }, now)).toBeNull();
  });

  it('beats the unsubscribe rule (auto-reply footers often say "unsubscribe")', () => {
    const body = 'I am out until 3 Nov.\n\nTo unsubscribe from this list, click here.';
    expect(show(classifyByRules({ body, headers: AUTO }, now))).toEqual({
      label: 'out_of_office',
      returnDate: day('2026-11-03').toISOString(),
    });
  });

  it('with no headers at all and an ordinary body, returns null', () => {
    expect(classifyByRules({ body: 'Sounds good, send details.', headers: {} }, now)).toBeNull();
  });

  it('an empty body with no headers returns null', () => {
    expect(classifyByRules({ body: '', headers: {} }, now)).toBeNull();
  });
});

describe('classifyByRules: unsubscribe rule', () => {
  const now = at('2026-10-30T09:00:00Z');

  it.each(['Please stop emailing me.', 'stop contacting me', 'Take me off your list', 'remove me please'])(
    '%j → unsubscribe',
    (body) => {
      expect(classifyByRules({ body, headers: {} }, now)).toEqual({ label: 'unsubscribe' });
    },
  );

  it.each(['Do not remove me, I want updates', "don't remove me", 'Please DO NOT unsubscribe me'])(
    'negated %j → null',
    (body) => {
      expect(classifyByRules({ body, headers: {} }, now)).toBeNull();
    },
  );

  it('treats a curly apostrophe like a straight one ("Don’t unsubscribe me" is negated)', () => {
    expect(classifyByRules({ body: 'Don’t unsubscribe me, but send less often', headers: {} }, now)).toBeNull();
  });
});

describe('classifyByRules: out-of-office phrase without a header', () => {
  const now = at('2026-10-30T09:00:00Z');

  it('"on vacation until 3 Nov" → OOO with the date', () => {
    expect(show(classifyByRules({ body: 'On vacation until 3 Nov', headers: {} }, now))).toEqual({
      label: 'out_of_office',
      returnDate: day('2026-11-03').toISOString(),
    });
  });

  it('a denial ("I am here") makes it null', () => {
    expect(classifyByRules({ body: 'Not on vacation, I am here and interested.', headers: {} }, now)).toBeNull();
  });

  it('a curly apostrophe in a denial still counts ("I’m here")', () => {
    expect(classifyByRules({ body: 'Out of office? No — I’m here.', headers: {} }, now)).toBeNull();
  });

  it('denial words match whole words only ("Juno," is not "no,")', () => {
    expect(show(classifyByRules({ body: "Juno, I'm on leave, back on 2026-11-10", headers: {} }, now))).toEqual({
      label: 'out_of_office',
      returnDate: day('2026-11-10').toISOString(),
    });
  });
});

describe('findReturnDate', () => {
  const now = at('2026-10-30T09:00:00Z'); // a Friday

  it.each([
    ['until 3 Nov', '2026-11-03'],
    ['until November 3', '2026-11-03'],
    ['back on 3 November', '2026-11-03'],
    ['back on November 3', '2026-11-03'],
    ['UNTIL 3 NOV', '2026-11-03'],
    ['back on 2026-11-03', '2026-11-03'],
    ['returning 2026-11-03', '2026-11-03'],
    ['returning Monday', '2026-11-02'],
    ['back Monday', '2026-11-02'],
  ])('%j → %s', (text, expected) => {
    expect(findReturnDate(text, now)?.toISOString()).toBe(day(expected).toISOString());
  });

  it('a weekday is the next one strictly after now (Monday said on a Monday → a week later)', () => {
    expect(findReturnDate('back Monday', at('2026-11-02T09:00:00Z'))?.toISOString()).toBe(
      day('2026-11-09').toISOString(),
    );
  });

  it('a day earlier than today means next year', () => {
    expect(findReturnDate('until 21 Oct', at('2026-10-22T09:00:00Z'))?.toISOString()).toBe(
      day('2027-10-21').toISOString(),
    );
  });

  it('today means today, not next year', () => {
    expect(findReturnDate('until 22 Oct', at('2026-10-22T23:59:00Z'))?.toISOString()).toBe(
      day('2026-10-22').toISOString(),
    );
  });

  it('crosses the year end (5 Jan said on 20 Dec → next year)', () => {
    expect(findReturnDate('until 5 Jan', at('2026-12-20T09:00:00Z'))?.toISOString()).toBe(
      day('2027-01-05').toISOString(),
    );
  });

  it('the first date mentioned wins', () => {
    expect(findReturnDate('away until 3 Nov, back properly on 10 Nov', now)?.toISOString()).toBe(
      day('2026-11-03').toISOString(),
    );
  });

  it.each(['until 31 Feb', 'until 32 Nov', 'back on 2026-02-30', 'until 3pm', "I'm out", ''])(
    '%j → null (no date, or an impossible one)',
    (text) => {
      expect(findReturnDate(text, now)).toBeNull();
    },
  );

  it('returns dates at 00:00 UTC', () => {
    const result = findReturnDate('until 3 Nov', at('2026-10-30T17:45:12Z'));
    expect(result?.getUTCHours()).toBe(0);
    expect(result?.getUTCMinutes()).toBe(0);
    expect(result?.getUTCSeconds()).toBe(0);
  });
});

describe('findReturnDate: review fixes (a wrong date is worse than null)', () => {
  const now = at('2026-10-30T09:00:00Z'); // a Friday

  it.each([
    ['until Nov 3rd', '2026-11-03'],
    ['until 3rd November', '2026-11-03'],
    ['back on the 1st of December', null],
    ['until 21st Nov', '2026-11-21'],
    ['until 2nd Nov', '2026-11-02'],
  ] as const)('ordinal suffix %j → %s', (text, expected) => {
    const result = findReturnDate(text, now);
    expect(result ? result.toISOString() : null).toBe(expected ? day(expected).toISOString() : null);
  });

  it('a weekday followed by a date uses the date ("until Monday 3rd November" → 3 Nov, not the next Monday)', () => {
    expect(findReturnDate('until Monday 3rd November', now)?.toISOString()).toBe(day('2026-11-03').toISOString());
    expect(findReturnDate('back on Tuesday, 10 Nov', now)?.toISOString()).toBe(day('2026-11-10').toISOString());
  });

  it('an explicit year is used ("until 3 November 2027" → 2027)', () => {
    expect(findReturnDate('until 3 November 2027', now)?.toISOString()).toBe(day('2027-11-03').toISOString());
    expect(findReturnDate('until November 3, 2027', now)?.toISOString()).toBe(day('2027-11-03').toISOString());
  });

  it('an explicit year in the past is kept as written (oooReschedule then ignores it)', () => {
    expect(findReturnDate('until 3 November 2025', now)?.toISOString()).toBe(day('2025-11-03').toISOString());
  });
});

describe('src/classify/rules.ts', () => {
  it('never reads the real clock (no `new Date()` without arguments, no Date.now())', () => {
    const source = readFileSync(new URL('../../src/classify/rules.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/new Date\(\s*\)/);
    expect(source).not.toMatch(/Date\.now\(/);
  });
});
