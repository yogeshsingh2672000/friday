import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import { CancellationError, getLogger, type CancellationToken } from '@friday/shared';
import type { ToolRegistry, AnthropicToolDescriptor, ToolContext } from './tool-registry.js';

// Types come from the upstream Anthropic SDK — Bedrock SDK only swaps the
// transport. Request/response shapes are identical.
type MessageParam = Anthropic.MessageParam;
type TextBlock = Anthropic.TextBlock;
type ToolUseBlock = Anthropic.ToolUseBlock;
type ContentBlock = Anthropic.ContentBlock;

const log = getLogger('llm:claude');

export interface ClaudeClientOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  defaultModel: string;
  maxTokens?: number;
}

export interface StreamRunOptions {
  /** Conversation history (user + assistant turns). System lives separately. */
  messages: MessageParam[];
  /** Top-level system prompt. */
  system?: string;
  /** Model override for this run. */
  model?: string;
  /** Per-run max output tokens. */
  maxTokens?: number;
  /** Temperature (0..1). */
  temperature?: number;
  /** Tools available to Claude this run. */
  tools?: AnthropicToolDescriptor[];
  /** Registry used to dispatch tool_use blocks. Required if `tools` is set. */
  registry?: ToolRegistry;
  /** Tool execution context (session/turn IDs, signal). */
  toolContext?: Omit<ToolContext, 'signal'>;
  /** Hard cap on tool-use loops to prevent runaway recursion. */
  maxToolIterations?: number;
  /** Cancellation token — aborts the in-flight request and stops the loop. */
  token?: CancellationToken;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'text_done'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partialJson: string }
  | { type: 'tool_done'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; output: unknown; durationMs: number }
  | { type: 'iteration_end'; stopReason: string | null }
  | { type: 'message_complete'; finalText: string; usage: { input: number; output: number } }
  | { type: 'error'; error: Error };

export type StreamListener = (ev: StreamEvent) => void;

/**
 * Streaming Claude client with tool-use loop. On each Claude turn we stream
 * text deltas live. If Claude emits tool_use blocks, we execute them through
 * the registry, append `tool_result` blocks to the conversation, and continue
 * the loop until the model returns end_turn (or we hit `maxToolIterations`).
 *
 * Cancellation: token.cancel() aborts the in-flight stream and breaks the loop.
 */
export class ClaudeClient {
  private client: AnthropicBedrock;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;

  constructor(opts: ClaudeClientOptions) {
    if (!opts.accessKeyId || !opts.secretAccessKey) {
      throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for Bedrock.');
    }
    this.client = new AnthropicBedrock({
      awsRegion: opts.region,
      awsAccessKey: opts.accessKeyId,
      awsSecretKey: opts.secretAccessKey,
      awsSessionToken: opts.sessionToken,
    });
    this.defaultModel = opts.defaultModel;
    this.defaultMaxTokens = opts.maxTokens ?? 4096;
  }

