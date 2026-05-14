import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { getLogger } from '@friday/shared';

const log = getLogger('memory:embed');

export interface EmbeddingProvider {
  readonly dim: number;
  /**
   * Embed an array of texts. `inputType` is Cohere-specific:
   *   "search_document" — when storing items for later retrieval (default)
   *   "search_query"    — when embedding a query against stored documents
   *   "classification" / "clustering" — task-specific variants
   */
  embed(
    texts: string[],
    inputType?: 'search_document' | 'search_query' | 'classification' | 'clustering',
  ): Promise<number[][]>;
}

export interface BedrockCohereOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  modelId?: string;
  /** Truncation strategy when input exceeds 512 tokens. */
  truncate?: 'NONE' | 'START' | 'END';
}

/**
 * Cohere multilingual v3 embeddings via AWS Bedrock.
 * Produces 1024-dim float vectors; supports 100+ languages.
 *
 * Bedrock API reference:
 *   model_id:    cohere.embed-multilingual-v3
 *   request:     { texts: string[], input_type: string, truncate?: string }
 *   response:    { embeddings: number[][], id: string, response_type: string }
 */
export class BedrockCohereEmbeddings implements EmbeddingProvider {
  readonly dim = 1024;
  private client: BedrockRuntimeClient;
  private readonly modelId: string;
  private readonly truncate: 'NONE' | 'START' | 'END';

  constructor(opts: BedrockCohereOptions) {
    if (!opts.accessKeyId || !opts.secretAccessKey) {
      throw new Error('AWS credentials required for Bedrock embeddings.');
    }
    this.client = new BedrockRuntimeClient({
      region: opts.region,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        sessionToken: opts.sessionToken,
      },
    });
    this.modelId = opts.modelId ?? 'cohere.embed-multilingual-v3';
    this.truncate = opts.truncate ?? 'END';
  }

  async embed(
    texts: string[],
    inputType: 'search_document' | 'search_query' | 'classification' | 'clustering' = 'search_document',
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Cohere caps batches at 96 inputs per call; chunk if needed.
    const CHUNK = 96;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += CHUNK) {
      const batch = texts.slice(i, i + CHUNK);
      const cmd = new InvokeModelCommand({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          texts: batch,
          input_type: inputType,
          truncate: this.truncate,
        }),
      });
      const res = await this.client.send(cmd);
      const text = new TextDecoder().decode(res.body as Uint8Array);
      const parsed = JSON.parse(text) as { embeddings: number[][] };
      if (!Array.isArray(parsed.embeddings)) {
        throw new Error(`Bedrock embeddings: unexpected response shape: ${text.slice(0, 200)}`);
      }
      for (const v of parsed.embeddings) out.push(v);
    }
    return out;
  }
}

export interface CreateEmbedderOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  modelId?: string;
}

export function createEmbeddingProvider(opts: CreateEmbedderOptions): EmbeddingProvider {
  log.info({ modelId: opts.modelId, region: opts.region }, 'using Bedrock Cohere embeddings');
  return new BedrockCohereEmbeddings(opts);
}
