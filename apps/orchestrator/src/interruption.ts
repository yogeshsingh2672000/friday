import { CancellationSource, getLogger, type CancellationToken } from '@friday/shared';

const log = getLogger('orchestrator:interrupt');

export type InterruptReason = 'user_voice' | 'manual' | 'wake' | 'error';

/**
 * Tracks the current "active" turn's cancellation source. `arm()` issues a
 * fresh token bound to the new turn; `fire()` cancels it and clears the
 * armed slot. Safe to call `fire()` repeatedly — it is idempotent per arm.
 *
 * The orchestrator wires every long-lived per-turn operation (Claude stream,
 * tool execution, TTS WS) to this token. Firing collapses the whole stack
 * atomically.
 */
export class InterruptionManager {
  private current: { source: CancellationSource; turnId: string } | null = null;

  arm(turnId: string): CancellationToken {
    if (this.current) {
      log.warn({ prev: this.current.turnId, next: turnId }, 'arm() called while previous turn still active — cancelling previous');
      this.current.source.cancel('superseded');
    }
    const source = new CancellationSource();
    this.current = { source, turnId };
    return source.token;
  }

  fire(reason: InterruptReason): boolean {
    if (!this.current) return false;
    const { turnId, source } = this.current;
    log.info({ turnId, reason }, 'interrupt fired');
    source.cancel(reason);
    this.current = null;
    return true;
  }

  disarm(turnId: string): void {
    if (this.current && this.current.turnId === turnId) {
      this.current = null;
    }
  }

  get armedTurnId(): string | null {
    return this.current?.turnId ?? null;
  }
}
