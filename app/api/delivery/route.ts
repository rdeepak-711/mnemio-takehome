import { parseDay } from '../../../src/web/days';
import { deliveryDay } from '../../../src/web/delivery';
import { handle } from '../../../src/web/http';
import { getRuntime } from '../../../src/web/runtime';
import { campaignDays, refuseFuture } from '../../../src/web/summary';
import { getNow } from '../../../src/clock';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/delivery?day= → DeliveryDay plus the sim clock (D71); no day means the sim clock's day, a day after it is a
// 400 (D57). The clock tells the page which hours of the clock's own day haven't been simulated yet.
export function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const { pool, config } = getRuntime();
    const params = new URL(req.url).searchParams;
    const day = parseDay(params.get('day')) ?? (await campaignDays(pool, config.simStart)).today;
    await refuseFuture(pool, day);
    const [delivery, clock] = await Promise.all([deliveryDay(pool, day, config.delivery), getNow(pool)]);
    return { ...delivery, clock };
  });
}
