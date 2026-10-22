import { describe, it, expect } from 'vitest';
import { FALLBACK_TEMPLATES } from '../../src/templates/fallback';
import { ALLOWED_SLOTS, checkContent, findSlots, render } from '../../src/templates/render';
import { STEPS } from '../../src/lifecycle';

const VARS = {
  first_name: 'Ann',
  last_name: 'Lee',
  company: 'Acme Logistics',
  role: 'Head of Operations',
  industry: 'logistics',
};

describe('FALLBACK_TEMPLATES', () => {
  it('has one template per step', () => {
    expect(Object.keys(FALLBACK_TEMPLATES).sort()).toEqual([...STEPS].sort());
  });

  it.each(STEPS)('%s uses only allowed slots, renders, and passes checkContent', (step) => {
    const t = FALLBACK_TEMPLATES[step];
    for (const slot of [...findSlots(t.subject), ...findSlots(t.body)]) {
      expect(ALLOWED_SLOTS as readonly string[]).toContain(slot);
    }
    const email = { subject: render(t.subject, VARS), body: render(t.body, VARS) };
    expect(checkContent(email)).toEqual([]);
    expect(email.body).toContain('Ann');
  });

  it('every step has a different body', () => {
    const bodies = STEPS.map((s) => FALLBACK_TEMPLATES[s].body);
    expect(new Set(bodies).size).toBe(4);
  });
});
