import { defineTool, z, type AnyToolDefinition } from '@friday/llm';
import type { EventBus } from '@friday/shared';

export interface UIEventMap {
  'ui.show_card': { id: string; title: string; body: string; tone: 'info' | 'warn' | 'success' | 'error' };
  'ui.show_list': { id: string; title: string; items: string[] };
  'ui.show_image': { id: string; url: string; caption?: string };
  'ui.clear': { id?: string };
  'ui.scene_preset': { preset: 'calm' | 'alert' | 'focused' | 'celebrate' };
}

/**
 * Bridge between Claude tool_use and the renderer's holographic UI.
 * Each tool emits a UI event on the provided bus; the WS server forwards
 * matching events to the connected renderer for display.
 */
export function buildUITools(bus: EventBus<UIEventMap>): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'ui_show_card',
      description: 'Display a small information card on the holographic dashboard.',
      tags: ['ui'],
      input: z.object({
        title: z.string().max(80),
        body: z.string().max(800),
        tone: z.enum(['info', 'warn', 'success', 'error']).optional(),
      }),
      run: async ({ title, body, tone }, ctx) => {
        const id = `${ctx.turnId}:card:${Date.now()}`;
        await bus.emit('ui.show_card', { id, title, body, tone: tone ?? 'info' });
        return { displayed: true, id };
      },
    }),

    defineTool({
      name: 'ui_show_list',
      description: 'Display a bulleted list of short items on the dashboard.',
      tags: ['ui'],
      input: z.object({
        title: z.string().max(80),
        items: z.array(z.string().max(200)).min(1).max(20),
      }),
      run: async ({ title, items }, ctx) => {
        const id = `${ctx.turnId}:list:${Date.now()}`;
        await bus.emit('ui.show_list', { id, title, items });
        return { displayed: true, id, count: items.length };
      },
    }),

    defineTool({
      name: 'ui_show_image',
      description: 'Display an image (https URL) on the dashboard.',
      tags: ['ui'],
      input: z.object({
        url: z.string().url(),
        caption: z.string().max(200).optional(),
      }),
      run: async ({ url, caption }, ctx) => {
        const id = `${ctx.turnId}:img:${Date.now()}`;
        await bus.emit('ui.show_image', { id, url, caption });
        return { displayed: true, id };
      },
    }),

    defineTool({
      name: 'ui_set_scene',
      description: 'Switch the holographic scene mood. Use when the conversation tone shifts.',
      tags: ['ui'],
      input: z.object({ preset: z.enum(['calm', 'alert', 'focused', 'celebrate']) }),
      run: async ({ preset }) => {
        await bus.emit('ui.scene_preset', { preset });
        return { set: preset };
      },
    }),

    defineTool({
      name: 'ui_clear',
      description: 'Dismiss dashboard cards. Omit id to clear all.',
      tags: ['ui'],
      input: z.object({ id: z.string().optional() }),
      run: async ({ id }) => {
        await bus.emit('ui.clear', id ? { id } : {});
        return { cleared: true };
      },
    }),
  ];
}
