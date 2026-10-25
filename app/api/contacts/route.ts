import { listContacts } from '../../../src/web/contacts';
import { handle } from '../../../src/web/http';
import { getRuntime } from '../../../src/web/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/contacts?q=&status=&page= → ContactPage. Number() makes 'abc' and '1.5' invalid pages (400).
export function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const params = new URL(req.url).searchParams;
    const page = params.get('page');
    return listContacts(getRuntime().pool, {
      q: params.get('q'),
      status: params.get('status'),
      page: page === null || page === '' ? undefined : Number(page),
    });
  });
}
