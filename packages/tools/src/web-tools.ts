import { defineTool, z, type AnyToolDefinition } from '@friday/llm';

export function buildWebTools(): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'http_get',
      description: 'Perform an HTTP GET against a public URL and return the response (truncated). Use for fetching status pages, JSON APIs, or text content. Do NOT use for actions that mutate state.',
      tags: ['web'],
      input: z.object({
        url: z.string().url(),
        accept: z.string().optional().describe('e.g. "application/json"'),
        maxBytes: z.number().int().min(1024).max(200_000).optional(),
      }),
      run: async ({ url, accept, maxBytes }, ctx) => {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error(`Disallowed protocol: ${parsed.protocol}`);
        }
        const cap = maxBytes ?? 50_000;
        const controller = new AbortController();
        const onCancel = ctx.token.onCancel(() => controller.abort());
        const timeout = setTimeout(() => controller.abort(new Error('timeout')), 15_000);
        try {
          const res = await fetch(url, {
            signal: controller.signal,
            headers: accept ? { accept } : undefined,
          });
          const reader = res.body?.getReader();
          if (!reader) throw new Error('No response body');
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            chunks.push(value);
            total += value.byteLength;
            if (total >= cap) {
              try {
                await reader.cancel();
              } catch {}
              break;
            }
          }
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.byteLength;
          }
          const text = new TextDecoder().decode(merged);
          return {
            status: res.status,
            contentType: res.headers.get('content-type') ?? '',
            bytes: total,
            truncated: total >= cap,
            body: text,
          };
        } finally {
          clearTimeout(timeout);
          onCancel();
        }
      },
    }),
  ];
}
