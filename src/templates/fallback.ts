import type { Step } from '../lifecycle';

// Hand-written emails used when there is no AI template or it fails checks (D46).
// Only allowed slots; each must pass checkContent after render (tests/unit/fallback.test.ts).
export const FALLBACK_TEMPLATES: Record<Step, { subject: string; body: string }> = {
  first: {
    subject: 'A question about outreach at {{company}}',
    body:
      'Hi {{first_name}},\n\n' +
      'I work with {{industry}} teams on follow-up emails, and I wondered how {{company}} handles this today.\n\n' +
      'Would a short call next week be useful?\n\n' +
      'Thanks,\nSam',
  },
  follow_up_1: {
    subject: 'Re: A question about outreach at {{company}}',
    body:
      'Hi {{first_name}},\n\n' +
      'Following up on my earlier email, in case it got buried.\n\n' +
      'Do you look after outreach at {{company}}, or is there someone better to ask?\n\n' +
      'Thanks,\nSam',
  },
  follow_up_2: {
    subject: 'Re: A question about outreach at {{company}}',
    body:
      'Hi {{first_name}},\n\n' +
      'One more note on my earlier emails. Other {{industry}} teams have used this to save time on follow-ups.\n\n' +
      'Happy to share a short example if that would help.\n\n' +
      'Thanks,\nSam',
  },
  follow_up_3: {
    subject: 'Closing the loop, {{first_name}}',
    body:
      'Hi {{first_name}},\n\n' +
      'I have not heard back, so I will stop writing after this one.\n\n' +
      'If outreach at {{company}} becomes a priority later, just reply to this email.\n\n' +
      'All the best,\nSam',
  },
};