  async *run(opts: StreamRunOptions): AsyncGenerator<StreamEvent, void, void> {
    const queue: StreamEvent[] = [];
    let waiter: ((ev: StreamEvent | null) => void) | null = null;
    let done = false;

    const push = (ev: StreamEvent) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(ev);
      } else {
        queue.push(ev);
      }
    };
    const finish = () => {
      done = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(null);
      }
    };

    this.runInternal(opts, push)
      .catch((err) => {
        if (err instanceof CancellationError) {
          push({ type: 'error', error: err });
        } else {
          const e = err instanceof Error ? err : new Error(String(err));
          log.error({ err: e }, 'claude run failed');
          push({ type: 'error', error: e });
        }
      })
      .finally(finish);

    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) return;
      const ev = await new Promise<StreamEvent | null>((resolve) => (waiter = resolve));
      if (ev) yield ev;
      else return;
    }
  }

  private async runInternal(opts: StreamRunOptions, push: (ev: StreamEvent) => void): Promise<void> {
    const {
      messages,
      system,
      model = this.defaultModel,
      maxTokens = this.defaultMaxTokens,
      temperature = 0.7,
      tools,
      registry,
      toolContext,
      maxToolIterations = 6,
      token,
    } = opts;

    if (tools?.length && !registry) {
      throw new Error('ToolRegistry is required when tools are provided.');
    }

    const conversation: MessageParam[] = [...messages];
    let lastUsage = { input: 0, output: 0 };
    let finalText = '';

    for (let iter = 0; iter < maxToolIterations; iter++) {
      token?.throwIfCancelled();

      const stream = this.client.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          temperature,
          system,
          messages: conversation,
          tools: tools as any,
        },
        { signal: token?.toAbortSignal() },
      );

      const partialText: string[] = [];
      const toolUses: Array<{ id: string; name: string; jsonChunks: string[] }> = [];
      let currentTool: { id: string; name: string; jsonChunks: string[] } | null = null;
      let currentTextActive = false;

      try {
        for await (const event of stream) {
          token?.throwIfCancelled();

          switch (event.type) {
            case 'content_block_start': {
              const block = event.content_block;
              if (block.type === 'text') {
                currentTextActive = true;
              } else if (block.type === 'tool_use') {
                currentTool = { id: block.id, name: block.name, jsonChunks: [] };
                toolUses.push(currentTool);
                push({ type: 'tool_start', id: block.id, name: block.name });
              }
              break;
            }
            case 'content_block_delta': {
              const delta = event.delta;
              if (delta.type === 'text_delta') {
                partialText.push(delta.text);
                push({ type: 'text_delta', text: delta.text });
              } else if (delta.type === 'input_json_delta' && currentTool) {
                currentTool.jsonChunks.push(delta.partial_json ?? '');
                push({ type: 'tool_input_delta', id: currentTool.id, partialJson: delta.partial_json ?? '' });
              }
              break;
            }
            case 'content_block_stop': {
              if (currentTextActive) {
                currentTextActive = false;
                push({ type: 'text_done', text: partialText.join('') });
              } else if (currentTool) {
                const raw = currentTool.jsonChunks.join('');
                let parsed: unknown = {};
                try {
                  parsed = raw ? JSON.parse(raw) : {};
                } catch (err) {
                  log.warn({ err, raw, tool: currentTool.name }, 'failed to parse tool input JSON');
                }
                push({ type: 'tool_done', id: currentTool.id, name: currentTool.name, input: parsed });
                currentTool = null;
              }
              break;
            }
            case 'message_delta': {
              if (event.usage) {
                lastUsage.output = event.usage.output_tokens ?? lastUsage.output;
              }
              break;
            }
          }
        }
      } catch (err) {
        if (token?.isCancelled) throw new CancellationError(token.reason);
        throw err;
      }

      const finalMessage = await stream.finalMessage();
      lastUsage = {
        input: finalMessage.usage.input_tokens,
        output: finalMessage.usage.output_tokens,
      };
      const stopReason = finalMessage.stop_reason ?? null;
      finalText = collectText(finalMessage.content);

      push({ type: 'iteration_end', stopReason });

      // No tool calls — done.
      if (stopReason !== 'tool_use' || toolUses.length === 0) break;

      // Append assistant message (text + tool_use blocks) to conversation.
      conversation.push({ role: 'assistant', content: finalMessage.content });

      // Execute every tool call in parallel, preserve order in results.
      if (!registry || !toolContext) {
        throw new Error('Registry and toolContext are required to resolve tool_use.');
      }
      const ctx: ToolContext = {
        ...toolContext,
        signal: token?.toAbortSignal() ?? new AbortController().signal,
      };

      const calls = toolUses.map(async (tu) => {
        const started = performance.now();
        const raw = tu.jsonChunks.join('');
        let input: unknown = {};
        try {
          input = raw ? JSON.parse(raw) : {};
        } catch {}
        const result = await registry.invoke(tu.name, input, ctx);
        const durationMs = Math.round(performance.now() - started);
        push({
          type: 'tool_result',
          id: tu.id,
          name: tu.name,
          ok: result.ok,
          output: result.ok ? result.output : result.error,
          durationMs,
        });
        return { tu, result };
      });

      const settled = await Promise.all(calls);
      const userToolResults: ContentBlock[] = settled.map(({ tu, result }) => ({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        is_error: !result.ok,
        content: stringifyToolOutput(result.ok ? result.output : result.error),
      })) as unknown as ContentBlock[];

      conversation.push({ role: 'user', content: userToolResults as any });
      // Loop again — Claude gets to react to tool results.
    }

    push({ type: 'message_complete', finalText, usage: lastUsage });
  }
}

function collectText(blocks: ContentBlock[]): string {
  let out = '';
  for (const b of blocks) {
    if (b.type === 'text') out += (b as TextBlock).text;
  }
  return out;
}

function stringifyToolOutput(out: unknown): string {
  if (typeof out === 'string') return out;
  try {
    return JSON.stringify(out, null, 2);
  } catch {
    return String(out);
  }
}

export type { MessageParam, ToolUseBlock, ContentBlock, TextBlock };
