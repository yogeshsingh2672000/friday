import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // AWS / Bedrock
  AWS_ACCESS_KEY_ID: z.string().default(''),
  AWS_SECRET_ACCESS_KEY: z.string().default(''),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_SESSION_TOKEN: z.string().optional(),

  BEDROCK_MODEL_ID: z.string().default('anthropic.claude-3-sonnet-20240229-v1:0'),
  BEDROCK_EMBEDDING_MODEL_ID: z.string().default('cohere.embed-multilingual-v3'),
  FRIDAY_MAX_TOKENS: z.coerce.number().int().positive().default(4096),

  DEEPGRAM_API_KEY: z.string().default(''),
  DEEPGRAM_MODEL: z.string().default('nova-2'),
  DEEPGRAM_LANGUAGE: z.string().default('en-US'),

  ELEVENLABS_API_KEY: z.string().default(''),
  ELEVENLABS_VOICE_ID: z.string().default('21m00Tcm4TlvDq8ikWAM'),
  ELEVENLABS_MODEL: z.string().default('eleven_turbo_v2_5'),
  // Set to 'true' to skip TTS entirely. Useful when ElevenLabs is out of
  // credits or you want a silent text-only experience.
  FRIDAY_DISABLE_TTS: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v)),

  PICOVOICE_ACCESS_KEY: z.string().default(''),
  PORCUPINE_KEYWORD: z.string().default('jarvis'),

  DATABASE_URL: z.string().default('postgres://friday:friday@localhost:5432/friday'),
  PGVECTOR_DIM: z.coerce.number().int().positive().default(1024),

  ORCHESTRATOR_HOST: z.string().default('127.0.0.1'),
  ORCHESTRATOR_PORT: z.coerce.number().int().positive().default(8787),

  FRIDAY_PREFERRED_DISPLAY: z.enum(['primary', 'secondary']).default('secondary'),
  FRIDAY_FULLSCREEN: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v)),
  FRIDAY_DEV_TOOLS: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v)),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetConfigForTest(): void {
  cached = null;
}
