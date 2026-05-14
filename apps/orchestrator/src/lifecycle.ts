import { getLogger } from '@friday/shared';

const log = getLogger('orchestrator:lifecycle');

export type Disposer = () => Promise<void> | void;

/**
 * Registers process-level shutdown hooks (SIGINT, SIGTERM, uncaughtException,
 * unhandledRejection). Disposers run in reverse registration order.
 */
export class LifecycleManager {
  private disposers: Disposer[] = [];
  private shuttingDown = false;

  register(d: Disposer): void {
    this.disposers.push(d);
  }

  attach(): void {
    const handler = (signal: string) => async () => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      log.info({ signal }, 'shutdown initiated');
      for (const d of [...this.disposers].reverse()) {
        try {
          await d();
        } catch (err) {
          log.error({ err }, 'disposer failed');
        }
      }
      log.info('shutdown complete');
      process.exit(0);
    };
    process.on('SIGINT', handler('SIGINT'));
    process.on('SIGTERM', handler('SIGTERM'));
    process.on('uncaughtException', (err) => {
      log.error({ err }, 'uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
      log.error({ reason }, 'unhandledRejection');
    });
  }
}
