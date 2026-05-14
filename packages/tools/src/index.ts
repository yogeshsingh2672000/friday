import { ToolRegistry } from '@friday/llm';
import type { VectorStore } from '@friday/memory';
import type { EventBus } from '@friday/shared';
import { buildSystemTools } from './system-tools.js';
import { buildMemoryTools } from './memory-tools.js';
import { buildWebTools } from './web-tools.js';
import { buildUITools, type UIEventMap } from './ui-tools.js';

export interface BuildRegistryOptions {
  store: VectorStore;
  uiBus: EventBus<UIEventMap>;
}

export function buildToolRegistry(opts: BuildRegistryOptions): ToolRegistry {
  const reg = new ToolRegistry();
  reg.registerAll(buildSystemTools());
  reg.registerAll(buildMemoryTools(opts.store));
  reg.registerAll(buildWebTools());
  reg.registerAll(buildUITools(opts.uiBus));
  return reg;
}

export * from './system-tools.js';
export * from './memory-tools.js';
export * from './web-tools.js';
export * from './ui-tools.js';
