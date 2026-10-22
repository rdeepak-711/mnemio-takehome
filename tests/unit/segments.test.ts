import { describe, it, expect } from 'vitest';
import {
  ROLE_FAMILIES,
  INDUSTRIES,
  ROLE_TITLES,
  roleFamily,
  segmentOf,
  allSegments,
  type RoleFamily,
} from '../../src/segments';

describe('families and industries', () => {
  it('has the 4 role families and 5 industries in order', () => {
    expect([...ROLE_FAMILIES]).toEqual(['founder', 'sales', 'ops_finance', 'tech']);
    expect([...INDUSTRIES]).toEqual(['saas', 'ecommerce', 'fintech', 'healthcare', 'logistics']);
  });
});

describe('roleFamily: the edge cases from the task file', () => {
  it.each([
    ['Co-Founder & CEO', 'founder'],
    ['VP of Engineering', 'tech'],
    ['Head of Sales', 'sales'],
    ['CFO', 'ops_finance'],
    ['cfo', 'ops_finance'],
    ['DevOps Lead', 'tech'],
    ['Chief Technology Officer', 'tech'],
    ['Chief Operating Officer', 'ops_finance'],
    ['Founder, ex-Sales Director', 'founder'],
    ['Chief Happiness Officer', 'ops_finance'],
  ] as const)('%s → %s', (title, family) => {
    expect(roleFamily(title)).toBe(family);
  });
});

describe('roleFamily: each keyword', () => {
  it.each([
    ['Founder', 'founder'],
    ['CEO', 'founder'],
    ['CTO', 'tech'],
    ['Technology Lead', 'tech'],
    ['Staff Engineer', 'tech'],
    ['Head of Engineering', 'tech'],
    ['Senior Developer', 'tech'],
    ['DevOps Manager', 'tech'],
    ['Sales Manager', 'sales'],
    ['Chief Revenue Officer', 'sales'],
    ['Business Development Manager', 'sales'],
    ['Account Executive', 'sales'],
    ['COO', 'ops_finance'],
    ['Finance Manager', 'ops_finance'],
    ['Head of Operations', 'ops_finance'],
    ['Ops Lead', 'ops_finance'],
    ['Financial Controller', 'ops_finance'],
  ] as const)('%s → %s', (title, family) => {
    expect(roleFamily(title)).toBe(family);
  });
});

describe('roleFamily: whole words only', () => {
  it('"cto" inside "Director" does not count (Director of Marketing → default)', () => {
    expect(roleFamily('Director of Marketing')).toBe('ops_finance');
  });

  it('"cto" inside "Director" does not make a sales director tech', () => {
    expect(roleFamily('Sales Director')).toBe('sales');
  });

  it('"ops" inside "DevOps" does not count, so DevOps stays tech', () => {
    expect(roleFamily('devops engineer')).toBe('tech');
  });

  it('"sales" inside "Salesforce" does not count', () => {
    expect(roleFamily('Salesforce Administrator')).toBe('ops_finance');
  });

  it('"founder" does not match "Founding" (Founding Engineer → tech)', () => {
    expect(roleFamily('Founding Engineer')).toBe('tech');
  });
});

describe('roleFamily: order and defaults pinned', () => {
  it('rule 2 beats rule 3: "Sales Engineer" → tech', () => {
    expect(roleFamily('Sales Engineer')).toBe('tech');
  });

  it('rule 3 beats rule 4: "VP Sales & Operations" → sales', () => {
    expect(roleFamily('VP Sales & Operations')).toBe('sales');
  });

  it('rule 1 beats rule 2: "CTO & Co-founder" → founder', () => {
    expect(roleFamily('CTO & Co-founder')).toBe('founder');
  });

  it('is case-insensitive', () => {
    expect(roleFamily('HEAD OF SALES')).toBe('sales');
    expect(roleFamily('chief technology officer')).toBe('tech');
  });

  it('an empty title gets the default', () => {
    expect(roleFamily('')).toBe('ops_finance');
  });
});

describe('ROLE_TITLES', () => {
  it('has 4–6 titles for every family', () => {
    for (const family of ROLE_FAMILIES) {
      expect(ROLE_TITLES[family].length).toBeGreaterThanOrEqual(4);
      expect(ROLE_TITLES[family].length).toBeLessThanOrEqual(6);
    }
  });

  it('has no title listed twice, in any family', () => {
    const all = ROLE_FAMILIES.flatMap((family) => [...ROLE_TITLES[family]]);
    expect(new Set(all).size).toBe(all.length);
  });

  const pairs = ROLE_FAMILIES.flatMap((family) =>
    ROLE_TITLES[family].map((title) => [title, family] as [string, RoleFamily]),
  );

  it.each(pairs)('"%s" maps back to %s', (title, family) => {
    expect(roleFamily(title)).toBe(family);
  });
});

describe('segments', () => {
  it("segmentOf('founder', 'saas') → 'founder:saas'", () => {
    expect(segmentOf('founder', 'saas')).toBe('founder:saas');
  });

  it('allSegments has 20 unique entries, one per family × industry', () => {
    const segments = allSegments();
    expect(segments).toHaveLength(20);
    expect(new Set(segments).size).toBe(20);
    for (const family of ROLE_FAMILIES) {
      for (const industry of INDUSTRIES) {
        expect(segments).toContain(`${family}:${industry}`);
      }
    }
  });

  it('every segment is plain lowercase ASCII, safe in cache keys and URLs', () => {
    for (const segment of allSegments()) {
      expect(segment).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
  });
});
