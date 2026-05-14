import { float32ToInt16, resampleLinear } from './pcm.js';

export interface MicrophoneOptions {
  /** Target sample rate for outgoing PCM frames. STT prefers 16000. */
  targetSampleRate?: number;
  /** Samples per emitted frame at the target sample rate. 20ms @16k = 320 */
  frameSamples?: number;
  /** Echo cancellation / noise suppression toggles. */
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  onFrame: (frame: Int16Array) => void;
  onError?: (err: Error) => void;
}

/**
 * Low-latency microphone capture using AudioWorklet. Buffers 128-sample blocks
 * from the worklet, downsamples to `targetSampleRate`, and emits fixed-size
 * Int16 PCM frames via `onFrame`. Designed to coexist with Porcupine's
 * WebVoiceProcessor (which uses its own tap on the same stream).
 */
export class Microphone {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private active = false;

  private readonly targetRate: number;
  private readonly frameSamples: number;
  private pending: number[] = [];

  constructor(private readonly opts: MicrophoneOptions) {
    this.targetRate = opts.targetSampleRate ?? 16000;
    this.frameSamples = opts.frameSamples ?? 320; // 20ms @ 16k
  }

  async start(): Promise<void> {
    if (this.active) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: this.opts.echoCancellation ?? true,
        noiseSuppression: this.opts.noiseSuppression ?? true,
        autoGainControl: this.opts.autoGainControl ?? true,
        channelCount: 1,
      },
      video: false,
    });

    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'friday-mic-processor');
    this.node.port.onmessage = (ev) => this.handleBlock(ev.data as Float32Array);
    this.source.connect(this.node);
    // We never connect the worklet to the destination — we just want frames.
    this.active = true;
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    try {
      this.node?.port.close();
      this.node?.disconnect();
      this.source?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      await this.ctx?.close();
    } catch (err) {
      this.opts.onError?.(err as Error);
    } finally {
      this.node = null;
      this.source = null;
      this.stream = null;
      this.ctx = null;
      this.pending = [];
    }
  }

  get isRunning(): boolean {
    return this.active;
  }

  private handleBlock(block: Float32Array) {
    if (!this.ctx) return;
    const inRate = this.ctx.sampleRate;
    const resampled = resampleLinear(block, inRate, this.targetRate);
    for (let i = 0; i < resampled.length; i++) this.pending.push(resampled[i]!);
    while (this.pending.length >= this.frameSamples) {
      const chunk = new Float32Array(this.pending.splice(0, this.frameSamples));
      try {
        this.opts.onFrame(float32ToInt16(chunk));
      } catch (err) {
        this.opts.onError?.(err as Error);
      }
    }
  }
}

const WORKLET_SOURCE = `
class FridayMicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch || ch.length === 0) return true;
    // Copy because the underlying buffer is reused across calls.
    this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('friday-mic-processor', FridayMicProcessor);
`;
