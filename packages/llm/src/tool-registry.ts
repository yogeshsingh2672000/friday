import { z, type ZodTypeAny } from 'zod';
import type { CancellationToken } from '@friday/shared';

export interface ToolContext {
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
  token: CancellationToken;
}

export interface ToolDefinition<I extends ZodTypeAny = ZodTypeAny, O = unknown> {
  name: string;
  description: string;
  /** Zod schema for tool inputs — also drives the JSON Schema sent to Claude. */
  input: I;
  /** Tags used by agents to filter which tools they expose. */
  tags?: string[];
  /** Run the tool. Throws / rejects on failure. */
  run(input: z.infer<I>, ctx: ToolContext): Promise<O>;
}

export type AnyToolDefinition = ToolDefinition<any, any>;

export interface AnthropicToolDescriptor {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Registry of tool implementations. Converts Zod schemas to JSON Schema for
 * Claude's tool_use API and dispatches tool calls by name with validation.
 */
export class ToolRegistry {
  private tools = new Map<string, AnyToolDefinition>();

  register(def: AnyToolDefinition): this {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, def);
    return this;
  }

  registerAll(defs: AnyToolDefinition[]): this {
    for (const d of defs) this.register(d);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(filter?: { tags?: string[]; names?: string[] }): AnyToolDefinition[] {
    let out = [...this.tools.values()];
    if (filter?.names) out = out.filter((t) => filter.names!.includes(t.name));
    if (filter?.tags) {
      out = out.filter((t) => (t.tags ?? []).some((tag) => filter.tags!.includes(tag)));
    }
    return out;
  }

  describe(filter?: { tags?: string[]; names?: string[] }): AnthropicToolDescriptor[] {
    return this.list(filter).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.input),
    }));
  }

  async invoke(
    name: string,
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
    const def = this.tools.get(name);
    if (!def) return { ok: false, error: `Unknown tool: ${name}` };
    const parsed = def.input.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok: false,
        error: `Invalid input: ${parsed.error.issues.map((i: { message: string }) => i.message).join('; ')}`,
      };
    }
    try {
      const output = await def.run(parsed.data, ctx);
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Minimal Zod -> JSON Schema (subset sufficient for Claude tool_use).
 * Supports object, string, number, boolean, array, enum, optional, default,
 * union, and nullable. Not a general-purpose converter.
 */
export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const def = (schema as any)._def;
  const typeName: string = def?.typeName;

  switch (typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const v = value as ZodTypeAny;
        properties[key] = zodToJsonSchema(v);
        if (!isOptional(v)) required.push(key);
      }
      const out: Record<string, unknown> = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      return out;
    }
    case 'ZodString': {
      const out: Record<string, unknown> = { type: 'string' };
      if (def.description) out.description = def.description;
      return out;
    }
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type) };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodLiteral':
      return { const: def.value };
    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodNullable':
      return zodToJsonSchema(def.innerType);
    case 'ZodUnion':
      return { anyOf: (def.options as ZodTypeAny[]).map(zodToJsonSchema) };
    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToJsonSchema(def.valueType) };
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    default:
      return {};
  }
}

function isOptional(s: ZodTypeAny): boolean {
  const def = (s as any)._def;
  return def?.typeName === 'ZodOptional' || def?.typeName === 'ZodDefault';
}

/**
 * Helper to define a tool with full type inference.
 */
export function defineTool<I extends ZodTypeAny, O>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return def;
}

export { z };
