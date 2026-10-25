import { parseDay } from '../../../src/web/days';
import { handle } from '../../../src/web/http';
import { movesOn } from '../../../src/web/journey';
import { getRuntime } from '../../../src/web/runtime';
import { campaignDays } from '../../../src/web/summary';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/journey?day=YYYY-MM-DD → { day, moves }; no day means the sim clock's day.
export function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const { pool, config } = getRuntime();
    const day = parseDay(new URL(req.url).searchParams.get('day')) ?? (await campaignDays(pool, config.simStart)).today;
    return { day, moves: await movesOn(pool, day) };
  });
}
