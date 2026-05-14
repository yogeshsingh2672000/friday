import {
  WakeWord,
  Microphone,
  PCMPlayback,
  EnergyVAD,
  base64ToInt16,
  int16ToBase64,
  rmsLevel,
} from '@friday/audio/browser';
import type { WSClient } from './ws-client';
import { useFridayStore } from './state-store';

export interface AudioBridgeOptions {
  accessKey: string;
  keyword?: string;
  ws: WSClient;
}

/**
 * Wires browser audio I/O to the orchestrator WS:
 *   - Wake word always listening (Porcupine) — OPTIONAL; disabled when no
 *     Picovoice access key is configured. Without it, turns are triggered
 *     manually (Space key or on-screen Wake button).
 *   - After wake, mic capture streams 16kHz PCM frames -> client.audio.frame.
 *   - Local VAD watches mic level for barge-in (interrupt while assistant speaking).
 *   - TTS PCM frames arriving via WS -> PCMPlayback (scheduled gapless playback).
 */
export class AudioBridge {
  private wake: WakeWord | null = null;
  private mic: Microphone | null = null;
  private playback: PCMPlayback | null = null;
  private vad = new EnergyVAD();
  private capturing = false;
  private seq = 0;

  constructor(private readonly opts: AudioBridgeOptions) {
    if (opts.accessKey && opts.accessKey.trim().length > 0) {
      this.wake = new WakeWord({
        accessKey: opts.accessKey,
        keyword: opts.keyword ?? 'jarvis',
        onWake: ({ keyword }) => this.handleWake(keyword),
        onError: (err) => console.error('[audio:wake]', err),
      });
    } else {
      console.info('[audio] wake word disabled (no Picovoice key). Use Space / Wake button to start a turn.');
    }
  }

  get hasWakeWord(): boolean {
    return this.wake !== null;
  }

  async start() {
    if (this.wake) {
      try {
        await this.wake.start();
      } catch (err) {
        console.error('[audio:wake] start failed; falling back to manual trigger only', err);
        this.wake = null;
      }
    }
    this.playback = new PCMPlayback({
      sampleRate: 24000,
      onLevel: (level) => useFridayStore.getState().setTtsLevel(level),
    });
    await this.playback.start();
  }

  async stop() {
    await this.stopCapture();
    if (this.wake) {
      try {
        await this.wake.stop();
      } catch {}
    }
    try {
      await this.playback?.stop();
    } catch {}
    this.playback = null;
  }

  /** Manually start a turn (e.g. from the on-screen button) without wake. */
  async manualStart() {
    this.handleWake('manual');
  }

  /** Hard interrupt — used when the user clicks "stop" or speaks over Friday. */
  async interrupt(reason: 'user_voice' | 'manual' | 'wake') {
    this.opts.ws.send({ type: 'client.interrupt', reason });
    this.playback?.interrupt();
    await this.stopCapture();
  }

  handlePCMFrameFromServer(b64: string) {
    if (!this.playback) return;
    const pcm = base64ToInt16(b64);
    this.playback.enqueue(pcm);
  }

  flushPlayback() {
    // no-op: PCMPlayback drains naturally as frames stop arriving.
  }

  // ------------------------------------------------------------------

  private async handleWake(keyword: string) {
    // Tell server we woke; server begins a turn.
    this.opts.ws.send({ type: 'client.wake', confidence: 1.0, keyword });
    // If the assistant was speaking, interrupt locally too.
    if (this.playback) this.playback.interrupt();
    await this.startCapture();
  }

  private async startCapture() {
    if (this.capturing) return;
    this.capturing = true;
    this.seq = 0;
    this.vad.reset();

    this.mic = new Microphone({
      targetSampleRate: 16000,
      frameSamples: 320,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      onFrame: (frame) => this.handleMicFrame(frame),
      onError: (err) => console.error('[audio:mic]', err),
    });
    try {
      await this.mic.start();
      this.opts.ws.send({ type: 'client.audio.start', sampleRate: 16000, channels: 1 });
    } catch (err) {
      console.error('[audio:mic] start failed', err);
      this.capturing = false;
      this.mic = null;
    }
  }

  private handleMicFrame(frame: Int16Array) {
    if (!this.capturing) return;
    const level = rmsLevel(frame);
    useFridayStore.getState().setMicLevel(level);

    const { phase } = useFridayStore.getState();
    // Barge-in detection: if assistant is speaking and we detect speech, interrupt.
    if (phase === 'speaking') {
      const { speaking } = this.vad.process(frame);
      if (speaking) {
        void this.interrupt('user_voice');
        return;
      }
    } else {
      this.vad.process(frame);
    }

    this.opts.ws.send({
      type: 'client.audio.frame',
      pcmBase64: int16ToBase64(frame),
      seq: this.seq++,
      level,
    });
  }

  private async stopCapture() {
    if (!this.capturing) return;
    this.capturing = false;
    try {
      await this.mic?.stop();
    } catch {}
    this.mic = null;
    this.opts.ws.send({ type: 'client.audio.end' });
  }

  /**
   * Called by the controller when the server signals a phase transition that
   * means we no longer need the mic (e.g. thinking/speaking). We keep mic on
   * through thinking so barge-in still works during the assistant's silence.
   */
  notifyPhase(phase: string) {
    if (phase === 'idle' || phase === 'error') {
      void this.stopCapture();
    }
    if (phase === 'speaking') {
      // keep mic for barge-in
    }
    if (phase === 'transcribing') {
      // Deepgram has the audio; we can stop capturing once endpointed,
      // but for simplicity we let stopCapture run on tts.end / idle.
    }
  }
}
