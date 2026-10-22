import { describe, it, expect } from 'vitest';
import { escapeRegExp } from '../../src/regex';

describe('escapeRegExp', () => {
  it('leaves plain text unchanged', () => {
    expect(escapeRegExp('act now')).toBe('act now');
  });

  it('escapes every regex special character', () => {
    expect(escapeRegExp('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
  });

  it('makes a built pattern match the text literally', () => {
    for (const text of ['100% free', 'risk-free', 'a.b', '$$$', '(c) [d]', 'x+y?']) {
      expect(new RegExp(`^${escapeRegExp(text)}$`).test(text)).toBe(true);
    }
    expect(new RegExp(escapeRegExp('a.b')).test('axb')).toBe(false);
  });
});

describe('the helper is shared, not copied', () => {
  it('render.ts and segments.ts import escapeRegExp instead of defining their own', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['../../src/templates/render.ts', '../../src/segments.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/function escapeRegExp/);
      expect(source).toMatch(/import \{ escapeRegExp \} from/);
    }
  });
});
