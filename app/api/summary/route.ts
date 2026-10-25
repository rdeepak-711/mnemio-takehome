import { parseDay } from '../../../src/web/days';
import { handle } from '../../../src/web/http';
import { getRuntime } from '../../../src/web/runtime';
import { campaignDays, summaryAt } from '../../../src/web/summary';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/summary?day=YYYY-MM-DD → { summary, days }; no day means the sim clock's day.
export function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const { pool, config } = getRuntime();
    const day = parseDay(new URL(req.url).searchParams.get('day'));
    const days = await campaignDays(pool, config.simStart);
    return { summary: await summaryAt(pool, day ?? days.today, config.simStart), days };
  });
}
