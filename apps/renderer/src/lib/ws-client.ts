import {
  decodeEvent,
  encodeEvent,
  type ClientToServer,
  type ServerToClient,
} from '@friday/shared';

export type WSEventHandler = (ev: ServerToClient | { type: 'ui.event'; name: string; payload: any }) => void;

export interface WSClientOptions {
  url: string;
  /** Backoff in ms between reconnection attempts. */
  reconnectMs?: number;
  /** Heartbeat ping cadence. */
  pingMs?: number;
  onEvent: WSEventHandler;
  onConnectionChange?: (connected: boolean) => void;
}

/**
 * Reconnecting WebSocket client. Automatically retries on close, sends a
 * heartbeat ping every `pingMs`, and exposes `send()` for outbound messages.
 */
export class WSClient {
  private ws: WebSocket | null = null;
  private timer: number | null = null;
  private pingTimer: number | null = null;
  private disposed = false;
  private connected = false;

  constructor(private readonly opts: WSClientOptions) {}

  start() {
    this.connect();
  }

  stop() {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'shutdown');
      } catch {}
      this.ws = null;
    }
  }

  send(msg: ClientToServer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeEvent(msg));
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private connect() {
    if (this.disposed) return;
    console.log('[ws] connecting to', this.opts.url);
    try {
      this.ws = new WebSocket(this.opts.url);
    } catch (err) {
      console.error('[ws] WebSocket constructor threw — bad URL?', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.binaryType = 'arraybuffer';

    this.ws.addEventListener('open', () => {
      console.log('[ws] OPEN — connected to', this.opts.url);
      this.connected = true;
      this.opts.onConnectionChange?.(true);
      this.send({
        type: 'client.hello',
        clientId: crypto.randomUUID(),
        capabilities: ['audio', 'tts', 'ui'],
      });
      this.startPing();
    });

    this.ws.addEventListener('message', (e) => {
      try {
        const data = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === 'object' && 'type' in parsed) {
          this.opts.onEvent(parsed);
        }
      } catch (err) {
        console.warn('[ws] bad message', err);
      }
    });

    this.ws.addEventListener('close', (ev) => {
      console.warn(
        '[ws] CLOSE — code:', (ev as CloseEvent).code,
        'reason:', (ev as CloseEvent).reason || '(none)',
        'wasClean:', (ev as CloseEvent).wasClean,
      );
      this.connected = false;
      this.opts.onConnectionChange?.(false);
      this.stopPing();
      this.scheduleReconnect();
    });

    this.ws.addEventListener('error', (ev) => {
      // 'error' precedes 'close'. Browser only surfaces a generic Event; the
      // CloseEvent's code carries the real reason.
      console.error('[ws] ERROR event (close will follow)', ev);
    });
  }

  private scheduleReconnect() {
    if (this.disposed || this.timer) return;
    const delay = this.opts.reconnectMs ?? 1500;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private startPing() {
    const interval = this.opts.pingMs ?? 10_000;
    this.pingTimer = window.setInterval(() => {
      this.send({ type: 'client.ping', ts: Date.now() });
    }, interval);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

// Re-export decoder for tests / debugging.
export { decodeEvent };
