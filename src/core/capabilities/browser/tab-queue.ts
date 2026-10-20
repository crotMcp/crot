import { CrotError } from "../../errors.js";

interface Entry {
  start(): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abort(): void;
}
interface Queue {
  running: boolean;
  waiting: Entry[];
}

/** One running operation plus at most 16 waiting operations, FIFO per connection/tab. */
export class TabQueue {
  private readonly queues = new Map<string, Queue>();
  run<T>(key: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(this.cancelled());
    const queue = this.queues.get(key) ?? { running: false, waiting: [] };
    if (queue.running && queue.waiting.length >= 16)
      return Promise.reject(new CrotError("RESOURCE_BUSY", "Too many browser commands are queued for this tab."));
    this.queues.set(key, queue);
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        ...(signal ? { signal } : {}),
        reject,
        abort: () => {
          const index = queue.waiting.indexOf(entry);
          if (index < 0) return;
          queue.waiting.splice(index, 1);
          signal?.removeEventListener("abort", entry.abort);
          reject(this.cancelled());
        },
        start: () => {
          signal?.removeEventListener("abort", entry.abort);
          queue.running = true;
          void Promise.resolve()
            .then(action)
            .then(resolve, reject)
            .finally(() => {
              const next = queue.waiting.shift();
              if (next) next.start();
              else {
                queue.running = false;
                if (this.queues.get(key) === queue) this.queues.delete(key);
              }
            });
        },
      };
      if (!queue.running) entry.start();
      else {
        queue.waiting.push(entry);
        signal?.addEventListener("abort", entry.abort, { once: true });
      }
    });
  }
  clear(): void {
    for (const queue of this.queues.values())
      for (const entry of queue.waiting.splice(0)) {
        entry.signal?.removeEventListener("abort", entry.abort);
        entry.reject(this.cancelled());
      }
    this.queues.clear();
  }
  private cancelled(): CrotError {
    return new CrotError("OPERATION_FAILED", "Browser command cancelled before execution.");
  }
}
