import { campaignDays } from '../../../src/web/summary';
import { parseDay } from '../../../src/web/days';
import { BadRequest } from '../../../src/web/errors';
import { handle } from '../../../src/web/http';
import { getRuntime } from '../../../src/web/runtime';
import { stageAt } from '../../../src/web/stage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/stage?status=&day=&page= → StagePage (D62); no day means the sim clock's day, no status is a 400.
export function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const { pool, config } = getRuntime();
    const params = new URL(req.url).searchParams;
    const status = params.get('status');
    if (!status) throw new BadRequest('status: required');
    const page = params.get('page');
    const day = parseDay(params.get('day')) ?? (await campaignDays(pool, config.simStart)).today;
    return stageAt(pool, day, status, { page: page === null || page === '' ? undefined : Number(page) });
  });
}
