import pg from 'pg';

// One pool per connection URL, created on first use.
const pools = new Map<string, pg.Pool>();

export function getPool(url: string): pg.Pool {
  if (!url) throw new Error('getPool: database URL is empty');
  let pool = pools.get(url);
  if (!pool) {
    pool = new pg.Pool({ connectionString: url });
    pools.set(url, pool);
  }
  return pool;
}

// Ends every cached pool. Safe to call when none exist or more than once.
export async function closePool(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((pool) => pool.end()));
}
