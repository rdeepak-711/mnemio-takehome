import type { Label } from './labels';

export const STATUSES = [
  'new',
  'first_sent',
  'follow_up_1_sent',
  'follow_up_2_sent',
  'follow_up_3_sent',
  'replied',
  'bounced',
  'unsubscribed',
  'deactivated',
] as const;
export type Status = (typeof STATUSES)[number];
export const STEPS = ['first', 'follow_up_1', 'follow_up_2', 'follow_up_3'] as const;
export type Step = (typeof STEPS)[number];
export type NextAction = Step | 'deactivate' | null;

export const IN_SEQUENCE: readonly Status[] = [
  'new',
  'first_sent',
  'follow_up_1_sent',
  'follow_up_2_sent',
  'follow_up_3_sent',
];
export const TERMINAL: readonly Status[] = ['replied', 'bounced', 'unsubscribed', 'deactivated'];

export type LifecycleEvent =
  | { type: 'sent'; step: Step }
  | { type: 'bounced' }
  | { type: 'reply'; label: Label }
  | { type: 'deactivate_due' }
  | { type: 'suppressed'; reason: 'bounced' | 'unsubscribed' };

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

// The step each in-sequence status is waiting for; follow_up_3_sent only waits for deactivation.
const EXPECTED_STEP: Record<Status, Step | null> = {
  new: 'first',
  first_sent: 'follow_up_1',
  follow_up_1_sent: 'follow_up_2',
  follow_up_2_sent: 'follow_up_3',
  follow_up_3_sent: null,
  replied: null,
  bounced: null,
  unsubscribed: null,
  deactivated: null,
};

// Where a contact lands after a step is sent, and what it waits for next.
const AFTER_SENT: Record<Step, { status: Status; nextAction: NextAction }> = {
  first: { status: 'first_sent', nextAction: 'follow_up_1' },
  follow_up_1: { status: 'follow_up_1_sent', nextAction: 'follow_up_2' },
  follow_up_2: { status: 'follow_up_2_sent', nextAction: 'follow_up_3' },
  follow_up_3: { status: 'follow_up_3_sent', nextAction: 'deactivate' },
};

export function expectedStep(status: Status): Step | null {
  return EXPECTED_STEP[status];
}

const isInSequence = (status: Status) => IN_SEQUENCE.includes(status);

function describeEvent(event: LifecycleEvent): string {
  switch (event.type) {
    case 'sent':
      return `sent:${event.step}`;
    case 'reply':
      return `reply:${event.label}`;
    case 'suppressed':
      return `suppressed:${event.reason}`;
    case 'bounced':
    case 'deactivate_due':
      return event.type;
  }
}

function invalid(status: Status, event: LifecycleEvent): InvalidTransitionError {
  return new InvalidTransitionError(`cannot apply ${describeEvent(event)} to status ${status}`);
}

function applyReply(status: Status, label: Label): { status: Status; nextAction: NextAction | 'unchanged' } {
  switch (label) {
    case 'unsubscribe':
      return { status: 'unsubscribed', nextAction: null };
    case 'out_of_office':
      // The due date is moved by the caller (T04); here the action just stays as it is.
      return isInSequence(status) ? { status, nextAction: 'unchanged' } : { status, nextAction: null };
    case 'interested':
    case 'not_interested':
    case 'needs_review':
      // A deactivated contact can still answer; replied, bounced and unsubscribed are final.
      return isInSequence(status) || status === 'deactivated'
        ? { status: 'replied', nextAction: null }
        : { status, nextAction: null };
    default: {
      const unhandled: never = label;
      throw new Error(`unhandled reply label ${String(unhandled)}`);
    }
  }
}

export function transition(
  status: Status,
  event: LifecycleEvent,
): { status: Status; nextAction: NextAction | 'unchanged' } {
  switch (event.type) {
    case 'sent':
      if (expectedStep(status) !== event.step) throw invalid(status, event);
      return { ...AFTER_SENT[event.step] };
    case 'bounced':
      if (!isInSequence(status)) throw invalid(status, event);
      return { status: 'bounced', nextAction: null };
    case 'reply':
      return applyReply(status, event.label);
    case 'deactivate_due':
      if (status !== 'follow_up_3_sent') throw invalid(status, event);
      return { status: 'deactivated', nextAction: null };
    case 'suppressed':
      // The address is on the do-not-email list; the status records why (D34).
      if (!isInSequence(status)) throw invalid(status, event);
      return { status: event.reason, nextAction: null };
    default: {
      const unhandled: never = event;
      throw new Error(`unhandled event ${JSON.stringify(unhandled)}`);
    }
  }
}
