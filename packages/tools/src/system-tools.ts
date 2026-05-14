import { defineTool, z, type AnyToolDefinition } from '@friday/llm';

export function buildSystemTools(): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'get_current_time',
      description: 'Get the current local date and time.',
      tags: ['system', 'time'],
      input: z.object({
        timezone: z
          .string()
          .optional()
          .describe('IANA timezone name (e.g. America/Los_Angeles). Defaults to system local.'),
      }),
      run: async ({ timezone }) => {
        const now = new Date();
        const opts: Intl.DateTimeFormatOptions = {
          dateStyle: 'full',
          timeStyle: 'long',
        };
        if (timezone) opts.timeZone = timezone;
        return {
          iso: now.toISOString(),
          epochMs: now.getTime(),
          formatted: new Intl.DateTimeFormat('en-US', opts).format(now),
        };
      },
    }),

    defineTool({
      name: 'compute',
      description: 'Evaluate a safe arithmetic expression. Supports + - * / % ** and parentheses, plus Math.* functions.',
      tags: ['system', 'compute'],
      input: z.object({
        expression: z.string().describe('e.g. "(12 * 7) + Math.sqrt(81)"'),
      }),
      run: async ({ expression }) => {
        // Allow digits, whitespace, arithmetic operators, parens, dot, comma,
        // and ASCII letters (for Math.*). Disallow assignment, brackets,
        // semicolons, quotes, backticks — anything that could escape arithmetic.
        if (!/^[\d\s+\-*/%().,A-Za-z_]+$/.test(expression)) {
          throw new Error('Expression contains disallowed characters.');
        }
        // eslint-disable-next-line no-new-func
        const result = Function('Math', `"use strict"; return (${expression});`)(Math);
        if (typeof result !== 'number' || !Number.isFinite(result)) {
          throw new Error('Expression did not evaluate to a finite number.');
        }
        return { expression, result };
      },
    }),

    defineTool({
      name: 'system_info',
      description: 'Report basic host system information (platform, cpus, memory).',
      tags: ['system'],
      input: z.object({}).strict(),
      run: async () => {
        const os = await import('node:os');
        return {
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          cpus: os.cpus().length,
          totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
          freeMemGB: +(os.freemem() / 1024 ** 3).toFixed(1),
          uptimeMin: Math.round(os.uptime() / 60),
        };
      },
    }),
  ];
}
