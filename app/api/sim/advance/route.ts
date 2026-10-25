import { BadRequest } from '../../../../src/web/errors';
import { handle, readJson } from '../../../../src/web/http';
import { getRuntime } from '../../../../src/web/runtime';
import { simAdvance } from '../../../../src/web/sim';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/sim/advance {days} → { days: TickSummary[], violations }. Violations still answer 200; the UI shows them.
export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = await readJson(req);
    const days = typeof body === 'object' && body !== null ? (body as { days?: unknown }).days : undefined;
    if (typeof days !== 'number') throw new BadRequest('body: expected {"days": N}');
    const { pool, provider, config, ai } = getRuntime();
    return simAdvance({ pool, provider, config, ai }, days);
  });
}
