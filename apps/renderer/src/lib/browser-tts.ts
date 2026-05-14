/**
 * Free, zero-latency TTS via the browser's built-in Web Speech API.
 *
 * Strategy:
 *   - `feed(textChunk)` is called as Claude streams tokens.
 *   - We buffer the chunks and slice off complete sentences (anything ending
 *     in . ! ? : or a newline). Each sentence is queued to `speechSynthesis`.
 *   - `flush()` is called when the assistant message is complete to speak
 *     any trailing fragment.
 *   - `cancel()` aborts immediately on user interruption.
 *
 * Voice selection: the constructor picks the first English voice found, or
 * a configured `voiceURI` if it matches one the OS provides.
 */

export interface BrowserTTSOptions {
  /** Exact voice URI (from `speechSynthesis.getVoices()`). If unset/unmatched, picks a default English voice. */
  voiceURI?: string;
  /** Language hint used when no voiceURI is set. Defaults to "en". */
  langPrefix?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  onSpeakingChange?: (speaking: boolean) => void;
}

export class BrowserTTS {
  private synth: SpeechSynthesis;
  private voice: SpeechSynthesisVoice | null = null;
  private buffer = '';
  private speakingCount = 0;
  private cancelled = false;

  static isSupported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  }

  constructor(private readonly opts: BrowserTTSOptions = {}) {
    this.synth = window.speechSynthesis;
    this.selectVoice();
    // Voices are populated async in some browsers (notably Chrome on Windows).
    if (typeof this.synth.addEventListener === 'function') {
      this.synth.addEventListener('voiceschanged', () => this.selectVoice());
    }
  }

  private selectVoice(): void {
    const voices = this.synth.getVoices();
    if (voices.length === 0) return;
    if (this.opts.voiceURI) {
      const exact = voices.find((v) => v.voiceURI === this.opts.voiceURI);
      if (exact) {
        this.voice = exact;
        return;
      }
    }
    const lang = (this.opts.langPrefix ?? 'en').toLowerCase();
    // Prefer non-Google network voices on Windows; they sound more natural.
    const preferred =
      voices.find((v) => v.lang.toLowerCase().startsWith(lang) && /natural|aria|jenny|eric|ryan|guy/i.test(v.name)) ??
      voices.find((v) => v.lang.toLowerCase().startsWith(lang) && v.localService) ??
      voices.find((v) => v.lang.toLowerCase().startsWith(lang)) ??
      voices[0];
    this.voice = preferred ?? null;
  }

  /**
   * Push a text chunk from a streaming response. Complete sentences are
   * dispatched to the synthesizer immediately; the trailing fragment is held
   * until the next chunk or until `flush()` is called.
   */
  feed(chunk: string): void {
    if (!chunk || this.cancelled) return;
    this.buffer += chunk;
    this.drainSentences();
  }

  private drainSentences(): void {
    // Match the leading sentence + its trailing whitespace.
    const re = /^([\s\S]*?[\.!\?:\n])\s+/;
    while (true) {
      const m = this.buffer.match(re);
      if (!m) break;
      const sentence = (m[1] ?? '').trim();
      this.buffer = this.buffer.slice(m[0].length);
      if (sentence) this.utter(sentence);
    }
  }

  /** Speak any remaining buffered text. Call when the assistant message ends. */
  flush(): void {
    const tail = this.buffer.trim();
    this.buffer = '';
    if (tail) this.utter(tail);
  }

  /** Hard interrupt — cancels current utterance + clears the queue. */
  cancel(): void {
    this.cancelled = true;
    this.buffer = '';
    try {
      this.synth.cancel();
    } catch {}
    if (this.speakingCount > 0) {
      this.speakingCount = 0;
      this.opts.onSpeakingChange?.(false);
    }
    // Allow feeding again on the next turn.
    setTimeout(() => {
      this.cancelled = false;
    }, 50);
  }

  /** True if anything is currently being spoken or queued. */
  get isSpeaking(): boolean {
    return this.speakingCount > 0 || this.synth.speaking || this.synth.pending;
  }

  private utter(text: string): void {
    if (this.cancelled) return;
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    if (this.voice) u.lang = this.voice.lang;
    u.rate = this.opts.rate ?? 1.02;
    u.pitch = this.opts.pitch ?? 1.0;
    u.volume = this.opts.volume ?? 1.0;
    u.onstart = () => {
      this.speakingCount++;
      if (this.speakingCount === 1) this.opts.onSpeakingChange?.(true);
    };
    u.onend = () => {
      this.speakingCount = Math.max(0, this.speakingCount - 1);
      if (this.speakingCount === 0) this.opts.onSpeakingChange?.(false);
    };
    u.onerror = (ev) => {
      this.speakingCount = Math.max(0, this.speakingCount - 1);
      if (this.speakingCount === 0) this.opts.onSpeakingChange?.(false);
      // 'interrupted' / 'canceled' errors are expected on user barge-in.
      if (ev.error !== 'canceled' && ev.error !== 'interrupted') {
        console.warn('[browser-tts] utterance error:', ev.error);
      }
    };
    try {
      this.synth.speak(u);
    } catch (err) {
      console.warn('[browser-tts] speak failed', err);
    }
  }
}
