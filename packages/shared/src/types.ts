export type FridayPhase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'tool_calling'
  | 'speaking'
  | 'interrupted'
  | 'error';

export interface FridayState {
  phase: FridayPhase;
  sessionId: string;
  turnId: string | null;
  partialTranscript: string;
  finalTranscript: string;
  assistantText: string;
  toolCalls: ToolCallSummary[];
  audioLevel: number;
  ttsLevel: number;
  lastError: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface ToolCallSummary {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'error';
  inputPreview?: string;
  outputPreview?: string;
  durationMs?: number;
}

export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: 16;
  encoding: 'pcm_s16le';
}

export const DEFAULT_AUDIO_FORMAT: AudioFormat = {
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  encoding: 'pcm_s16le',
};

export const TTS_AUDIO_FORMAT: AudioFormat = {
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
  encoding: 'pcm_s16le',
};

export interface TranscriptSegment {
  text: string;
  isFinal: boolean;
  confidence: number;
  startMs: number;
  endMs: number;
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
}

export interface MemoryRecord {
  id: string;
  sessionId: string;
  text: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
  createdAt: number;
}
