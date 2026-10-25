// Play on the dashboard (D63): one simulated day per request, a pause between days set by the speed, and the rule
// that stops the loop on its own. Pure, so the browser loop and the tests share it.

export const PLAY_SPEEDS = [1, 2, 4] as const;
export type PlaySpeed = (typeof PLAY_SPEEDS)[number];

const DELAY_MS: Record<PlaySpeed, number> = { 1: 1500, 2: 600, 4: 150 };

// The pause after a day has run and the page has refetched, before the next day starts.
export function playDelayMs(speed: PlaySpeed): number {
  if (!(PLAY_SPEEDS as readonly number[]).includes(speed)) {
    throw new Error(`speed: expected one of ${PLAY_SPEEDS.join(', ')}, got ${String(speed)}`);
  }
  return DELAY_MS[speed];
}

// Why the loop stops by itself, or null to keep going. An error wins, then violations, then an empty sequence (the
// full run's stop rule, D55).
export function stopReason(s: { active: number; violations: number; error?: string | null }): string | null {
  if (s.error) return s.error;
  if (s.violations > 0) return `${s.violations} invariant violation${s.violations === 1 ? '' : 's'}`;
  if (s.active === 0) return 'Nobody is left in the sequence';
  return null;
}
