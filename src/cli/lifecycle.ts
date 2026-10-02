/**
 * Shutdown lifecycle of a CROT host process (the stdio server today).
 *
 * - The platform's shutdown signals (SIGINT, SIGTERM, SIGHUP; on Windows also
 *   SIGBREAK and SIGHUP for a closed console window) and the end of the
 *   transport start one graceful shutdown.
 * - A second signal, a fatal error during shutdown, or exceeding the deadline
 *   forces an immediate exit.
 * - On every exit path, the 'exit' hook synchronously force-kills any process
 *   tree CROT started, so no command outlives CROT.
 */

/** The subset of `process` the lifecycle needs (injectable for tests). */
export interface LifecycleHost {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface LifecycleOptions {
  readonly host: LifecycleHost;
  readonly signals: readonly string[];
  /** Graceful shutdown (close transport, Core shutdown, flush). */
  readonly shutdown: (reason: string) => Promise<void>;
  /** Synchronous last-resort cleanup (force-kill process trees). */
  readonly emergency: () => void;
  readonly exit: (code: number) => void;
  readonly log: (message: string) => void;
  /** Deadline for the graceful shutdown before exiting anyway. */
  readonly timeoutMs: number;
}

export interface Lifecycle {
  /** Start the graceful shutdown (idempotent) and exit with `code` when done. */
  stop(reason: string, code: number): void;
}

export function installLifecycle(options: LifecycleOptions): Lifecycle {
  let stopping = false;
  let exited = false;
  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    options.exit(code);
  };
  const force = (reason: string) => {
    options.log(`${reason}; forcing exit`);
    options.emergency();
    exit(1);
  };

  const stop = (reason: string, code: number) => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => force(`shutdown did not finish within ${options.timeoutMs} ms`), options.timeoutMs);
    timer.unref?.();
    options.shutdown(reason).then(
      () => {
        clearTimeout(timer);
        exit(code);
      },
      (error: unknown) => {
        clearTimeout(timer);
        force(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  };

  for (const signal of options.signals) {
    options.host.on(signal, () => {
      if (stopping) force(`received ${signal} during shutdown`);
      else stop(signal, 0);
    });
  }
  const fatal = (kind: string) => (error: unknown) => {
    options.log(`${kind}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    if (stopping) force(kind);
    else stop(kind, 1);
  };
  options.host.on("uncaughtException", fatal("uncaught exception"));
  options.host.on("unhandledRejection", fatal("unhandled rejection"));
  // Runs synchronously on every exit path, including process.exit() elsewhere.
  options.host.on("exit", () => options.emergency());
  return { stop };
}

/** Resolve once `stream` has flushed what was written so far (bounded wait). */
export function flushStream(stream: NodeJS.WritableStream, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    try {
      stream.write("", () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}
