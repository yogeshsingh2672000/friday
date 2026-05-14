import { nanoid } from 'nanoid';
import { toSql as vectorToSql } from 'pgvector/pg';
import { getLogger, type MemoryRecord } from '@friday/shared';
import { getPool, query } from './postgres.js';
import type { EmbeddingProvider } from './embeddings.js';

const log = getLogger('memory:vec');

export interface StoreOptions {
  embedder: EmbeddingProvider;
}

export interface SaveInput {
  sessionId: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  sessionId?: string;
  limit?: number;
  /** Cosine distance threshold (0..2). Lower = stricter. */
  threshold?: number;
}

export interface SearchHit extends MemoryRecord {
  score: number;
}

export class VectorStore {
  constructor(private readonly opts: StoreOptions) {}

  async save(input: SaveInput): Promise<MemoryRecord> {
    const [embedding] = await this.opts.embedder.embed([input.text]);
    if (!embedding) throw new Error('Embedding failed');
    const id = nanoid(16);
    const metadata = input.metadata ?? {};
    const now = Date.now();
    await query(
      `INSERT INTO memories (id, session_id, text, embedding, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))`,
      [id, input.sessionId, input.text, vectorToSql(embedding), metadata, now],
    );
    return {
      id,
      sessionId: input.sessionId,
      text: input.text,
      metadata,
      createdAt: now,
    };
  }

  async search(qText: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const [vec] = await this.opts.embedder.embed([qText]);
    if (!vec) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 8, 32));
    const filters: string[] = [];
    const params: unknown[] = [vectorToSql(vec)];
    if (opts.sessionId) {
      params.push(opts.sessionId);
      filters.push(`session_id = $${params.length}`);
    }
    if (typeof opts.threshold === 'number') {
      params.push(opts.threshold);
      filters.push(`(embedding <=> $1) <= $${params.length}`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    params.push(limit);
    const sql = `
      SELECT id, session_id, text, metadata,
             EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms,
             (embedding <=> $1) AS distance
        FROM memories
        ${where}
        ORDER BY embedding <=> $1
        LIMIT $${params.length}
    `;
    const res = await query<{
      id: string;
      session_id: string;
      text: string;
      metadata: Record<string, unknown>;
      created_at_ms: string;
      distance: string;
    }>(sql, params);
    return res.rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      text: r.text,
      metadata: r.metadata,
      createdAt: Number(r.created_at_ms),
      score: 1 - Number(r.distance),
    }));
  }

  async delete(id: string): Promise<boolean> {
    const res = await query(`DELETE FROM memories WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async deleteSession(sessionId: string): Promise<number> {
    const res = await query(`DELETE FROM memories WHERE session_id = $1`, [sessionId]);
    return res.rowCount ?? 0;
  }

  async list(sessionId: string, limit = 50): Promise<MemoryRecord[]> {
    const res = await query<{
      id: string;
      session_id: string;
      text: string;
      metadata: Record<string, unknown>;
      created_at_ms: string;
    }>(
      `SELECT id, session_id, text, metadata,
              EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms
         FROM memories
        WHERE session_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [sessionId, limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      text: r.text,
      metadata: r.metadata,
      createdAt: Number(r.created_at_ms),
    }));
  }

  async ping(): Promise<boolean> {
    try {
      await getPool().query('SELECT 1');
      return true;
    } catch (err) {
      log.error({ err }, 'pg ping failed');
      return false;
    }
  }
}
