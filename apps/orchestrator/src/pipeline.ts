import type Anthropic from '@anthropic-ai/sdk';
import { nanoid } from 'nanoid';

type MessageParam = Anthropic.MessageParam;
import {
  CancellationError,
  EventBus,
  getLogger,
  type AgentMessage,
  type CancellationToken,
  type ToolCallSummary,
} from '@friday/shared';
import { DeepgramSession } from '@friday/stt';
import {
  AGENTS,
  AgentRouter,
  ClaudeClient,
  buildSystem,
  type AgentId,
  type StreamEvent,
  type ToolRegistry,
} from '@friday/llm';
import { ElevenLabsTTSSession } from '@friday/tts';
import { ConversationSummariser, VectorStore } from '@friday/memory';
import type { FridayStateMachine } from './state-machine.js';
import type { InterruptionManager } from './interruption.js';

const log = getLogger('orchestrator:pipeline');

export interface PipelineEvents {
  'stt.partial': { turnId: string; text: string };
  'stt.final': { turnId: string; text: string };
  'stt.endpoint': { turnId: string };
  'agent.route': { turnId: string; agent: AgentId; reason: string };
  'assistant.delta': { turnId: string; text: string };
  'assistant.done': { turnId: string; text: string };
  'tool.update': { turnId: string; tool: ToolCallSummary };
  'tts.start': { turnId: string; sampleRate: number };
  'tts.frame': { turnId: string; pcm: Int16Array };
  'tts.end': { turnId: string };
  'pipeline.error': { error: Error; recoverable: boolean };
}

export interface PipelineConfig {
  state: FridayStateMachine;
  interrupts: InterruptionManager;
  bus: EventBus<PipelineEvents>;
  registry: ToolRegistry;
  store: VectorStore;
  summariser: ConversationSummariser;
  claude: ClaudeClient;
  router: AgentRouter;
  deepgramApiKey: string;
  deepgramModel: string;
  deepgramLanguage: string;
  elevenLabsApiKey: string;
  elevenLabsVoiceId: string;
  elevenLabsModel: string;
  /** When true, the pipeline skips ElevenLabs entirely and runs text-only. */
  disableTts: boolean;
  /** Single Bedrock model used by every agent. */
  bedrockModelId: string;
  maxTokens: number;
}

interface ActiveTurn {
  turnId: string;
  token: CancellationToken;
  stt: DeepgramSession;
  tts: ElevenLabsTTSSession | null;
  finalText: string;
  partialText: string;
  llmStarted: boolean;
  llmFinished: boolean;
  endpointFired: boolean;
}

/**
 * Realtime pipeline coordinator. One Pipeline instance per session (one
 * connected renderer). Holds long-lived Deepgram + ElevenLabs sessions per
 * turn, drives Claude streaming, applies interruption uniformly across all
 * components.
 */
export class Pipeline {
  private history: AgentMessage[] = [];
  private active: ActiveTurn | null = null;

  constructor(private readonly cfg: PipelineConfig) {}

  get currentTurn(): ActiveTurn | null {
    return this.active;
  }

