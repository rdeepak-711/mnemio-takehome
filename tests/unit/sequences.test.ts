import { describe, it, expect } from 'vitest';
import { SequenceSchema, sequenceMessages, TIME_SPAN_PATTERN, type Sequence } from '../../src/ai/sequences';
import { FALLBACK_TEMPLATES } from '../../src/templates/fallback';
import { allSegments } from '../../src/segments';
import { ALLOWED_SLOTS } from '../../src/templates/render';
import { STEPS } from '../../src/lifecycle';

const GOOD: Sequence = structuredClone(FALLBACK_TEMPLATES);

function withStep(step: keyof Sequence, patch: Partial<{ subject: string; body: string }>): unknown {
  const copy = structuredClone(GOOD);
  copy[step] = { ...copy[step], ...patch };
  return copy;
}

describe('SequenceSchema', () => {
  it('accepts a good sequence (the hand-written fallback is one)', () => {
    expect(SequenceSchema.safeParse(GOOD).success).toBe(true);
  });

  it('rejects a sequence missing a step', () => {
    const { follow_up_3: _dropped, ...three } = GOOD;
    expect(SequenceSchema.safeParse(three).success).toBe(false);
  });

  it('rejects an unknown slot', () => {
    expect(
      SequenceSchema.safeParse(withStep('first', { body: 'Hi {{first_name}}, call {{phone}}.\n\nSam' })).success,
    ).toBe(false);
  });

  it('rejects a body that does not greet with {{first_name}}', () => {
    expect(
      SequenceSchema.safeParse(withStep('follow_up_1', { body: 'Hello there,\n\nJust checking in.\n\nSam' })).success,
    ).toBe(false);
  });

  it('rejects broken braces (they would be left in the email)', () => {
    expect(
      SequenceSchema.safeParse(withStep('first', { body: 'Hi {{first_name},\n\nQuick question.\n\nSam' })).success,
    ).toBe(false);
  });

  it.each(['guarantee', 'act now', 'risk-free'])('rejects the spam word "%s"', (word) => {
    expect(
      SequenceSchema.safeParse(withStep('follow_up_2', { body: `Hi {{first_name}},\n\nWe ${word}.\n\nSam` })).success,
    ).toBe(false);
  });

  it('rejects an empty or over-long subject, and an over-long body', () => {
    expect(SequenceSchema.safeParse(withStep('first', { subject: '' })).success).toBe(false);
    expect(SequenceSchema.safeParse(withStep('first', { subject: 'x'.repeat(121) })).success).toBe(false);
    expect(
      SequenceSchema.safeParse(withStep('first', { body: `Hi {{first_name}},\n\n${'x'.repeat(1300)}` })).success,
    ).toBe(false);
  });

  it.each(['last week', 'yesterday', '3 days ago', 'two weeks ago'])('rejects a time span ("%s")', (phrase) => {
    expect(TIME_SPAN_PATTERN.test(phrase)).toBe(true);
    const body = `Hi {{first_name}},\n\nFollowing up on my email from ${phrase}.\n\nSam`;
    expect(SequenceSchema.safeParse(withStep('follow_up_1', { body })).success).toBe(false);
  });

  // Found live (T17): Flint wrote each email as one run-on line with "Sam" at the end of it.
  it('rejects a body written as one line (no blank line between paragraphs)', () => {
    const body = 'Hi {{first_name}}, Just following up on my earlier email. How does {{company}} handle it? Sam';
    expect(SequenceSchema.safeParse(withStep('follow_up_1', { body })).success).toBe(false);
  });

  it('rejects a body whose sign-off "Sam" is not on its own last line', () => {
    const body = 'Hi {{first_name}},\n\nJust following up on my earlier email. Thanks, Sam';
    expect(SequenceSchema.safeParse(withStep('follow_up_1', { body })).success).toBe(false);
  });

  it('accepts a sign-off line like "Best,\\nSam" or "Thanks,\\nSam"', () => {
    const body = 'Hi {{first_name}},\n\nJust following up on my earlier email.\n\nBest,\nSam';
    expect(SequenceSchema.safeParse(withStep('follow_up_1', { body })).success).toBe(true);
  });

  it('rejects two steps with the same body', () => {
    expect(SequenceSchema.safeParse(withStep('follow_up_2', { body: GOOD.follow_up_1.body })).success).toBe(false);
  });

  it('ignores extra keys (a model that adds a "notes" field is fine), and returns only the four steps', () => {
    const parsed = SequenceSchema.safeParse({ ...GOOD, notes: 'hello' });
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.success ? parsed.data : {}).sort()).toEqual([...STEPS].sort());
  });
});

describe('sequenceMessages', () => {
  it('describes the segment in words, lists the allowed slots, the rules and the JSON shape', () => {
    const text = sequenceMessages('tech:saas')
      .map((m) => m.content)
      .join('\n');
    expect(text).toMatch(/SaaS/);
    expect(text).toMatch(/technical|engineering|CTO/i);
    for (const slot of ALLOWED_SLOTS) expect(text).toContain(`{{${slot}}}`);
    for (const step of STEPS) expect(text).toContain(step);
    expect(text).toMatch(/JSON/);
    expect(text).toMatch(/Sam/);
  });

  it('asks for the layout: greeting on its own line, blank lines between paragraphs, Sam on the last line', () => {
    const text = sequenceMessages('tech:saas')
      .map((m) => m.content)
      .join('\n');
    expect(text).toMatch(/blank line|\\n\\n/i);
    expect(text).toMatch(/own line|last line/i);
  });

  it('is different for each of the 20 segments', () => {
    const prompts = allSegments().map((s) => JSON.stringify(sequenceMessages(s)));
    expect(new Set(prompts).size).toBe(20);
  });
});
