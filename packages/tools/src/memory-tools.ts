import { defineTool, z, type AnyToolDefinition } from '@friday/llm';
import type { VectorStore } from '@friday/memory';

export function buildMemoryTools(store: VectorStore): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'memory_remember',
      description: 'Store a fact in long-term memory. Use sparingly — only for things the user explicitly wants remembered or that are clearly persistent context (name, preferences, ongoing projects).',
      tags: ['memory'],
      input: z.object({
        fact: z.string().min(2).describe('The declarative fact to remember.'),
        tag: z.string().optional().describe('Optional category tag.'),
      }),
      run: async ({ fact, tag }, ctx) => {
        const rec = await store.save({
          sessionId: ctx.sessionId,
          text: fact,
          metadata: tag ? { tag } : {},
        });
        return { ok: true, id: rec.id };
      },
    }),

    defineTool({
      name: 'memory_recall',
      description: 'Search long-term memory by semantic similarity. Returns up to `limit` most relevant facts.',
      tags: ['memory'],
      input: z.object({
        query: z.string().describe('Free text query.'),
        limit: z.number().int().min(1).max(20).optional(),
        scopeToSession: z.boolean().optional().describe('If true, only search the current session.'),
      }),
      run: async ({ query, limit, scopeToSession }, ctx) => {
        const hits = await store.search(query, {
          limit: limit ?? 5,
          sessionId: scopeToSession ? ctx.sessionId : undefined,
        });
        return hits.map((h) => ({ text: h.text, score: +h.score.toFixed(3), createdAt: h.createdAt }));
      },
    }),

    defineTool({
      name: 'memory_forget',
      description: 'Delete a specific memory by id. Use after a memory_recall to remove obsolete facts.',
      tags: ['memory'],
      input: z.object({ id: z.string() }),
      run: async ({ id }) => {
        const ok = await store.delete(id);
        return { ok };
      },
    }),

    defineTool({
      name: 'memory_list_recent',
      description: 'List the most recent memories for the current session.',
      tags: ['memory'],
      input: z.object({ limit: z.number().int().min(1).max(50).optional() }),
      run: async ({ limit }, ctx) => {
        const items = await store.list(ctx.sessionId, limit ?? 10);
        return items.map((m) => ({ id: m.id, text: m.text, createdAt: m.createdAt }));
      },
    }),
  ];
}
