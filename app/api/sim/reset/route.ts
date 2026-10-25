import { handle } from '../../../../src/web/http';
import { getRuntime } from '../../../../src/web/runtime';
import { simReset } from '../../../../src/web/sim';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/sim/reset → { contacts }: resetDb (keeping saved AI answers) then seed, under the sim lock.
export function POST(): Promise<Response> {
  return handle(async () => {
    const { pool, config } = getRuntime();
    return simReset(pool, config);
  });
}
