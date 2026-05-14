import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { getLogger, type AgentMessage } from '@friday/shared';
import type { VectorStore } from './vector-store.js';

const log = getLogger('memory:summary');

export interface SummariserOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  model: string;
  store: VectorStore;
  /** Number of turns to keep before summarising the oldest half. */
  bufferTurns?: number;
}

const SYSTEM = `You are Friday's memory compactor. Given a slice of conversation, produce 1-3 declarative facts the assistant should remember long-term. Format each fact on its own line, no bullets, no preamble. Skip pleasantries and meta-commentary. If nothing is worth remembering, reply with the single word: NONE.`;

/**
 * Rolling-window conversation summariser. Holds the most recent `bufferTurns`
 * turns verbatim; older turns are summarised by Claude into 1-3 fact lines
 * and inserted into the vector store. Keeps context bounded and creates
 * retrievable long-term memory in the same pass.
 */
export class ConversationSummariser {
  private client: AnthropicBedrock;
  private readonly model: string;
  private readonly bufferTurns: number;
  private store: VectorStore;

  constructor(opts: SummariserOptions) {
    this.client = new AnthropicBedrock({
      awsRegion: opts.region,
      awsAccessKey: opts.accessKeyId,
      awsSecretKey: opts.secretAccessKey,
      awsSessionToken: opts.sessionToken,
    });
    this.model = opts.model;
    this.bufferTurns = opts.bufferTurns ?? 12;
    this.store = opts.store;
  }

  shouldCompact(history: AgentMessage[]): boolean {
    return history.length > this.bufferTurns * 1.5;
  }

  async compact(sessionId: string, history: AgentMessage[]): Promise<AgentMessage[]> {
    if (!this.shouldCompact(history)) return history;
    const dropCount = history.length - this.bufferTurns;
    const toSummarise = history.slice(0, dropCount);
    const keep = history.slice(dropCount);

    const slice = toSummarise.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n');

    try {
      const resp = await this.client.messages.create({
        model: this.model,
        max_tokens: 300,
        system: SYSTEM,
        messages: [{ role: 'user', content: slice }],
      });
      const text = resp.content
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { type: string; text?: string }) => b.text ?? '')
        .join('\n')
        .trim();
      if (text && text.toUpperCase() !== 'NONE') {
        const facts = text
          .split(/\n+/)
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0);
        for (const fact of facts) {
          await this.store.save({
            sessionId,
            text: fact,
            metadata: { kind: 'summary', source: 'auto' },
          });
        }
        log.info({ facts: facts.length }, 'compacted history into memory');
      }
    } catch (err) {
      log.warn({ err }, 'summariser call failed — keeping full history');
      return history;
    }

    return keep;
  }
}
