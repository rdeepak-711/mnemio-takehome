import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('runs TypeScript tests', () => {
    const sum: number = 1 + 1;
    expect(sum).toBe(2);
  });
});
