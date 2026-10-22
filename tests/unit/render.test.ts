import { describe, it, expect } from 'vitest';
import { ALLOWED_SLOTS, SPAM_WORDS, render, findSlots, checkContent } from '../../src/templates/render';

const priya = {
  first_name: 'Priya',
  last_name: 'Sharma',
  company: 'Acme Labs',
  role: 'Head of Engineering',
  industry: 'SaaS',
};

describe('ALLOWED_SLOTS and SPAM_WORDS', () => {
  it('allows exactly the 5 contact columns', () => {
    expect([...ALLOWED_SLOTS]).toEqual(['first_name', 'last_name', 'company', 'role', 'industry']);
  });

  it('includes at least the 6 required spam words', () => {
    for (const word of ['free money', 'guarantee', 'act now', '100% free', 'winner', 'risk-free']) {
      expect(SPAM_WORDS).toContain(word);
    }
  });
});

describe('render', () => {
  it('returns a template with no slots unchanged', () => {
    expect(render('Hello there, quick question.', priya)).toBe('Hello there, quick question.');
  });

  it('replaces the same slot every time it appears', () => {
    expect(render('{{first_name}}, {{first_name}}!', priya)).toBe('Priya, Priya!');
  });

  it('allows spaces inside the braces', () => {
    expect(render('At {{ company }} and {{  role}}', priya)).toBe('At Acme Labs and Head of Engineering');
  });

  it('replaces all 5 slots', () => {
    expect(render('{{first_name}} {{last_name}} · {{role}} at {{company}} ({{industry}})', priya)).toBe(
      'Priya Sharma · Head of Engineering at Acme Labs (SaaS)',
    );
  });

  it('throws naming an unknown slot', () => {
    expect(() => render('Use {{discount}} today', priya)).toThrow(/discount/);
  });

  it('throws naming an allowed slot that has no value', () => {
    const { company: _omit, ...noCompany } = priya;
    expect(() => render('Hi from {{company}}', noCompany)).toThrow(/company/);
  });

  it('throws naming an allowed slot whose value is empty or only spaces', () => {
    expect(() => render('Hi from {{company}}', { ...priya, company: '' })).toThrow(/company/);
    expect(() => render('Hi from {{company}}', { ...priya, company: '   ' })).toThrow(/company/);
  });

  it('does not need values for slots the template does not use', () => {
    expect(render('Hi {{first_name}}', { first_name: 'Priya' })).toBe('Hi Priya');
  });

  it('inserts a value containing braces literally and does not process it again', () => {
    expect(render('Hi from {{company}}', { ...priya, company: '{{evil}}' })).toBe('Hi from {{evil}}');
    expect(render('Hi from {{company}}', { ...priya, company: '{{first_name}}' })).toBe('Hi from {{first_name}}');
  });

  it('does not change the vars object', () => {
    const vars = { ...priya };
    render('{{first_name}}', vars);
    expect(vars).toEqual(priya);
  });
});

describe('findSlots', () => {
  it('lists slot names once each, in order of first appearance', () => {
    expect(findSlots('{{company}} {{ first_name }} {{company}} {{role}}')).toEqual(['company', 'first_name', 'role']);
  });

  it('includes names that are not allowed (render rejects them, findSlots only reports)', () => {
    expect(findSlots('Hi {{first_name}}, use {{discount}}')).toEqual(['first_name', 'discount']);
  });

  it('returns [] for a template with no slots', () => {
    expect(findSlots('No blanks here.')).toEqual([]);
  });
});

describe('checkContent', () => {
  const ok = { subject: 'Quick question about Acme Labs', body: 'Hi Priya,\n\nShort note.\n\nThanks' };

  it('returns [] for a clean email', () => {
    expect(checkContent(ok)).toEqual([]);
  });

  it('flags leftover braces in the subject or the body', () => {
    expect(checkContent({ ...ok, subject: 'Hi {{first_name}}' })).toHaveLength(1);
    expect(checkContent({ ...ok, body: 'Hi from {{evil}}' })).toHaveLength(1);
    expect(checkContent({ ...ok, body: 'only an opening {{ here' })).toHaveLength(1);
    expect(checkContent({ ...ok, body: 'only a closing }} here' })).toHaveLength(1);
  });

  it('flags an empty or whitespace-only subject', () => {
    expect(checkContent({ ...ok, subject: '' })).toHaveLength(1);
    expect(checkContent({ ...ok, subject: '   ' })).toHaveLength(1);
  });

  it('allows a 120-character subject and flags 121', () => {
    expect(checkContent({ ...ok, subject: 'a'.repeat(120) })).toEqual([]);
    expect(checkContent({ ...ok, subject: 'a'.repeat(121) })).toHaveLength(1);
  });

  it('allows a 1,200-character body and flags 1,201', () => {
    expect(checkContent({ ...ok, body: 'a'.repeat(1200) })).toEqual([]);
    expect(checkContent({ ...ok, body: 'a'.repeat(1201) })).toHaveLength(1);
  });

  it.each(['free money', 'guarantee', 'act now', '100% free', 'winner', 'risk-free'])(
    'flags the spam word "%s" in the body',
    (word) => {
      expect(checkContent({ ...ok, body: `This is ${word} for you.` })).toHaveLength(1);
    },
  );

  it('flags a spam word in the subject', () => {
    expect(checkContent({ ...ok, subject: 'You are a WINNER' })).toHaveLength(1);
  });

  it('matches spam words in any case', () => {
    expect(checkContent({ ...ok, body: 'We GuArAnTeE results' })).toHaveLength(1);
  });

  it('catches a longer form of a spam word ("guaranteed")', () => {
    expect(checkContent({ ...ok, body: 'Results guaranteed.' })).toHaveLength(1);
  });

  it('matches from the start of a word, so "contact now" is not "act now"', () => {
    expect(checkContent({ ...ok, body: 'Who should I contact now about this?' })).toEqual([]);
  });

  it('reports every problem, not just the first', () => {
    expect(checkContent({ subject: '', body: 'Act now, {{oops}}' }).length).toBeGreaterThanOrEqual(3);
  });

  it('each problem is a non-empty description', () => {
    for (const problem of checkContent({ subject: '', body: 'winner' })) {
      expect(typeof problem).toBe('string');
      expect(problem.length).toBeGreaterThan(0);
    }
  });
});

describe('full example', () => {
  it('renders a follow-up for Priya Sharma at Acme Labs and it passes the content check', () => {
    const subject = 'Re: {{company}} and {{industry}} hiring';
    const body = [
      'Hi {{ first_name }},',
      '',
      'Following up on my note last week. Teams like {{company}} usually ask a {{role}} about this first,',
      'so I wanted to check whether it is on your radar this quarter.',
      '',
      'Happy to send a two-line summary if that is easier.',
      '',
      'Thanks',
    ].join('\n');

    const email = { subject: render(subject, priya), body: render(body, priya) };

    expect(email.subject).toBe('Re: Acme Labs and SaaS hiring');
    expect(email.body).toContain('Hi Priya,');
    expect(email.body).toContain('Teams like Acme Labs usually ask a Head of Engineering');
    expect(checkContent(email)).toEqual([]);
  });
});
