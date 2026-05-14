import { useFridayStore, type UICard } from './state-store';
import { WSClient } from './ws-client';
import { AudioBridge } from './audio-bridge';
import { BrowserTTS } from './browser-tts';

export type TTSMode = 'browser' | 'server';

export interface ControllerOptions {
  orchestratorUrl: string;
  accessKey: string;
  keyword?: string;
  /** "browser" = free Web Speech API; "server" = play tts.frame audio from orchestrator. */
  ttsMode?: TTSMode;
  /** Optional preferred OS voice URI for browser TTS. */
  ttsVoiceURI?: string;
}

/**
 * Top-level controller: opens the WS, dispatches inbound events into the
 * store, drives audio playback (server PCM frames or browser speechSynthesis).
 * Owned by App.tsx via a single effect.
 */
export class Controller {
  readonly ws: WSClient;
  readonly audio: AudioBridge;
  private readonly ttsMode: TTSMode;
  private readonly browserTts: BrowserTTS | null;
  private ttsLevelTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ControllerOptions) {
    this.ttsMode = opts.ttsMode ?? 'browser';

    this.ws = new WSClient({
      url: opts.orchestratorUrl,
      onEvent: (ev) => this.handleEvent(ev),
      onConnectionChange: (c) => useFridayStore.getState().setConnected(c),
    });
    this.audio = new AudioBridge({
      accessKey: opts.accessKey,
      keyword: opts.keyword,
      ws: this.ws,
    });

    if (this.ttsMode === 'browser' && BrowserTTS.isSupported()) {
      this.browserTts = new BrowserTTS({
        voiceURI: opts.ttsVoiceURI,
        onSpeakingChange: (speaking) => this.setSyntheticTtsLevel(speaking),
      });
    } else {
      this.browserTts = null;
      if (this.ttsMode === 'browser') {
        console.warn('[controller] browser TTS unsupported; falling back to server frames');
      }
    }
  }

  async start() {
    this.ws.start();
    await this.audio.start();
  }

  async stop() {
    this.browserTts?.cancel();
    this.stopSyntheticTtsLevel();
    await this.audio.stop();
    this.ws.stop();
  }

  manualTrigger() {
    void this.audio.manualStart();
  }

  interrupt() {
    this.browserTts?.cancel();
    void this.audio.interrupt('manual');
  }

  reset() {
    this.browserTts?.cancel();
    useFridayStore.getState().reset();
    this.ws.send({ type: 'client.reset' });
  }

  private setSyntheticTtsLevel(speaking: boolean) {
    const s = useFridayStore.getState();
    if (speaking) {
      // Browser speechSynthesis doesn't expose amplitude, so we drive a
      // gentle oscillation on the store's ttsLevel so the orb still pulses.
      if (this.ttsLevelTimer) return;
      const start = performance.now();
      this.ttsLevelTimer = setInterval(() => {
        const t = (performance.now() - start) / 1000;
        const level = 0.28 + 0.18 * Math.sin(t * 7) + 0.06 * Math.sin(t * 13);
        useFridayStore.getState().setTtsLevel(Math.max(0.1, Math.min(0.6, level)));
      }, 40);
    } else {
      this.stopSyntheticTtsLevel();
      s.setTtsLevel(0);
    }
  }

  private stopSyntheticTtsLevel() {
    if (this.ttsLevelTimer) {
      clearInterval(this.ttsLevelTimer);
      this.ttsLevelTimer = null;
    }
  }

  sendText(text: string) {
    if (!text.trim()) return;
    this.ws.send({ type: 'client.text', text });
  }

  private handleEvent(ev: any) {
    const s = useFridayStore.getState();
    switch (ev.type) {
      case 'server.hello':
        // session established
        break;
      case 'server.state':
        s.setPhase(ev.state.phase);
        if (ev.state.lastError) s.setError(ev.state.lastError);
        this.audio.notifyPhase(ev.state.phase);
        break;
      case 'server.phase':
        s.setPhase(ev.phase);
        this.audio.notifyPhase(ev.phase);
        // Cancel any in-flight browser TTS on user-driven interruption.
        if (ev.phase === 'interrupted' || ev.phase === 'error') {
          this.browserTts?.cancel();
        }
        break;
      case 'server.transcript':
        if (ev.segment.isFinal) s.pushFinal(ev.turnId, ev.segment.text);
        else s.setPartial(ev.segment.text);
        break;
      case 'server.assistant.delta':
        s.appendAssistantDelta(ev.turnId, ev.text);
        this.browserTts?.feed(ev.text);
        break;
      case 'server.assistant.message':
        s.completeAssistant(ev.turnId, ev.text);
        this.browserTts?.flush();
        break;
      case 'server.tool.update':
        s.upsertTool(ev.tool);
        break;
      case 'server.tts.start':
        // PCMPlayback is already running; nothing to do.
        break;
      case 'server.tts.frame':
        // Server-rendered audio. Ignore when we're driving TTS in the browser.
        if (!this.browserTts) this.audio.handlePCMFrameFromServer(ev.pcmBase64);
        break;
      case 'server.tts.end':
        this.ws.send({ type: 'client.tts.ended', turnId: ev.turnId });
        break;
      case 'server.error':
        s.setError(ev.message);
        break;
      case 'server.pong':
        break;
      case 'ui.event': {
        this.handleUIEvent(ev.name, ev.payload);
        break;
      }
    }
  }

  private handleUIEvent(name: string, payload: any) {
    const s = useFridayStore.getState();
    switch (name) {
      case 'ui.show_card': {
        const card: UICard = {
          id: payload.id,
          kind: 'card',
          title: payload.title,
          body: payload.body,
          tone: payload.tone,
          createdAt: Date.now(),
        };
        s.pushCard(card);
        break;
      }
      case 'ui.show_list': {
        const card: UICard = {
          id: payload.id,
          kind: 'list',
          title: payload.title,
          items: payload.items,
          createdAt: Date.now(),
        };
        s.pushCard(card);
        break;
      }
      case 'ui.show_image': {
        const card: UICard = {
          id: payload.id,
          kind: 'image',
          url: payload.url,
          body: payload.caption,
          createdAt: Date.now(),
        };
        s.pushCard(card);
        break;
      }
      case 'ui.clear':
        s.clearCards(payload.id);
        break;
      case 'ui.scene_preset':
        s.setScene(payload.preset);
        break;
    }
  }
}
