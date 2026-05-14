import { WebSocketServer, WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import {
  EventBus,
  base64ToInt16,
  decodeEvent,
  encodeEvent,
  getLogger,
  int16ToBase64,
  type ClientToServer,
  type ServerToClient,
} from '@friday/shared';
import type { Pipeline, PipelineEvents } from './pipeline.js';
import type { FridayStateMachine } from './state-machine.js';
import type { UIEventMap } from '@friday/tools';

const log = getLogger('orchestrator:ws');

export interface WSServerOptions {
  host: string;
  port: number;
  state: FridayStateMachine;
  pipeline: Pipeline;
  pipelineBus: EventBus<PipelineEvents>;
  uiBus: EventBus<UIEventMap>;
}

/**
 * WebSocket server that hosts ONE active client at a time (the Electron
 * renderer). Subscribes to pipeline + state events and forwards them down.
 * Inbound client messages drive the pipeline.
 */
export class WSServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private subs: Array<{ unsubscribe(): void }> = [];

  constructor(private readonly opts: WSServerOptions) {}

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ host: this.opts.host, port: this.opts.port });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    this.wss.on('error', (err) => log.error({ err }, 'wss error'));

    // Wait for listening, but reject on bind error (e.g. EADDRINUSE) so the
    // orchestrator exits with a clear failure instead of hanging forever.
    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        this.wss!.off('error', onError);
        const addr = this.wss!.address();
        log.info({ addr }, 'ws server listening');
        resolve();
      };
      const onError = (err: Error) => {
        this.wss!.off('listening', onListening);
        reject(err);
      };
      this.wss!.once('listening', onListening);
      this.wss!.once('error', onError);
    });

    this.wireEvents();
  }

  async stop(): Promise<void> {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
    for (const ws of this.clients) {
      try {
        ws.close(1000, 'shutdown');
      } catch {}
    }
    this.clients.clear();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    this.wss = null;
  }

  broadcast(ev: ServerToClient): void {
    const data = encodeEvent(ev);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private wireEvents() {
    const { state, pipelineBus, uiBus } = this.opts;

    this.subs.push(
      state.bus.on('state', (s) => this.broadcast({ type: 'server.state', state: s })),
      state.bus.on('phase', ({ phase, turnId }) =>
        this.broadcast({ type: 'server.phase', phase, turnId }),
      ),
    );

    this.subs.push(
      pipelineBus.on('stt.partial', ({ turnId, text }) =>
        this.broadcast({
          type: 'server.transcript',
          turnId,
          segment: { text, isFinal: false, confidence: 0, startMs: 0, endMs: 0 },
        }),
      ),
      pipelineBus.on('stt.final', ({ turnId, text }) =>
        this.broadcast({
          type: 'server.transcript',
          turnId,
          segment: { text, isFinal: true, confidence: 0, startMs: 0, endMs: 0 },
        }),
      ),
      pipelineBus.on('assistant.delta', ({ turnId, text }) =>
        this.broadcast({ type: 'server.assistant.delta', text, turnId }),
      ),
      pipelineBus.on('assistant.done', ({ turnId, text }) =>
        this.broadcast({ type: 'server.assistant.message', text, turnId }),
      ),
      pipelineBus.on('tool.update', ({ turnId, tool }) =>
        this.broadcast({ type: 'server.tool.update', tool, turnId }),
      ),
      pipelineBus.on('tts.start', ({ turnId, sampleRate }) =>
        this.broadcast({ type: 'server.tts.start', turnId, sampleRate, mime: 'audio/pcm' }),
      ),
      pipelineBus.on('tts.frame', ({ turnId, pcm }) => {
        const b64 = int16ToBase64(pcm);
        this.broadcast({ type: 'server.tts.frame', turnId, pcmBase64: b64, seq: 0 });
      }),
      pipelineBus.on('tts.end', ({ turnId }) =>
        this.broadcast({ type: 'server.tts.end', turnId }),
      ),
      pipelineBus.on('pipeline.error', ({ error, recoverable }) =>
        this.broadcast({ type: 'server.error', message: error.message, recoverable }),
      ),
    );

    // UI events from tools: re-encode as assistant.message so we don't bloat
    // the typed channel; the renderer reads `ui.*` via a dedicated channel
    // delivered as JSON in `server.tool.update`'s outputPreview. We also
    // forward them as discrete events for the renderer to surface.
    this.subs.push(
      uiBus.onAny((name, payload) => {
        const data = JSON.stringify({ type: 'ui.event', name, payload });
        for (const ws of this.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
      }),
    );
  }

  private handleConnection(ws: WebSocket) {
    const clientId = nanoid(8);
    log.info({ clientId }, 'client connected');
    this.clients.add(ws);

    const hello: ServerToClient = {
      type: 'server.hello',
      sessionId: this.opts.state.sessionId,
      serverTime: Date.now(),
    };
    ws.send(encodeEvent(hello));
    // immediately push current state so the renderer can hydrate.
    ws.send(encodeEvent({ type: 'server.state', state: this.opts.state.snapshot() }));

    ws.on('message', async (raw) => {
      try {
        const msg = decodeEvent<ClientToServer>(raw as Buffer);
        await this.handleClientMessage(ws, msg);
      } catch (err) {
        log.warn({ err }, 'bad client message');
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      log.info({ clientId }, 'client disconnected');
    });

    ws.on('error', (err) => log.warn({ err, clientId }, 'client socket error'));
  }

  private async handleClientMessage(ws: WebSocket, msg: ClientToServer): Promise<void> {
    switch (msg.type) {
      case 'client.hello':
        log.debug({ caps: msg.capabilities }, 'client hello');
        break;
      case 'client.ping':
        ws.send(encodeEvent({ type: 'server.pong', ts: msg.ts }));
        break;
      case 'client.wake':
        log.info({ keyword: msg.keyword }, 'wake fired');
        // If we're speaking, treat wake as interrupt + immediate new turn.
        if (this.opts.state.phase === 'speaking' || this.opts.state.phase === 'thinking') {
          await this.opts.pipeline.interrupt('wake');
        }
        await this.opts.pipeline.beginTurn();
        break;
      case 'client.audio.start':
        if (!this.opts.pipeline.currentTurn) {
          // Tolerate: client sent audio without prior wake (manual button).
          await this.opts.pipeline.beginTurn();
        }
        break;
      case 'client.audio.frame': {
        const frame = base64ToInt16(msg.pcmBase64);
        this.opts.pipeline.pushAudio(frame);
        this.opts.state.setAudioLevel(msg.level);
        break;
      }
      case 'client.audio.end':
        await this.opts.pipeline.finishAudio();
        break;
      case 'client.interrupt':
        await this.opts.pipeline.interrupt(msg.reason === 'wake' ? 'wake' : msg.reason);
        break;
      case 'client.text': {
        // Manual text input (no audio path).
        log.info({ text: msg.text }, 'client.text received');
        if (this.opts.pipeline.currentTurn) {
          await this.opts.pipeline.interrupt('manual');
        }
        await this.opts.pipeline.beginTurn();
        // Inject the text directly into the pipeline's active turn so the
        // endpoint check sees it (state.appendFinalTranscript alone doesn't
        // populate the pipeline's per-turn finalText).
        this.opts.pipeline.injectText(msg.text);
        await this.opts.pipeline.finishAudio();
        break;
      }
      case 'client.tts.ended':
        // Renderer confirms playback drained — no-op server-side for now.
        break;
      case 'client.reset':
        await this.opts.pipeline.interrupt('manual');
        this.opts.state.reset();
        break;
    }
  }
}