  /**
   * Begin a new turn — called when the wake word fires on the client. Opens
   * a Deepgram session and arms cancellation. Audio frames must be pushed
   * via `pushAudio()` afterwards.
   */
  async beginTurn(): Promise<string> {
    if (this.active) {
      // Already a turn in flight — interrupt it cleanly first.
      await this.interrupt('manual');
    }

    const turnId = this.cfg.state.startTurn();
    const token = this.cfg.interrupts.arm(turnId);

    // After an interrupt the state should be idle; if it isn't (e.g. an
    // error phase), force it back so the transition to listening is legal.
    if (this.cfg.state.phase !== 'idle') {
      this.cfg.state.reset();
      this.cfg.state.startTurn();
    }
    this.cfg.state.transition('listening', 'turn begin');

    const stt = new DeepgramSession({
      apiKey: this.cfg.deepgramApiKey,
      model: this.cfg.deepgramModel,
      language: this.cfg.deepgramLanguage,
      sampleRate: 16000,
      interimResults: true,
      smartFormat: true,
      vadEvents: true,
      utteranceEndMs: 1000,
      endpointingMs: 250,
    });

    this.active = {
      turnId,
      token,
      stt,
      tts: null,
      finalText: '',
      partialText: '',
      llmStarted: false,
      llmFinished: false,
      endpointFired: false,
    };

    stt.on(async (ev) => {
      if (!this.active || this.active.turnId !== turnId) return;
      switch (ev.type) {
        case 'transcript': {
          if (ev.segment.isFinal) {
            this.active.finalText = (this.active.finalText + ' ' + ev.segment.text).trim();
            this.active.partialText = '';
            this.cfg.state.appendFinalTranscript(ev.segment.text);
            await this.cfg.bus.emit('stt.final', { turnId, text: ev.segment.text });
          } else {
            this.active.partialText = ev.segment.text;
            this.cfg.state.appendPartialTranscript(ev.segment.text);
            await this.cfg.bus.emit('stt.partial', { turnId, text: ev.segment.text });
          }
          break;
        }
        case 'utterance_end': {
          this.handleEndpoint(turnId).catch((err) => log.error({ err }, 'endpoint handler failed'));
          break;
        }
        case 'error': {
          this.cfg.state.setError(ev.error.message);
          await this.cfg.bus.emit('pipeline.error', { error: ev.error, recoverable: true });
          break;
        }
      }
    });

    try {
      await stt.open(token);
      // If the turn was cancelled / ended while we were awaiting STT (a fast
      // double-tap of the Wake button is the common case), bail out — the
      // state machine has already moved back to `idle` and a forced
      // `transcribing` transition would throw.
      if (!this.active || this.active.turnId !== turnId || token.isCancelled) {
        try {
          await stt.close();
        } catch {}
        return turnId;
      }
      if (this.cfg.state.phase === 'listening') {
        this.cfg.state.transition('transcribing', 'stt open');
      }
    } catch (err) {
      if (token.isCancelled) {
        // Cancellation isn't an error worth surfacing — the orchestrator
        // already moved on. Just clean up STT.
        try {
          await stt.close();
        } catch {}
        return turnId;
      }
      this.cfg.state.setError((err as Error).message);
      try {
        this.cfg.state.transition('error', 'stt open failed');
      } catch {}
      throw err;
    }

    return turnId;
  }

  pushAudio(frame: Int16Array): void {
    if (!this.active) return;
    this.active.stt.send(frame);
  }

  /**
   * Called when the client signals end-of-audio (mic stopped) or Deepgram
   * fires utterance_end. Triggers STT finalisation and starts the LLM stream.
   */
  async finishAudio(): Promise<void> {
    if (!this.active) return;
    try {
      this.active.stt.finish();
    } catch {}
    await this.handleEndpoint(this.active.turnId);
  }

  /**
   * Inject text into the active turn as if it had arrived via STT. Used for
   * the `client.text` path (typed input) where there is no audio. Must be
   * called between `beginTurn()` and `finishAudio()`.
   */
  injectText(text: string): void {
    if (!this.active) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    this.active.finalText = (this.active.finalText + ' ' + trimmed).trim();
    this.cfg.state.appendFinalTranscript(trimmed);
  }

  private async handleEndpoint(turnId: string): Promise<void> {
    if (!this.active || this.active.turnId !== turnId) return;
    if (this.active.endpointFired) return;
    this.active.endpointFired = true;
    await this.cfg.bus.emit('stt.endpoint', { turnId });
    if (this.active.llmStarted) return;
    if (this.active.finalText.length === 0 && this.active.partialText.length === 0) {
      // User said nothing usable — back to idle.
      log.warn({ turnId }, 'endpoint with no text — ending turn (no-speech)');
      await this.endTurn('no-speech');
      return;
    }
    this.runLLM(turnId).catch(async (err) => {
      log.error({ err }, 'LLM stream crashed');
      this.cfg.state.setError((err as Error).message);
      this.cfg.state.transition('error', 'llm crash');
      await this.cfg.bus.emit('pipeline.error', { error: err as Error, recoverable: true });
      await this.endTurn('llm-error');
    });
  }

