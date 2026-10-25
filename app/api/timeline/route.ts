import { handle } from '../../../src/web/http';
import { getRuntime } from '../../../src/web/runtime';
import { timeline } from '../../../src/web/timeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/timeline → { days: TimelineDay[] }, first event day to the sim clock's day.
export function GET(): Promise<Response> {
  return handle(async () => {
    const { pool, config } = getRuntime();
    return { days: await timeline(pool, config.simStart) };
  });
}
