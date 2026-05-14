import type { FridayPhase, FridayState, ToolCallSummary, TranscriptSegment } from './types.js';

export type ClientToServer =
  | { type: 'client.hello'; clientId: string; capabilities: string[] }
  | { type: 'client.wake'; confidence: number; keyword: string }
  | { type: 'client.audio.start'; sampleRate: number; channels: number }
  | { type: 'client.audio.frame'; pcmBase64: string; seq: number; level: number }
  | { type: 'client.audio.end' }
  | { type: 'client.interrupt'; reason: 'user_voice' | 'manual' | 'wake' }
  | { type: 'client.text'; text: string }
  | { type: 'client.tts.ended'; turnId: string }
  | { type: 'client.ping'; ts: number }
  | { type: 'client.reset' };

export type ServerToClient =
  | { type: 'server.hello'; sessionId: string; serverTime: number }
  | { type: 'server.state'; state: FridayState }
  | { type: 'server.phase'; phase: FridayPhase; turnId: string | null }
  | { type: 'server.transcript'; segment: TranscriptSegment; turnId: string }
  | { type: 'server.assistant.delta'; text: string; turnId: string }
  | { type: 'server.assistant.message'; text: string; turnId: string }
  | { type: 'server.tool.update'; tool: ToolCallSummary; turnId: string }
  | { type: 'server.tts.start'; turnId: string; sampleRate: number; mime: string }
  | { type: 'server.tts.frame'; pcmBase64: string; seq: number; turnId: string }
  | { type: 'server.tts.end'; turnId: string }
  | { type: 'server.audio.level'; level: number }
  | { type: 'server.error'; message: string; recoverable: boolean }
  | { type: 'server.pong'; ts: number };

export type AnyEvent = ClientToServer | ServerToClient;

export function encodeEvent(ev: AnyEvent): string {
  return JSON.stringify(ev);
}

export function decodeEvent<T extends AnyEvent = AnyEvent>(raw: string | Buffer): T {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  return JSON.parse(text) as T;
}
