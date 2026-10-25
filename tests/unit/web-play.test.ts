import { describe, it, expect } from 'vitest';
import { PLAY_SPEEDS, playDelayMs, stopReason } from '../../src/web/play';

describe('playDelayMs (D63)', () => {
  it('pauses 1,500 / 600 / 150 ms between days at 1×, 2× and 4×', () => {
    expect(PLAY_SPEEDS).toEqual([1, 2, 4]);
    expect(playDelayMs(1)).toBe(1500);
    expect(playDelayMs(2)).toBe(600);
    expect(playDelayMs(4)).toBe(150);
  });

  it('refuses any other speed', () => {
    expect(() => playDelayMs(3 as never)).toThrow(/speed/);
  });
});

describe('stopReason (D63)', () => {
  it('keeps playing while people are in sequence and nothing went wrong', () => {
    expect(stopReason({ active: 10, violations: 0 })).toBeNull();
    expect(stopReason({ active: 1, violations: 0, error: null })).toBeNull();
  });

  it('stops when nobody is left in sequence', () => {
    expect(stopReason({ active: 0, violations: 0 })).toBe('Nobody is left in the sequence');
  });

  it('stops on invariant violations, with the count', () => {
    expect(stopReason({ active: 5, violations: 1 })).toBe('1 invariant violation');
    expect(stopReason({ active: 0, violations: 2 })).toBe('2 invariant violations');
  });

  it('an error wins over everything else', () => {
    expect(stopReason({ active: 0, violations: 2, error: 'a control is already running' })).toBe(
      'a control is already running',
    );
  });
});
