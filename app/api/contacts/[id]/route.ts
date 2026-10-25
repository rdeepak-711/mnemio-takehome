import { contactDetail } from '../../../../src/web/contacts';
import { BadRequest } from '../../../../src/web/errors';
import { handle } from '../../../../src/web/http';
import { getRuntime } from '../../../../src/web/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/contacts/:id → ContactDetail, 404 for an unknown contact, 400 for an id that isn't a whole number.
export function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await params;
    if (!/^\d+$/.test(id)) throw new BadRequest(`id: expected a whole number, got "${id}"`);
    const detail = await contactDetail(getRuntime().pool, Number(id));
    return detail ?? Response.json({ error: 'contact not found' }, { status: 404 });
  });
}
