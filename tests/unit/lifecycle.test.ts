import { describe, it, expect } from 'vitest';
import {
  STATUSES,
  STEPS,
  IN_SEQUENCE,
  TERMINAL,
  transition,
  expectedStep,
  InvalidTransitionError,
  type Status,
  type Step,
} from '../../src/lifecycle';

// status → the step it is waiting for, and what it becomes after that step is sent
const SEQUENCE: [Status, Step, Status, Step | 'deactivate'][] = [
  ['new', 'first', 'first_sent', 'follow_up_1'],
  ['first_sent', 'follow_up_1', 'follow_up_1_sent', 'follow_up_2'],
  ['follow_up_1_sent', 'follow_up_2', 'follow_up_2_sent', 'follow_up_3'],
  ['follow_up_2_sent', 'follow_up_3', 'follow_up_3_sent', 'deactivate'],
];

const inSequence: Status[] = ['new', 'first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent'];
const terminal: Status[] = ['replied', 'bounced', 'unsubscribed', 'deactivated'];

describe('statuses and steps', () => {
  it('has the 9 statuses and 4 steps in order', () => {
    expect([...STATUSES]).toEqual([...inSequence, ...terminal]);
    expect([...STEPS]).toEqual(['first', 'follow_up_1', 'follow_up_2', 'follow_up_3']);
  });

  it('IN_SEQUENCE and TERMINAL cover all 9 statuses with no overlap', () => {
    expect([...IN_SEQUENCE].sort()).toEqual([...inSequence].sort());
    expect([...TERMINAL].sort()).toEqual([...terminal].sort());
    expect(IN_SEQUENCE.filter((s) => TERMINAL.includes(s))).toEqual([]);
    expect(new Set([...IN_SEQUENCE, ...TERMINAL]).size).toBe(9);
  });
});

describe('expectedStep', () => {
  it.each(SEQUENCE)('%s is due %s', (status, step) => {
    expect(expectedStep(status)).toBe(step);
  });

  it('follow_up_3_sent has no step left (only deactivation)', () => {
    expect(expectedStep('follow_up_3_sent')).toBeNull();
  });

  it.each(terminal)('%s has no step', (status) => {
    expect(expectedStep(status)).toBeNull();
  });
});

describe('happy path', () => {
  it('goes new → first_sent → … → follow_up_3_sent → deactivated', () => {
    let status: Status = 'new';
    const seen: [Status, unknown][] = [];
    for (const step of STEPS) {
      const result = transition(status, { type: 'sent', step });
      status = result.status;
      seen.push([status, result.nextAction]);
    }
    const end = transition(status, { type: 'deactivate_due' });
    seen.push([end.status, end.nextAction]);
    expect(seen).toEqual([
      ['first_sent', 'follow_up_1'],
      ['follow_up_1_sent', 'follow_up_2'],
      ['follow_up_2_sent', 'follow_up_3'],
      ['follow_up_3_sent', 'deactivate'],
      ['deactivated', null],
    ]);
  });
});

describe('sent', () => {
  it.each(SEQUENCE)('%s + sent %s → %s, next %s', (from, step, to, next) => {
    expect(transition(from, { type: 'sent', step })).toEqual({ status: to, nextAction: next });
  });

  // every status × step pair that is not in SEQUENCE (built from the table, not from the code under test)
  const allSteps: Step[] = ['first', 'follow_up_1', 'follow_up_2', 'follow_up_3'];
  const wrong = [...inSequence, ...terminal].flatMap((status) =>
    allSteps
      .filter((step) => !SEQUENCE.some(([from, s]) => from === status && s === step))
      .map((step) => [status, step] as [Status, Step]),
  );

  it.each(wrong)('%s + sent %s throws', (status, step) => {
    expect(() => transition(status, { type: 'sent', step })).toThrow(InvalidTransitionError);
  });

  it('throws on a skipped step (new + follow_up_1)', () => {
    expect(() => transition('new', { type: 'sent', step: 'follow_up_1' })).toThrow(InvalidTransitionError);
  });

  it('throws on a repeated step (first_sent + first)', () => {
    expect(() => transition('first_sent', { type: 'sent', step: 'first' })).toThrow(InvalidTransitionError);
  });

  it('throws when sending to an unsubscribed contact', () => {
    expect(() => transition('unsubscribed', { type: 'sent', step: 'first' })).toThrow(InvalidTransitionError);
  });

  it('error message names the status and the event', () => {
    expect(() => transition('new', { type: 'sent', step: 'follow_up_1' })).toThrow(/new/);
    expect(() => transition('new', { type: 'sent', step: 'follow_up_1' })).toThrow(/sent/);
    expect(() => transition('new', { type: 'sent', step: 'follow_up_1' })).toThrow(/follow_up_1/);
  });

  it('InvalidTransitionError is an Error', () => {
    expect(new InvalidTransitionError('x')).toBeInstanceOf(Error);
  });
});

