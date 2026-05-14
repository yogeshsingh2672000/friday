import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus, getLogger, loadConfig } from '@friday/shared';

// Locate the workspace `.env` by walking up from this source file. We can't
// rely on `dotenv/config` alone because pnpm sets cwd to apps/orchestrator/
// when running this script via the `dev` task, so the root `.env` is missed.
function loadWorkspaceEnv(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 12; i++) {
    const envPath = join(cur, '.env');
    if (existsSync(envPath)) {
      dotenvConfig({ path: envPath });
      return envPath;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Fall back to default dotenv behaviour (cwd) as a last resort.
  dotenvConfig();
  return null;
}

const loadedEnvPath = loadWorkspaceEnv();
import { AgentRouter, ClaudeClient } from '@friday/llm';
import {
  ConversationSummariser,
  VectorStore,
  createEmbeddingProvider,
  shutdownPool,
} from '@friday/memory';
import { buildToolRegistry, type UIEventMap } from '@friday/tools';
import { FridayStateMachine } from './state-machine.js';
import { InterruptionManager } from './interruption.js';
import { Pipeline, type PipelineEvents } from './pipeline.js';
import { WSServer } from './ws-server.js';
import { LifecycleManager } from './lifecycle.js';

const log = getLogger('orchestrator');

async function main() {
  const cfg = loadConfig();
  log.info(
    {
      envFile: loadedEnvPath ?? '(none — relying on process env)',
      model: cfg.BEDROCK_MODEL_ID,
      region: cfg.AWS_REGION,
      port: cfg.ORCHESTRATOR_PORT,
      host: cfg.ORCHESTRATOR_HOST,
    },
    'starting Friday orchestrator',
  );

  // Verify critical secrets up-front for a fast failure with a clear message.
  // ELEVENLABS_API_KEY is optional now — pipeline falls back to text-only.
  const required: Array<[string, string]> = [
    ['AWS_ACCESS_KEY_ID', cfg.AWS_ACCESS_KEY_ID],
    ['AWS_SECRET_ACCESS_KEY', cfg.AWS_SECRET_ACCESS_KEY],
    ['DEEPGRAM_API_KEY', cfg.DEEPGRAM_API_KEY],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    log.error({ missing }, 'missing required env vars — copy .env.example to .env and fill them');
    process.exit(1);
  }
  if (!cfg.ELEVENLABS_API_KEY) {
    log.warn('ELEVENLABS_API_KEY not set — running in text-only mode (no spoken responses)');
  } else if (cfg.FRIDAY_DISABLE_TTS) {
    log.info('FRIDAY_DISABLE_TTS=true — running in text-only mode (no spoken responses)');
  }

  const lifecycle = new LifecycleManager();
  lifecycle.attach();

  const bedrockCreds = {
    region: cfg.AWS_REGION,
    accessKeyId: cfg.AWS_ACCESS_KEY_ID,
    secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY,
    sessionToken: cfg.AWS_SESSION_TOKEN,
  };

  // Memory.
  const embedder = createEmbeddingProvider({
    ...bedrockCreds,
    modelId: cfg.BEDROCK_EMBEDDING_MODEL_ID,
  });
  const store = new VectorStore({ embedder });
  const dbOk = await store.ping();
  if (!dbOk) {
    log.warn(
      'postgres ping failed — memory tools will return errors at call time. ' +
        'Run `pnpm migrate` (creates the database + schema), or `pnpm db:up && pnpm migrate` for the bundled docker postgres.',
    );
  }

  // Claude + router (both backed by the same Bedrock-hosted Sonnet 3).
  const claude = new ClaudeClient({
    ...bedrockCreds,
    defaultModel: cfg.BEDROCK_MODEL_ID,
    maxTokens: cfg.FRIDAY_MAX_TOKENS,
  });
  const router = new AgentRouter({
    ...bedrockCreds,
    model: cfg.BEDROCK_MODEL_ID,
  });
  const summariser = new ConversationSummariser({
    ...bedrockCreds,
    model: cfg.BEDROCK_MODEL_ID,
    store,
  });

  // Buses + tools + state.
  const uiBus = new EventBus<UIEventMap>();
  const pipelineBus = new EventBus<PipelineEvents>();
  const registry = buildToolRegistry({ store, uiBus });
  const state = new FridayStateMachine();
  const interrupts = new InterruptionManager();

  // Pipeline.
  const pipeline = new Pipeline({
    state,
    interrupts,
    bus: pipelineBus,
    registry,
    store,
    summariser,
    claude,
    router,
    deepgramApiKey: cfg.DEEPGRAM_API_KEY,
    deepgramModel: cfg.DEEPGRAM_MODEL,
    deepgramLanguage: cfg.DEEPGRAM_LANGUAGE,
    elevenLabsApiKey: cfg.ELEVENLABS_API_KEY,
    elevenLabsVoiceId: cfg.ELEVENLABS_VOICE_ID,
    elevenLabsModel: cfg.ELEVENLABS_MODEL,
    disableTts: cfg.FRIDAY_DISABLE_TTS || !cfg.ELEVENLABS_API_KEY,
    bedrockModelId: cfg.BEDROCK_MODEL_ID,
    maxTokens: cfg.FRIDAY_MAX_TOKENS,
  });

  // WS server.
  const ws = new WSServer({
    host: cfg.ORCHESTRATOR_HOST,
    port: cfg.ORCHESTRATOR_PORT,
    state,
    pipeline,
    pipelineBus,
    uiBus,
  });
  await ws.start();

  lifecycle.register(async () => {
    await pipeline.shutdown();
    await ws.stop();
    await shutdownPool();
  });

  log.info({ port: cfg.ORCHESTRATOR_PORT }, 'Friday is live — say the wake word in the renderer');
}

main().catch((err) => {
  log.error({ err }, 'fatal');
  process.exit(1);
});
