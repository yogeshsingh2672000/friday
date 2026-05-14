import { rmsLevel } from './pcm.js';

export interface VADConfig {
  /** RMS threshold (0..1) above which a frame is considered speech. */
  speechThreshold: number;
  /** Frames of consecutive speech needed to fire `speechStart`. */
  triggerFrames: number;
  /** Frames of silence after speech needed to fire `speechEnd`. */
  silenceFrames: number;
}

export const DEFAULT_VAD: VADConfig = {
  speechThreshold: 0.018,
  triggerFrames: 3,
  silenceFrames: 25,
};

export type VADEvent =
  | { type: 'speech_start'; level: number }
  | { type: 'speech_end'; level: number };

/**
 * Energy-based voice activity detector. This is intentionally simple — the
 * authoritative VAD lives server-side via Deepgram's endpointing. This client
 * VAD is used purely to drive UI responsiveness and to detect barge-in
 * (user speaking over the assistant) for interruption.
 */
export class EnergyVAD {
  private speechRun = 0;
  private silenceRun = 0;
  private inSpeech = false;
  private listeners = new Set<(ev: VADEvent) => void>();

  constructor(private readonly cfg: VADConfig = DEFAULT_VAD) {}

  onEvent(cb: (ev: VADEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  process(frame: Int16Array): { level: number; speaking: boolean } {
    const level = rmsLevel(frame);
    const isSpeech = level > this.cfg.speechThreshold;

    if (isSpeech) {
      this.speechRun++;
      this.silenceRun = 0;
      if (!this.inSpeech && this.speechRun >= this.cfg.triggerFrames) {
        this.inSpeech = true;
        this.emit({ type: 'speech_start', level });
      }
    } else {
      this.silenceRun++;
      this.speechRun = 0;
      if (this.inSpeech && this.silenceRun >= this.cfg.silenceFrames) {
        this.inSpeech = false;
        this.emit({ type: 'speech_end', level });
      }
    }
    return { level, speaking: this.inSpeech };
  }

  reset(): void {
    this.speechRun = 0;
    this.silenceRun = 0;
    this.inSpeech = false;
  }

  private emit(ev: VADEvent) {
    for (const cb of this.listeners) {
      try {
        cb(ev);
      } catch (err) {
        console.error('[vad] listener threw', err);
      }
    }
  }
}
