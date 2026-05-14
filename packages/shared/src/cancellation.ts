export class CancellationError extends Error {
  constructor(reason?: string) {
    super(reason ?? 'Operation cancelled');
    this.name = 'CancellationError';
  }
}

export interface CancellationToken {
  readonly isCancelled: boolean;
  readonly reason: string | undefined;
  onCancel(cb: (reason?: string) => void): () => void;
  throwIfCancelled(): void;
  toAbortSignal(): AbortSignal;
}

export class CancellationSource {
  private _cancelled = false;
  private _reason: string | undefined;
  private callbacks = new Set<(reason?: string) => void>();
  private abortController = new AbortController();

  readonly token: CancellationToken;

  constructor() {
    const self = this;
    this.token = {
      get isCancelled() {
        return self._cancelled;
      },
      get reason() {
        return self._reason;
      },
      onCancel(cb) {
        if (self._cancelled) {
          queueMicrotask(() => cb(self._reason));
          return () => {};
        }
        self.callbacks.add(cb);
        return () => self.callbacks.delete(cb);
      },
      throwIfCancelled() {
        if (self._cancelled) throw new CancellationError(self._reason);
      },
      toAbortSignal() {
        return self.abortController.signal;
      },
    };
  }

  cancel(reason?: string): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this._reason = reason;
    try {
      this.abortController.abort(reason);
    } catch {}
    for (const cb of [...this.callbacks]) {
      try {
        cb(reason);
      } catch (err) {
        console.error('[cancellation] callback threw', err);
      }
    }
    this.callbacks.clear();
  }
}

export function linkedToken(...tokens: CancellationToken[]): CancellationToken {
  const src = new CancellationSource();
  for (const t of tokens) {
    if (t.isCancelled) {
      src.cancel(t.reason);
      break;
    }
    t.onCancel((r) => src.cancel(r));
  }
  return src.token;
}