  private async runLLM(turnId: string): Promise<void> {
    if (!this.active || this.active.turnId !== turnId) return;
    this.active.llmStarted = true;
    const userText = (this.active.finalText || this.active.partialText).trim();
    if (!userText) return;

    // Close STT — we have what we need; saves tokens during long replies.
    try {
      await this.active.stt.close();
    } catch {}

    this.cfg.state.transition('thinking', 'llm start');

    // Route to specialist.
    let agentId: AgentId = 'orchestrator';
    try {
      const decision = await this.cfg.router.route(userText, this.active.token.toAbortSignal());
      agentId = decision.agent;
      await this.cfg.bus.emit('agent.route', { turnId, agent: agentId, reason: decision.reason });
    } catch (err) {
      log.warn({ err }, 'router failed; orchestrator fallback');
    }

    const agent = AGENTS[agentId];

    // Retrieve memory context — best-effort.
    let memorySnippet = '';
    try {
      const hits = await this.cfg.store.search(userText, { limit: 4 });
      if (hits.length > 0) {
        memorySnippet =
          'Relevant memories:\n' +
          hits.map((h, i) => `${i + 1}. ${h.text}`).join('\n');
      }
    } catch (err) {
      log.warn({ err }, 'memory retrieval failed');
    }

    this.history.push({ role: 'user', content: userText, ts: Date.now() });

    const messages: MessageParam[] = this.history.map((m) => ({
      role: m.role === 'system' ? 'user' : m.role,
      content: m.content,
    }));

    const tools = this.cfg.registry.describe({ tags: agent.toolTags });

    // TTS is optional. If disabled by config or missing an API key, run the
    // entire turn text-only — Claude's deltas still stream to the renderer.
    let tts: ElevenLabsTTSSession | null = null;
    if (!this.cfg.disableTts && this.cfg.elevenLabsApiKey) {
      tts = new ElevenLabsTTSSession({
        apiKey: this.cfg.elevenLabsApiKey,
        voiceId: this.cfg.elevenLabsVoiceId,
        model: this.cfg.elevenLabsModel,
        outputFormat: 'pcm_24000',
      });
      this.active.tts = tts;
    } else {
      log.info({ disableTts: this.cfg.disableTts }, 'TTS disabled — text-only mode');
    }

    tts?.on(async (ev) => {
      if (!this.active || this.active.turnId !== turnId) return;
      if (ev.type === 'audio') {
        await this.cfg.bus.emit('tts.frame', { turnId, pcm: ev.pcm });
      } else if (ev.type === 'final' || ev.type === 'close') {
        // wait until LLM also finished
        if (this.active.llmFinished) {
          await this.cfg.bus.emit('tts.end', { turnId });
          await this.endTurn('complete');
        }
      } else if (ev.type === 'error') {
        log.warn({ err: ev.error, msg: ev.error?.message }, 'tts error — degrading to text-only');
        // Disable TTS for the rest of this turn so subsequent text deltas
        // aren't fed into a dead socket and the runLLM cleanup takes the
        // text-only branch (which will properly fire tts.end + endTurn).
        if (this.active) this.active.tts = null;
        try {
          tts.interrupt();
        } catch {}
      }
    });

    if (tts) {
      try {
        await tts.open(this.active.token);
        await this.cfg.bus.emit('tts.start', { turnId, sampleRate: tts.pcmSampleRate });
      } catch (err) {
        log.error({ err }, 'TTS open failed — continuing text-only');
        this.active.tts = null;
      }
    }

    const system = buildSystem(agent, memorySnippet);
    // Single Bedrock-hosted model for every agent. Agents still differentiate
    // via system prompt, temperature, max tokens, and tool subset.
    const model = agent.model ?? this.cfg.bedrockModelId;

    let firstSpeakingFired = false;
    let assembledText = '';

    try {
      const stream = this.cfg.claude.run({
        model,
        system,
        messages,
        temperature: agent.temperature,
        maxTokens: agent.maxTokens ?? this.cfg.maxTokens,
        tools,
        registry: this.cfg.registry,
        toolContext: { sessionId: this.cfg.state.sessionId, turnId, token: this.active.token },
        maxToolIterations: 6,
        token: this.active.token,
      });

      for await (const ev of stream) {
        if (this.active.token.isCancelled) break;
        await this.handleStreamEvent(ev, turnId, async (delta) => {
          assembledText += delta;
          if (!firstSpeakingFired) {
            firstSpeakingFired = true;
            this.cfg.state.transition('speaking', 'first delta');
          }
          if (this.active?.tts) this.active.tts.feedSentenceAware(delta);
        });
      }
    } catch (err) {
      if (err instanceof CancellationError) {
        log.info({ turnId }, 'LLM cancelled');
      } else {
        throw err;
      }
    }

    this.active.llmFinished = true;
    this.cfg.state.appendAssistantText('');
    if (assembledText.length > 0) {
      this.history.push({ role: 'assistant', content: assembledText, ts: Date.now() });
    }

    if (this.active.tts) {
      try {
        this.active.tts.flush();
        await this.active.tts.close();
      } catch {}
    } else {
      // No TTS — end immediately.
      await this.cfg.bus.emit('tts.end', { turnId });
      await this.endTurn('text-only');
    }

    // Compact memory in the background — never block the next turn.
    void this.cfg.summariser
      .compact(this.cfg.state.sessionId, this.history)
      .then((kept) => {
        if (kept.length !== this.history.length) this.history = kept;
      })
      .catch((err) => log.warn({ err }, 'compaction failed'));
  }

