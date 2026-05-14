import { PorcupineWorker, BuiltInKeyword } from '@picovoice/porcupine-web';
import { WebVoiceProcessor } from '@picovoice/web-voice-processor';

export interface WakeWordOptions {
  accessKey: string;
  /** Built-in keyword name (case-insensitive). Defaults to "Jarvis". */
  keyword?: string;
  /** Sensitivity in [0,1]. Higher = more triggers / more false-positives. */
  sensitivity?: number;
  onWake: (info: { keyword: string; timestamp: number }) => void;
  onError?: (err: Error) => void;
}

const KEYWORD_MAP: Record<string, BuiltInKeyword> = {
  alexa: BuiltInKeyword.Alexa,
  americano: BuiltInKeyword.Americano,
  blueberry: BuiltInKeyword.Blueberry,
  bumblebee: BuiltInKeyword.Bumblebee,
  computer: BuiltInKeyword.Computer,
  grapefruit: BuiltInKeyword.Grapefruit,
  grasshopper: BuiltInKeyword.Grasshopper,
  'hey google': BuiltInKeyword.HeyGoogle,
  'hey siri': BuiltInKeyword.HeySiri,
  jarvis: BuiltInKeyword.Jarvis,
  'ok google': BuiltInKeyword.OkayGoogle,
  picovoice: BuiltInKeyword.Picovoice,
  porcupine: BuiltInKeyword.Porcupine,
  terminator: BuiltInKeyword.Terminator,
};

function resolveKeyword(name: string | undefined): BuiltInKeyword {
  const key = (name ?? 'jarvis').toLowerCase().trim();
  return KEYWORD_MAP[key] ?? BuiltInKeyword.Jarvis;
}

/**
 * Browser-side wake-word detector. Hosts a Porcupine WASM worker subscribed to
 * the WebVoiceProcessor microphone tap. Designed to run continuously in the
 * Electron renderer; calls `onWake` when the keyword is detected.
 */
export class WakeWord {
  private worker: PorcupineWorker | null = null;
  private started = false;
  private readonly keyword: BuiltInKeyword;

  constructor(private readonly opts: WakeWordOptions) {
    this.keyword = resolveKeyword(opts.keyword);
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.opts.accessKey) {
      throw new Error('Porcupine access key is required (PICOVOICE_ACCESS_KEY).');
    }
    const sensitivity = clamp01(this.opts.sensitivity ?? 0.5);
    this.worker = await PorcupineWorker.create(
      this.opts.accessKey,
      [{ builtin: this.keyword, sensitivity }],
      (detection) => {
        try {
          this.opts.onWake({
            keyword: detection.label ?? String(this.keyword),
            timestamp: Date.now(),
          });
        } catch (err) {
          this.opts.onError?.(err as Error);
        }
      },
      { publicPath: '/porcupine_params.pv' },
    );
    await WebVoiceProcessor.subscribe(this.worker);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      if (this.worker) {
        await WebVoiceProcessor.unsubscribe(this.worker);
        this.worker.terminate();
      }
    } finally {
      this.worker = null;
      this.started = false;
    }
  }

  get isRunning(): boolean {
    return this.started;
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
