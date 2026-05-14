import { nanoid } from 'nanoid';
import {
  EventBus,
  type FridayPhase,
  type FridayState,
  type ToolCallSummary,
} from '@friday/shared';

export interface StateEvents {
  state: FridayState;
  phase: { phase: FridayPhase; turnId: string | null };
}

const ALLOWED: Record<FridayPhase, FridayPhase[]> = {
  idle: ['listening', 'thinking', 'error'],
  listening: ['transcribing', 'idle', 'interrupted', 'error'],
  transcribing: ['thinking', 'idle', 'interrupted', 'error'],
  thinking: ['speaking', 'tool_calling', 'interrupted', 'idle', 'error'],
  tool_calling: ['thinking', 'speaking', 'interrupted', 'error'],
  speaking: ['idle', 'interrupted', 'listening', 'error'],
  interrupted: ['idle', 'listening', 'error'],
  error: ['idle', 'listening'],
};

/**
 * Centralised state for one client session. All phase transitions go through
 * `transition()` which enforces the legal graph above. Components subscribe
 * to `bus` for change notifications and never mutate state directly.
 */
export class FridayStateMachine {
  readonly bus = new EventBus<StateEvents>();
  private state: FridayState;

  constructor(sessionId?: string) {
    const now = Date.now();
    this.state = {
      phase: 'idle',
      sessionId: sessionId ?? nanoid(16),
      turnId: null,
      partialTranscript: '',
      finalTranscript: '',
      assistantText: '',
      toolCalls: [],
      audioLevel: 0,
      ttsLevel: 0,
      lastError: null,
      startedAt: now,
      updatedAt: now,
    };
  }

  snapshot(): FridayState {
    return { ...this.state, toolCalls: [...this.state.toolCalls] };
  }

  get phase(): FridayPhase {
    return this.state.phase;
  }

  get sessionId(): string {
    return this.state.sessionId;
  }

  startTurn(): string {
    const turnId = nanoid(12);
    this.mutate({
      turnId,
      partialTranscript: '',
      finalTranscript: '',
      assistantText: '',
      toolCalls: [],
      lastError: null,
    });
    return turnId;
  }

  /** Try to move to `next`. Throws if the transition isn't allowed. */
  transition(next: FridayPhase, reason?: string): void {
    const allowed = ALLOWED[this.state.phase] ?? [];
    if (!allowed.includes(next) && next !== this.state.phase) {
      throw new Error(
        `Illegal transition: ${this.state.phase} -> ${next}${reason ? ` (${reason})` : ''}`,
      );
    }
    if (next === this.state.phase) return;
    this.mutate({ phase: next });
    void this.bus.emit('phase', { phase: next, turnId: this.state.turnId });
  }

  appendPartialTranscript(text: string): void {
    this.mutate({ partialTranscript: text });
  }

  appendFinalTranscript(text: string): void {
    const next = (this.state.finalTranscript + ' ' + text).trim();
    this.mutate({ partialTranscript: '', finalTranscript: next });
  }

  appendAssistantText(delta: string): void {
    this.mutate({ assistantText: this.state.assistantText + delta });
  }

  upsertToolCall(t: ToolCallSummary): void {
    const idx = this.state.toolCalls.findIndex((x) => x.id === t.id);
    const next = [...this.state.toolCalls];
    if (idx >= 0) next[idx] = t;
    else next.push(t);
    this.mutate({ toolCalls: next });
  }

  setAudioLevel(level: number): void {
    if (Math.abs(this.state.audioLevel - level) > 0.01) this.mutate({ audioLevel: level });
  }

  setTtsLevel(level: number): void {
    if (Math.abs(this.state.ttsLevel - level) > 0.01) this.mutate({ ttsLevel: level });
  }

  setError(message: string | null): void {
    this.mutate({ lastError: message });
  }

  reset(): void {
    this.mutate({
      phase: 'idle',
      turnId: null,
      partialTranscript: '',
      finalTranscript: '',
      assistantText: '',
      toolCalls: [],
      lastError: null,
    });
    void this.bus.emit('phase', { phase: 'idle', turnId: null });
  }

  private mutate(patch: Partial<FridayState>): void {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() };
    void this.bus.emit('state', this.snapshot());
  }
}