describe('bounced', () => {
  it.each(inSequence)('%s + bounced → bounced, no next action', (status) => {
    expect(transition(status, { type: 'bounced' })).toEqual({ status: 'bounced', nextAction: null });
  });

  it.each(terminal)('%s + bounced throws', (status) => {
    expect(() => transition(status, { type: 'bounced' })).toThrow(InvalidTransitionError);
  });
});

describe('reply: unsubscribe', () => {
  it.each([...inSequence, ...terminal])('%s + unsubscribe → unsubscribed', (status) => {
    expect(transition(status, { type: 'reply', label: 'unsubscribe' })).toEqual({
      status: 'unsubscribed',
      nextAction: null,
    });
  });
});

describe('reply: out_of_office', () => {
  it.each(inSequence)('%s + out_of_office → unchanged, next action unchanged', (status) => {
    expect(transition(status, { type: 'reply', label: 'out_of_office' })).toEqual({
      status,
      nextAction: 'unchanged',
    });
  });

  it.each(terminal)('%s + out_of_office → unchanged, no next action', (status) => {
    expect(transition(status, { type: 'reply', label: 'out_of_office' })).toEqual({ status, nextAction: null });
  });
});

describe('reply: interested / not_interested / needs_review', () => {
  const labels = ['interested', 'not_interested', 'needs_review'] as const;
  const fromStopping = inSequence.concat('deactivated').flatMap((s) => labels.map((l) => [s, l] as const));
  const fromFinished = (['replied', 'bounced', 'unsubscribed'] as Status[]).flatMap((s) =>
    labels.map((l) => [s, l] as const),
  );

  it.each(fromStopping)('%s + %s → replied', (status, label) => {
    expect(transition(status, { type: 'reply', label })).toEqual({ status: 'replied', nextAction: null });
  });

  it.each(fromFinished)('%s + %s → unchanged', (status, label) => {
    expect(transition(status, { type: 'reply', label })).toEqual({ status, nextAction: null });
  });

  it('a bounced contact stays bounced on an interested reply', () => {
    expect(transition('bounced', { type: 'reply', label: 'interested' }).status).toBe('bounced');
  });

  it('a deactivated contact becomes replied on an interested reply', () => {
    expect(transition('deactivated', { type: 'reply', label: 'interested' }).status).toBe('replied');
  });
});

describe('deactivate_due', () => {
  it('follow_up_3_sent → deactivated', () => {
    expect(transition('follow_up_3_sent', { type: 'deactivate_due' })).toEqual({
      status: 'deactivated',
      nextAction: null,
    });
  });

  it.each(STATUSES.filter((s) => s !== 'follow_up_3_sent'))('%s + deactivate_due throws', (status) => {
    expect(() => transition(status, { type: 'deactivate_due' })).toThrow(InvalidTransitionError);
  });
});

describe('suppressed (T13, D34)', () => {
  const reasons = ['bounced', 'unsubscribed'] as const;

  it.each(inSequence.flatMap((s) => reasons.map((r) => [s, r] as const)))(
    '%s + suppressed:%s → that status, no next action',
    (status, reason) => {
      expect(transition(status, { type: 'suppressed', reason })).toEqual({ status: reason, nextAction: null });
    },
  );

  it.each(terminal)('%s + suppressed throws', (status) => {
    expect(() => transition(status, { type: 'suppressed', reason: 'unsubscribed' })).toThrow(InvalidTransitionError);
  });

  it('the error names the event', () => {
    expect(() => transition('replied', { type: 'suppressed', reason: 'bounced' })).toThrow(/suppressed:bounced/);
  });
});
