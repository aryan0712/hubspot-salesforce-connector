import { logger } from './logger.js';

/**
 * Runs shutdown steps in order on SIGTERM/SIGINT (stop intake → drain in-flight work →
 * close resources), then exits. A second signal or the deadline forces exit, so a stuck
 * step can never keep a process alive forever. In-flight sync jobs and migration items that
 * do not finish in time keep their leases and are recovered by another worker (R08/R09).
 */
let draining = false;

/** True once shutdown began: readiness turns false so load balancers stop sending traffic. */
export function isShuttingDown(): boolean {
  return draining;
}

export function installGracefulShutdown(
  steps: (() => Promise<unknown>)[],
  opts: { deadlineMs?: number; exit?: (code: number) => void } = {},
): () => Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      exit(1);
      return;
    }
    shuttingDown = true;
    draining = true;
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out; exiting');
      exit(1);
    }, opts.deadlineMs ?? 25_000);
    force.unref?.();
    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        logger.error({ err }, 'shutdown step failed');
      }
    }
    clearTimeout(force);
    logger.info('shutdown complete');
    exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void shutdown());
  return shutdown;
}
