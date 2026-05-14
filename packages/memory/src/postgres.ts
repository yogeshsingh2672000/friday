import pg from 'pg';
import { registerType } from 'pgvector/pg';
import { getLogger } from '@friday/shared';

const log = getLogger('memory:pg');

let pool: pg.Pool | null = null;
let vectorRegistered = false;

export function getPool(databaseUrl?: string): pg.Pool {
  if (pool) return pool;
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');

  pool = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => log.error({ err }, 'pg pool error'));

  pool.on('connect', async (client) => {
    if (!vectorRegistered) {
      try {
        await registerType(client);
        vectorRegistered = true;
      } catch (err) {
        // Expected the first time a fresh DB connects before CREATE EXTENSION
        // vector has run. The next connect after migration retries and wins.
        const msg = (err as Error)?.message ?? '';
        if (/vector type not found/i.test(msg)) {
          log.debug({ err }, 'pgvector type not yet present — will retry');
        } else {
          log.warn({ err }, 'pgvector registerType failed (will retry on next connect)');
        }
      }
    }
  });

  return pool;
}

export async function shutdownPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    vectorRegistered = false;
  }
}

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const p = getPool();
  return p.query<T>(text, params as any[]);
}
