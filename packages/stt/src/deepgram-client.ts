import { createClient, LiveTranscriptionEvents, type ListenLiveClient } from '@deepgram/sdk';
import { getLogger, type CancellationToken, type TranscriptSegment } from '@friday/shared';

const log = getLogger('stt:deepgram');

export interface DeepgramStreamOptions {
  apiKey: string;
  model?: string;
  language?: string;
  sampleRate?: number;
  channels?: number;
  /** Endpointing (silence ms) before utterance finalisation. */
  endpointingMs?: number;
  /** Detect partial utterances during long pauses. */
  utteranceEndMs?: number;
  smartFormat?: boolean;
  interimResults?: boolean;
  punctuate?: boolean;
  vadEvents?: boolean;
}

export type STTEvent =
  | { type: 'open' }
  | { type: 'transcript'; segment: TranscriptSegment }
  | { type: 'utterance_end'; lastWordEndMs: number }
  | { type: 'speech_started' }
  | { type: 'metadata'; data: unknown }
  | { type: 'close'; code?: number; reason?: string }
  | { type: 'error'; error: Error };

export type STTListener = (ev: STTEvent) => void;

/**
 * Deepgram streaming STT session. Holds an open live connection, accepts
 * Int16 PCM frames at `sampleRate`, and emits typed events. The session is
 * single-use: call `close()` and create a new instance for the next turn,
 * or hold one open across turns (Deepgram bills only for actual audio sent).
 */
export class DeepgramSession {
  private readonly client: ReturnType<typeof createClient>;
  private live: ListenLiveClient | null = null;
  private listeners = new Set<STTListener>();
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private opened = false;
  private closed = false;

  constructor(private readonly opts: DeepgramStreamOptions) {
    if (!opts.apiKey) throw new Error('Deepgram API key is required.');
    this.client = createClient(opts.apiKey);
  }

  on(cb: STTListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async open(token?: CancellationToken): Promise<void> {
    if (this.opened) return;
    this.opened = true;

    const sampleRate = this.opts.sampleRate ?? 16000;
    const channels = this.opts.channels ?? 1;
    this.live = this.client.listen.live({
      model: this.opts.model ?? 'nova-2',
      language: this.opts.language ?? 'en-US',
      smart_format: this.opts.smartFormat ?? true,
      interim_results: this.opts.interimResults ?? true,
      punctuate: this.opts.punctuate ?? true,
      vad_events: this.opts.vadEvents ?? true,
      endpointing: this.opts.endpointingMs ?? 250,
      utterance_end_ms: this.opts.utteranceEndMs ?? 1000,
      encoding: 'linear16',
      sample_rate: sampleRate,
      channels,
    });

    const live = this.live!;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        log.info({ model: this.opts.model }, 'deepgram open');
        this.emit({ type: 'open' });
        // keep-alive every 5s so idle connections don't get reaped
        this.keepAlive = setInterval(() => {
          try {
            live.keepAlive();
          } catch (err) {
            log.warn({ err }, 'keepAlive failed');
          }
        }, 5000);
        resolve();
      };
      const onError = (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error({ err: error }, 'deepgram connection error');
        this.emit({ type: 'error', error });
        reject(error);
      };
      live.once(LiveTranscriptionEvents.Open, onOpen);
      live.once(LiveTranscriptionEvents.Error, onError);
      token?.onCancel(() => {
        try {
          live.requestClose();
        } catch {}
      });
    });

    live.on(LiveTranscriptionEvents.Transcript, (msg: any) => {
      try {
        const alt = msg?.channel?.alternatives?.[0];
        if (!alt) return;
        const segment: TranscriptSegment = {
          text: alt.transcript ?? '',
          isFinal: Boolean(msg.is_final),
          confidence: Number(alt.confidence ?? 0),
          startMs: Math.round((msg.start ?? 0) * 1000),
          endMs: Math.round(((msg.start ?? 0) + (msg.duration ?? 0)) * 1000),
        };
        if (segment.text.length === 0 && !segment.isFinal) return;
        this.emit({ type: 'transcript', segment });
      } catch (err) {
        log.warn({ err }, 'failed to parse transcript');
      }
    });

    live.on(LiveTranscriptionEvents.UtteranceEnd, (msg: any) => {
      this.emit({ type: 'utterance_end', lastWordEndMs: Math.round((msg?.last_word_end ?? 0) * 1000) });
    });

    live.on(LiveTranscriptionEvents.SpeechStarted, () => {
      this.emit({ type: 'speech_started' });
    });

    live.on(LiveTranscriptionEvents.Metadata, (data: unknown) => {
      this.emit({ type: 'metadata', data });
    });

    live.on(LiveTranscriptionEvents.Close, (ev: any) => {
      this.cleanup();
      this.emit({ type: 'close', code: ev?.code, reason: ev?.reason });
    });

    live.on(LiveTranscriptionEvents.Error, (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit({ type: 'error', error });
    });
  }

  /**
   * Push an Int16 PCM frame to Deepgram. Safe to call before `open()` resolves —
   * frames sent pre-open will be dropped with a warning.
   */
  send(frame: Int16Array): void {
    if (!this.live || this.closed) return;
    try {
      const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
      this.live.send(buf);
    } catch (err) {
      log.warn({ err }, 'send failed');
    }
  }

  /**
   * Tell Deepgram we're done sending audio for this utterance and to finalise
   * any pending interim transcript. The connection remains open.
   */
  finish(): void {
    if (!this.live || this.closed) return;
    try {
      this.live.finish();
    } catch (err) {
      log.warn({ err }, 'finish failed');
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
    try {
      this.live?.requestClose();
    } catch {}
    this.live = null;
  }

  private cleanup() {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }

  private emit(ev: STTEvent) {
    for (const cb of [...this.listeners]) {
      try {
        cb(ev);
      } catch (err) {
        log.error({ err }, 'listener threw');
      }
    }
  }
}