  private async handleStreamEvent(
    ev: StreamEvent,
    turnId: string,
    onTextDelta: (text: string) => void | Promise<void>,
  ): Promise<void> {
    if (!this.active || this.active.turnId !== turnId) return;
    switch (ev.type) {
      case 'text_delta':
        this.cfg.state.appendAssistantText(ev.text);
        await this.cfg.bus.emit('assistant.delta', { turnId, text: ev.text });
        await onTextDelta(ev.text);
        break;
      case 'tool_start': {
        const summary: ToolCallSummary = { id: ev.id, name: ev.name, status: 'pending' };
        this.cfg.state.upsertToolCall(summary);
        this.cfg.state.transition('tool_calling', 'tool_start');
        await this.cfg.bus.emit('tool.update', { turnId, tool: summary });
        break;
      }
      case 'tool_done': {
        const summary: ToolCallSummary = {
          id: ev.id,
          name: ev.name,
          status: 'running',
          inputPreview: previewJson(ev.input),
        };
        this.cfg.state.upsertToolCall(summary);
        await this.cfg.bus.emit('tool.update', { turnId, tool: summary });
        break;
      }
      case 'tool_result': {
        const summary: ToolCallSummary = {
          id: ev.id,
          name: ev.name,
          status: ev.ok ? 'success' : 'error',
          outputPreview: previewJson(ev.output),
          durationMs: ev.durationMs,
        };
        this.cfg.state.upsertToolCall(summary);
        await this.cfg.bus.emit('tool.update', { turnId, tool: summary });
        // After tools, Claude loops again — transition back to thinking until next delta.
        this.cfg.state.transition('thinking', 'tool_result');
        break;
      }
      case 'message_complete':
        await this.cfg.bus.emit('assistant.done', { turnId, text: ev.finalText });
        break;
      case 'error':
        await this.cfg.bus.emit('pipeline.error', { error: ev.error, recoverable: true });
        break;
    }
  }

  /**
   * Hard interrupt — user spoke over the assistant. Cancels Claude, kills
   * TTS, drops in-flight tool calls, transitions to interrupted then idle.
   */
  async interrupt(reason: 'user_voice' | 'manual' | 'wake'): Promise<void> {
    if (!this.active) return;
    const turnId = this.active.turnId;
    this.cfg.interrupts.fire(reason);
    try {
      this.active.tts?.interrupt();
    } catch {}
    try {
      await this.active.stt.close();
    } catch {}
    this.cfg.state.transition('interrupted', reason);
    await this.cfg.bus.emit('tts.end', { turnId });
    await this.endTurn(reason);
  }

  private async endTurn(reason: string): Promise<void> {
    if (!this.active) return;
    const turnId = this.active.turnId;
    this.cfg.interrupts.disarm(turnId);
    this.active = null;
    if (this.cfg.state.phase !== 'idle') {
      try {
        this.cfg.state.transition('idle', `endTurn:${reason}`);
      } catch {
        this.cfg.state.reset();
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.active) {
      this.cfg.interrupts.fire('manual');
      try {
        this.active.tts?.interrupt();
      } catch {}
      try {
        await this.active.stt.close();
      } catch {}
      this.active = null;
    }
  }
}

function previewJson(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 240 ? s.slice(0, 240) + '…' : s;
  } catch {
    return String(v).slice(0, 240);
  }
}
