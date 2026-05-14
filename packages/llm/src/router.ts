import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { getLogger } from '@friday/shared';
import { AGENTS, type AgentId } from './agents.js';

const log = getLogger('llm:router');

export interface RouterDecision {
  agent: AgentId;
  reason: string;
  confidence: number;
}

export interface RouterOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Bedrock model id for routing. Same Sonnet as primary by default. */
  model: string;
}

const SCHEMA = {
  name: 'choose_agent',
  description: 'Choose the best specialist agent for the user request.',
  input_schema: {
    type: 'object' as const,
    properties: {
      agent: {
        type: 'string',
        enum: Object.keys(AGENTS),
        description: 'The id of the agent to handle this turn.',
      },
      reason: { type: 'string', description: 'One-line justification.' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['agent', 'reason', 'confidence'],
  },
};

const SYSTEM = `You are Friday's request router. Read the most recent user message and decide which specialist should handle it.

Agents:
- orchestrator: default for general dialogue, light Q&A, system commands.
- intelligence: deep reasoning, planning, multi-step problems, code/architecture, research.
- memory: explicit "remember this", "what did I say about X", "forget X".
- voice: pure text-to-speech rewriting (rare; usually used internally, not direct routing).
- ui: explicit requests to show / display / chart / open a panel.

Pick orchestrator if uncertain. Confidence reflects how sure you are, not how confident the eventual answer will be.`;

/**
 * Lightweight intent router using a tool_choice-forced Claude call.
 * Always returns a valid AgentId — falls back to orchestrator on any failure.
 */
export class AgentRouter {
  private client: AnthropicBedrock;
  private readonly model: string;

  constructor(opts: RouterOptions) {
    this.client = new AnthropicBedrock({
      awsRegion: opts.region,
      awsAccessKey: opts.accessKeyId,
      awsSecretKey: opts.secretAccessKey,
      awsSessionToken: opts.sessionToken,
    });
    this.model = opts.model;
  }

  async route(userText: string, signal?: AbortSignal): Promise<RouterDecision> {
    if (!userText || userText.trim().length === 0) {
      return { agent: 'orchestrator', reason: 'empty input', confidence: 1 };
    }
    try {
      const resp = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 200,
          system: SYSTEM,
          tools: [SCHEMA] as any,
          tool_choice: { type: 'tool', name: 'choose_agent' },
          messages: [{ role: 'user', content: userText }],
        },
        { signal },
      );
      const toolBlock = resp.content.find((b: { type: string }) => b.type === 'tool_use');
      if (toolBlock && toolBlock.type === 'tool_use') {
        const input = (toolBlock as { input: Partial<RouterDecision> }).input;
        if (input.agent && input.agent in AGENTS) {
          return {
            agent: input.agent,
            reason: input.reason ?? '',
            confidence: clamp01(input.confidence ?? 0.6),
          };
        }
      }
    } catch (err) {
      log.warn({ err }, 'routing failed; falling back to orchestrator');
    }
    return { agent: 'orchestrator', reason: 'fallback', confidence: 0.4 };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
