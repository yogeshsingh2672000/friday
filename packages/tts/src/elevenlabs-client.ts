import WebSocket from 'ws';
import { getLogger, type CancellationToken } from '@friday/shared';

const log = getLogger('tts:elevenlabs');

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  /** Defaults to eleven_turbo_v2_5 — ~250ms first-byte. */
  model?: string;
  /** Output format. We use pcm_24000 for direct Web Audio playback. */
  outputFormat?: 'pcm_16000' | 'pcm_22050' | 'pcm_24000' | 'pcm_44100' | 'mp3_44100_128';
  /** Voice tuning. */
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speakerBoost?: boolean;
  /** Auto-flush window. Lower = faster first audio, more requests. */
  chunkScheduleMs?: number[];
}

export type TTSEvent =
  | { type: 'open' }
  | { type: 'audio'; pcm: Int16Array; isFinal: boolean }
  | { type: 'alignment'; chars: string[]; startMs: number[]; durationMs: number[] }
  | { type: 'final' }
  | { type: 'error'; error: Error }
  | { type: 'close'; code: number; reason: string };

export type TTSListener = (ev: TTSEvent) => void;

/**
 * Streaming TTS session with ElevenLabs. Maintains an open WebSocket; feed
 * text via `feedText()` as Claude tokens arrive, then call `flush()` when a
 * sentence boundary completes for low-latency audio. `close()` ends the
 * session cleanly; `interrupt()` aborts immediately.
 *
 * Output is PCM Int16 at the configured sample rate (default 24kHz).
 */
export class ElevenLabsTTSSession {
  private ws: WebSocket | null = null;
  private listeners = new Set<TTSListener>();
  private opened = false;
  private closed = false;
  private readonly sampleRate: number;
  private bufferedTextSinceFlush = '';

  constructor(private readonly opts: ElevenLabsOptions) {
    if (!opts.apiKey) throw new Error('ElevenLabs API key required.');
    if (!opts.voiceId) throw new Error('ElevenLabs voice id required.');
    const fmt = opts.outputFormat ?? 'pcm_24000';
    this.sampleRate = parseSampleRate(fmt);
  }

  on(cb: TTSListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get pcmSampleRate(): number {
    return this.sampleRate;
  }

  async open(token?: CancellationToken): Promise<void> {
    if (this.opened) return;
    this.opened = true;

    const model = this.opts.model ?? 'eleven_turbo_v2_5';
    const format = this.opts.outputFormat ?? 'pcm_24000';
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.opts.voiceId)}/stream-input?model_id=${encodeURIComponent(model)}&output_format=${encodeURIComponent(format)}`;

    this.ws = new WebSocket(url, {
      headers: { 'xi-api-key': this.opts.apiKey },
      perMessageDeflate: false,
    });

    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      const onOpen = () => {
        ws.off('error', onError);
        // Initial config frame (BOS) — text must be a single space.
        const init = {
          text: ' ',
          voice_settings: {
            stability: this.opts.stability ?? 0.4,
            similarity_boost: this.opts.similarityBoost ?? 0.75,
            style: this.opts.style ?? 0,
            use_speaker_boost: this.opts.speakerBoost ?? true,
          },
          generation_config: {
            chunk_length_schedule: this.opts.chunkScheduleMs ?? [120, 160, 250, 290],
          },
          xi_api_key: this.opts.apiKey,
        };
        ws.send(JSON.stringify(init));
        this.emit({ type: 'open' });
        resolve();
      };
      const onError = (err: Error) => {
        ws.off('open', onOpen);
        reject(err);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
      token?.onCancel(() => {
        try {
          ws.close(1000, 'cancelled');
        } catch {}
      });
    });

    this.ws.on('message', (raw) => this.handleMessage(raw));
    this.ws.on('close', (code, reason) => {
      this.emit({ type: 'close', code, reason: reason?.toString() ?? '' });
    });
    this.ws.on('error', (err) => {
      this.emit({ type: 'error', error: err });
    });
  }

  /**
   * Push more text. Safe to call rapidly; ElevenLabs schedules its own
   * inference based on chunk_length_schedule. Pass `forceFlush: true` to
   * trigger an immediate "" generation flush (use at sentence boundaries).
   */
  feedText(text: string, opts: { forceFlush?: boolean } = {}): void {
    if (!this.ws || this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    if (text.length === 0 && !opts.forceFlush) return;
    if (text.length > 0) {
      this.bufferedTextSinceFlush += text;
      this.ws.send(JSON.stringify({ text, try_trigger_generation: opts.forceFlush ?? false }));
    }
    if (opts.forceFlush) {
      this.ws.send(JSON.stringify({ text: '', try_trigger_generation: true }));
      this.bufferedTextSinceFlush = '';
    }
  }

  /**
   * Sentence-aware feeder. Buffers text and flushes whenever a terminal
   * punctuation is reached, OR when buffered length exceeds `maxBuffer`.
   */
  feedSentenceAware(text: string, maxBuffer = 80): void {
    if (!text) return;
    this.feedText(text);
    const terminal = /[\.\?\!\n]/.test(text);
    if (terminal || this.bufferedTextSinceFlush.length >= maxBuffer) {
      this.flush();
    }
  }

  flush(): void {
    if (!this.ws || this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ text: '', try_trigger_generation: true }));
    this.bufferedTextSinceFlush = '';
  }

  /**
   * Cleanly signal end-of-input (EOS). ElevenLabs will emit remaining audio
   * frames and then close. Call this when the assistant message completes.
   */
  end(): void {
    if (!this.ws || this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ text: '' }));
  }

  /**
   * Hard abort — closes the socket immediately. Use on user interruption.
   */
  interrupt(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close(1000, 'interrupt');
    } catch {}
    this.ws = null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.end();
      this.ws?.close(1000, 'eos');
    } catch {}
    this.ws = null;
  }

  private handleMessage(raw: WebSocket.RawData) {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      log.warn({ err }, 'failed to parse tts frame');
      return;
    }
    if (msg.audio) {
      // base64 PCM int16 little-endian
      try {
        const buf = Buffer.from(msg.audio, 'base64');
        const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
        this.emit({ type: 'audio', pcm, isFinal: Boolean(msg.isFinal) });
      } catch (err) {
        log.warn({ err }, 'failed to decode audio frame');
      }
    }
    if (msg.normalizedAlignment || msg.alignment) {
      const a = msg.normalizedAlignment ?? msg.alignment;
      this.emit({
        type: 'alignment',
        chars: a.chars ?? [],
        startMs: (a.charStartTimesMs ?? []) as number[],
        durationMs: (a.charDurationsMs ?? []) as number[],
      });
    }
    if (msg.isFinal) {
      this.emit({ type: 'final' });
    }
    if (msg.error) {
      this.emit({ type: 'error', error: new Error(String(msg.error)) });
    }
  }

  private emit(ev: TTSEvent) {
    for (const cb of [...this.listeners]) {
      try {
        cb(ev);
      } catch (err) {
        log.error({ err }, 'listener threw');
      }
    }
  }
}

function parseSampleRate(fmt: string): number {
  const m = fmt.match(/^pcm_(\d+)/);
  if (m) return parseInt(m[1]!, 10);
  return 24000;
}
