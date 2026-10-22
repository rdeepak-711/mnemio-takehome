import { describe, it, expect } from 'vitest';
import { REPLY_BANK, RETURN_DATE_TOKEN, draw, formatReturnDate } from '../../src/mock/replies';
import { classifyByRules, findReturnDate } from '../../src/classify/rules';
import { REPLY_LABELS } from '../../src/labels';

const NOW = new Date('2026-11-02T09:00:00Z');
const RETURN = new Date('2026-11-09T00:00:00Z');
const fill = (body: string) => body.replace(RETURN_DATE_TOKEN, formatReturnDate(RETURN));
const entries = REPLY_LABELS.flatMap((label) => REPLY_BANK[label].map((t) => ({ label, ...t })));

describe('draw', () => {
  it('is in [0, 1) and the same for the same inputs', () => {
    const a = draw(42, 'bounce', 'p1@x.example');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(draw(42, 'bounce', 'p1@x.example')).toBe(a);
  });

  it('changes with the seed and with each part', () => {
    const a = draw(42, 'reply', '1:first');
    expect(draw(43, 'reply', '1:first')).not.toBe(a);
    expect(draw(42, 'label', '1:first')).not.toBe(a);
    expect(draw(42, 'reply', '1:follow_up_1')).not.toBe(a);
  });

  it('does not run parts together ("ab","c" differs from "a","bc")', () => {
    expect(draw(1, 'ab', 'c')).not.toBe(draw(1, 'a', 'bc'));
  });

  it('is roughly uniform over 10,000 keys', () => {
    const tenths = new Array<number>(10).fill(0);
    let sum = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const x = draw(7, 'test', String(i));
      sum += x;
      tenths[Math.floor(x * 10)]! += 1;
    }
    expect(sum / 10_000).toBeGreaterThan(0.48);
    expect(sum / 10_000).toBeLessThan(0.52);
    for (const n of tenths) expect(n).toBeGreaterThan(850);
  });
});

describe('formatReturnDate', () => {
  it.each([
    ['2026-11-09T00:00:00Z', 'Monday 9 November'],
    ['2027-01-01T00:00:00Z', 'Friday 1 January'],
    ['2026-12-25T23:59:00Z', 'Friday 25 December'],
  ])('%s → %s (UTC)', (iso, text) => {
    expect(formatReturnDate(new Date(iso))).toBe(text);
  });
});

describe('REPLY_BANK', () => {
  it.each(REPLY_LABELS)('%s has at least 4 texts and at least one ambiguous', (label) => {
    expect(REPLY_BANK[label].length).toBeGreaterThanOrEqual(4);
    expect(REPLY_BANK[label].some((t) => t.ambiguous)).toBe(true);
    for (const t of REPLY_BANK[label]) expect(t.body.trim().length).toBeGreaterThan(0);
  });

  it('the return-date token appears only in out_of_office texts, at most once, and no other braces', () => {
    for (const e of entries) {
      const tokens = e.body.split(RETURN_DATE_TOKEN).length - 1;
      if (e.label !== 'out_of_office') expect(tokens).toBe(0);
      expect(tokens).toBeLessThanOrEqual(1);
      expect(e.body.replace(RETURN_DATE_TOKEN, '')).not.toMatch(/[{}]/);
    }
  });

  it('has a non-ambiguous out_of_office text with no return date', () => {
    expect(REPLY_BANK.out_of_office.some((t) => !t.ambiguous && !t.body.includes(RETURN_DATE_TOKEN))).toBe(true);
  });

  it('has an out_of_office text with a return date', () => {
    expect(REPLY_BANK.out_of_office.some((t) => t.body.includes(RETURN_DATE_TOKEN))).toBe(true);
  });

  it.each(entries.map((e) => [e.label, e.body, e] as const))('rules never mislabel (%s) "%s"', (label, _body, e) => {
    const result = classifyByRules({ body: fill(e.body), headers: {} }, NOW);
    if (result !== null) expect(result.label).toBe(label);
    if (!e.ambiguous && label === 'unsubscribe') expect(result?.label).toBe('unsubscribe');
    if (!e.ambiguous && label === 'out_of_office') expect(result?.label).toBe('out_of_office');
    if (label === 'interested' || label === 'not_interested') expect(result).toBeNull();
  });

  it('every dated out_of_office text gives the filled-in date back', () => {
    for (const t of REPLY_BANK.out_of_office.filter((x) => x.body.includes(RETURN_DATE_TOKEN))) {
      expect(findReturnDate(fill(t.body), NOW)?.toISOString()).toBe(RETURN.toISOString());
    }
  });
});
