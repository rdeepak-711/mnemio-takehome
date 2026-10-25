import type { AiClient } from './client';
import { createSequenceWriter } from './sequences';
import { allSegments } from '../segments';

export type WarmResult = { segment: string; source: 'ai' | 'cache' | 'fallback' };

// One segment at a time, so the warm-up stays inside the rate limit and its output reads in order (D53).
export async function warmSequences(ai: AiClient): Promise<WarmResult[]> {
  const writer = createSequenceWriter(ai);
  const results: WarmResult[] = [];
  for (const segment of allSegments()) {
    const template = await writer.getTemplate(segment, 'first');
    results.push({ segment, source: template ? template.source : 'fallback' });
  }
  return results;
}
