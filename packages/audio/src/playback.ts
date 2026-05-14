import { int16ToFloat32 } from './pcm.js';

export interface PlaybackOptions {
  sampleRate?: number;
  onLevel?: (level: number) => void;
  onEnded?: () => void;
}

/**
 * Schedules sequential Int16 PCM frames into an AudioContext for gapless,
 * low-latency playback. Cancelling clears the scheduled queue immediately
 * and ramps gain to zero to avoid clicks. Designed for streaming TTS where
 * frames arrive faster than realtime in bursts.
 */
export class PCMPlayback {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private nextStartTime = 0;
  private active = false;
  private scheduled: AudioBufferSourceNode[] = [];
  private levelInterval: ReturnType<typeof setInterval> | null = null;
  private endedTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly sampleRate: number;

  constructor(private readonly opts: PlaybackOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 24000;
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.ctx = new AudioContext({ sampleRate: this.sampleRate, latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.nextStartTime = this.ctx.currentTime;
    this.active = true;
    if (this.opts.onLevel) this.startLevelMeter();
  }

  enqueue(frame: Int16Array): void {
    if (!this.active || !this.ctx || !this.gain) return;
    if (frame.length === 0) return;

    const float = int16ToFloat32(frame);
    const buf = this.ctx.createBuffer(1, float.length, this.sampleRate);
    buf.copyToChannel(float, 0);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);

    const now = this.ctx.currentTime;
    if (this.nextStartTime < now) this.nextStartTime = now;
    src.start(this.nextStartTime);
    const duration = buf.duration;
    this.nextStartTime += duration;

    this.scheduled.push(src);
    src.onended = () => {
      const idx = this.scheduled.indexOf(src);
      if (idx >= 0) this.scheduled.splice(idx, 1);
    };

    this.scheduleEndedCallback();
  }

  /**
   * Stop all playback immediately and clear the schedule. Ramps gain to zero
   * over 8ms to avoid clicks, then resets gain.
   */
  interrupt(): void {
    if (!this.active || !this.ctx || !this.gain) return;
    const now = this.ctx.currentTime;
    try {
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(this.gain.gain.value, now);
      this.gain.gain.linearRampToValueAtTime(0, now + 0.008);
    } catch {}
    for (const src of [...this.scheduled]) {
      try {
        src.onended = null;
        src.stop(now + 0.012);
      } catch {}
    }
    this.scheduled = [];
    this.nextStartTime = now + 0.015;
    if (this.endedTimer) {
      clearTimeout(this.endedTimer);
      this.endedTimer = null;
    }
    // Restore gain shortly after the ramp so the next utterance plays clean.
    setTimeout(() => {
      if (this.gain && this.ctx) {
        try {
          this.gain.gain.setValueAtTime(1, this.ctx.currentTime);
        } catch {}
      }
    }, 20);
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.interrupt();
    if (this.levelInterval) {
      clearInterval(this.levelInterval);
      this.levelInterval = null;
    }
    try {
      await this.ctx?.close();
    } catch {}
    this.ctx = null;
    this.gain = null;
    this.analyser = null;
    this.active = false;
  }

  private scheduleEndedCallback() {
    if (!this.ctx || !this.opts.onEnded) return;
    if (this.endedTimer) clearTimeout(this.endedTimer);
    const remainingMs = Math.max(0, (this.nextStartTime - this.ctx.currentTime) * 1000) + 40;
    this.endedTimer = setTimeout(() => {
      if (this.scheduled.length === 0 && this.opts.onEnded) this.opts.onEnded();
    }, remainingMs);
  }

  private startLevelMeter() {
    if (!this.analyser || !this.opts.onLevel) return;
    const buf = new Uint8Array(this.analyser.fftSize);
    const cb = this.opts.onLevel;
    this.levelInterval = setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i]! - 128) / 128;
        sum += v * v;
      }
      cb(Math.sqrt(sum / buf.length));
    }, 50);
  }
}
