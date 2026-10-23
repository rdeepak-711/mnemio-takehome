import { describe, it, expect } from 'vitest';
import { cacheKey, normaliseReply } from '../../src/ai/cache';

describe('cacheKey', () => {
  it('is a sha256 hex string, the same for the same parts', () => {
    const key = cacheKey('classification', 'v1', 'hello');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey('classification', 'v1', 'hello')).toBe(key);
  });

  it('changes when the kind, the prompt version or the input changes', () => {
    const base = cacheKey('classification', 'v1', 'hello');
    expect(cacheKey('sequence', 'v1', 'hello')).not.toBe(base);
    expect(cacheKey('classification', 'v2', 'hello')).not.toBe(base);
    expect(cacheKey('classification', 'v1', 'hello!')).not.toBe(base);
  });

  it('parts cannot run into each other ("v1" + "2x" is not "v12" + "x")', () => {
    expect(cacheKey('classification', 'v1', '2x')).not.toBe(cacheKey('classification', 'v12', 'x'));
  });

  it('does not include the model, so an answer saved from one model is found when another is first', () => {
    // The signature has no model parameter at all.
    expect(cacheKey.length).toBe(3);
  });
});

describe('normaliseReply', () => {
  it('lowercases, collapses whitespace and trims', () => {
    expect(normaliseReply('  Sounds GOOD,\n\n  send   me\ta link  ')).toBe('sounds good, send me a link');
  });

  it('two replies differing only in case and spacing get the same cache key', () => {
    const a = cacheKey('classification', 'v1', normaliseReply('Not now, thanks'));
    const b = cacheKey('classification', 'v1', normaliseReply('  not NOW,   thanks\n'));
    expect(a).toBe(b);
  });
});
