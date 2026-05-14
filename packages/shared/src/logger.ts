import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

let rootLogger: Logger | null = null;

export function getLogger(name?: string): Logger {
  if (!rootLogger) {
    const level = process.env.LOG_LEVEL ?? 'info';
    const isProd = process.env.NODE_ENV === 'production';
    rootLogger = pino({
      level,
      base: { app: 'friday' },
      transport: isProd
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname,app',
            },
          },
    });
  }
  return name ? rootLogger.child({ mod: name }) : rootLogger;
}
