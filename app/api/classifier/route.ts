import { classifierStats } from '../../../src/web/classifier';
import { handle } from '../../../src/web/http';
import { getRuntime } from '../../../src/web/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/classifier → ClassifierStats for the labels written since SIM_START (D60).
export function GET(): Promise<Response> {
  return handle(async () => {
    const { pool, config } = getRuntime();
    return classifierStats(pool, config.simStart);
  });
}
