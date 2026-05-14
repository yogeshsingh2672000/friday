/**
 * Idempotent schema migration. Run with `pnpm migrate` (from repo root).
 *
 *   1. If the target database in DATABASE_URL doesn't exist, create it by
 *      connecting to the cluster's default `postgres` db first.
 *   2. CREATE EXTENSION vector
 *   3. CREATE TABLE memories + indexes
 */
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getLogger, loadConfig } from '@friday/shared';
import { getPool, query, shutdownPool } from './postgres.js';

// Locate the workspace `.env` by walking up from this file — `pnpm --filter`
// sets cwd to the package directory, so dotenv's default cwd lookup misses
// the root `.env`.
function loadWorkspaceEnv(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 12; i++) {
    const envPath = join(cur, '.env');
    if (existsSync(envPath)) {
      dotenvConfig({ path: envPath });
      return envPath;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  dotenvConfig();
  return null;
}

const loadedEnvPath = loadWorkspaceEnv();

const log = getLogger('memory:migrate');

async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!dbName) throw new Error('DATABASE_URL has no database name in the path.');

  // Try a probe connection to the target DB. If it succeeds, nothing to do.
  const probe = new pg.Client({ connectionString: databaseUrl });
  try {
    await probe.connect();
    await probe.end();
    return;
  } catch (err) {
    const msg = (err as Error).message || '';
    if (!/database .* does not exist/i.test(msg) && (err as any).code !== '3D000') {
      // Not a missing-db error — let the caller see it.
      throw err;
    }
  }

  log.warn({ db: dbName }, 'target database missing — creating it');

  // Reconnect to the cluster's default `postgres` db to issue CREATE DATABASE.
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    // Identifiers can't be parameterised — sanitise: allow only [A-Za-z0-9_-].
    if (!/^[A-Za-z0-9_-]+$/.test(dbName)) {
      throw new Error(`Refusing to CREATE DATABASE for unsafe name: ${dbName}`);
    }
    await admin.query(`CREATE DATABASE "${dbName}"`);
    log.info({ db: dbName }, 'database created');
  } finally {
    await admin.end();
  }
}

async function main() {
  const cfg = loadConfig();
  // Strip the password before logging so we can confirm which connection
  // string we're actually using without leaking creds to the console.
  const safeUrl = cfg.DATABASE_URL.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@');
  log.info({ envFile: loadedEnvPath ?? '(none — cwd fallback)', target: safeUrl }, 'migrate start');
  await ensureDatabaseExists(cfg.DATABASE_URL);

  // Force pool creation against configured URL.
  getPool(cfg.DATABASE_URL);

  log.info('ensuring vector extension');
  await query(`CREATE EXTENSION IF NOT EXISTS vector`);

  const dim = cfg.PGVECTOR_DIM;
  log.info({ dim }, 'creating memories table');
  await query(`
    CREATE TABLE IF NOT EXISTS memories (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      text        TEXT NOT NULL,
      embedding   vector(${dim}) NOT NULL,
      metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS memories_session_idx ON memories (session_id)`);
  await query(`CREATE INDEX IF NOT EXISTS memories_created_idx ON memories (created_at DESC)`);

  // IVFFlat index for ANN search. lists=100 is a sane default for <1M rows.
  try {
    await query(`
      CREATE INDEX IF NOT EXISTS memories_embedding_idx
        ON memories USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
    `);
  } catch (err) {
    log.warn({ err }, 'ivfflat index creation skipped (will use seq scan)');
  }

  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      label       TEXT,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at    TIMESTAMPTZ
    )
  `);

  log.info('migration complete');
}

main()
  .catch((err) => {
    log.error({ err }, 'migration failed');
    process.exitCode = 1;
  })
  .finally(() => shutdownPool());
