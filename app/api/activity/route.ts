import { listActivity } from '../../../src/web/activity';
import { handle } from '../../../src/web/http';
import { getRuntime } from '../../../src/web/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/activity?kind=&q=&day=&page= → ActivityPage. Number() makes 'abc' and '1.5' invalid pages (400).
export function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const params = new URL(req.url).searchParams;
    const page = params.get('page');
    return listActivity(getRuntime().pool, {
      kind: params.get('kind'),
      q: params.get('q'),
      day: params.get('day'),
      page: page === null || page === '' ? undefined : Number(page),
    });
  });
}
