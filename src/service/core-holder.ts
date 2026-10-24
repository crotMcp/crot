/**
 * The service's indirection to its current Core (ARCHITECTURE.md §27, AD-19
 * point 5).
 *
 * MCP connections and the HTTP adapter hold one CrotCore reference for their
 * whole lifetime. A preset change builds a new Core with the new, again
 * immutable, policy; the adapters keep working through this delegating
 * object, which always forwards to the current Core. It also counts calls
 * into the capability services that have not settled yet, so that the switch
 * happens only while nothing runs (operations that have not reached the
 * ExecutionGuard yet included).
 */
import { CrotError } from "../core/errors.js";
import type { CoreActivity, CoreCompositionHandle, CrotCore } from "../core/crot-core.js";

/** Core members whose methods start operations; calls into them are counted. */
const SERVICE_MEMBERS: ReadonlySet<PropertyKey> = new Set([
  "filesystem",
  "processes",
  "git",
  "docker",
  "browser",
  "network",
]);

export interface CoreActivitySummary extends CoreActivity {
  /** Calls into capability services through the adapters that have not settled. */
  readonly adapterCalls: number;
}

export class CoreHolder {
  private current: CrotCore;
  private handle: CoreCompositionHandle;
  private calls = 0;
  private transition: object | undefined;
  private assertAdmission(): void {
    if (this.transition)
      throw new CrotError("RESOURCE_BUSY", "Core policy transition is in progress; retry after owner confirmation");
  }
  /** Exclusive owner lifecycle lease. Failure may deliberately leave admission closed. */
  pauseAdmission(): { install: (core: CrotCore, handle: CoreCompositionHandle) => void; release: () => void } {
    this.assertAdmission();
    const token = {};
    this.transition = token;
    let installed = false;
    return Object.freeze({
      install: (core: CrotCore, handle: CoreCompositionHandle) => {
        if (this.transition !== token || installed)
          throw new CrotError("RESOURCE_BUSY", "Invalid Core transition lease");
        this.current = core;
        this.handle = handle;
        installed = true;
      },
      release: () => {
        if (this.transition !== token) throw new CrotError("RESOURCE_BUSY", "Invalid Core transition lease");
        this.transition = undefined;
      },
    });
  }
  operation:
    | ((member: string, method: string, args: unknown[], run: (args: unknown[]) => unknown) => Promise<unknown>)
    | undefined;
  /** The object handed to adapters: always forwards to the current Core. */
  readonly core: CrotCore;

  constructor(initial: CrotCore, handle: CoreCompositionHandle) {
    this.current = initial;
    this.handle = handle;
    const services = new Map<PropertyKey, { target: object; proxy: object }>();
    this.core = new Proxy(initial, {
      get: (_target, prop) => {
        const core = this.current;
        const value: unknown = Reflect.get(core, prop, core);
        if (SERVICE_MEMBERS.has(prop) && typeof value === "object" && value !== null) {
          const cached = services.get(prop);
          if (cached && cached.target === value) return cached.proxy;
          const proxy = this.countingProxy(value, String(prop));
          services.set(prop, { target: value, proxy });
          return proxy;
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(core) : value;
      },
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
    });
  }

  /** Service-owned multi-step workflows hold the same idle-switch barrier as adapter calls. */
  async hold<T>(work: () => Promise<T>): Promise<T> {
    this.assertAdmission();
    this.calls++;
    try {
      return await work();
    } finally {
      this.calls--;
    }
  }

  /** The current Core itself (service internals only). */
  get instance(): CrotCore {
    return this.current;
  }

  get composition(): CoreCompositionHandle {
    return this.handle;
  }

  /** Everything that keeps the current Core busy. */
  activity(): CoreActivitySummary {
    return { ...this.handle.activity(), adapterCalls: this.calls };
  }

  /** A human-readable reason why the Core is busy, or undefined when it is idle. */
  busyReason(): string | undefined {
    const a = this.activity();
    const parts: string[] = [];
    if (this.transition) parts.push("Core policy transition in progress");
    if (a.adapterCalls > 0 || a.operationsInFlight > 0)
      parts.push(`${Math.max(a.adapterCalls, a.operationsInFlight)} operation(s) running`);
    if (a.pendingApprovals > 0) parts.push(`${a.pendingApprovals} approval request(s) pending`);
    if (a.runningBackgroundProcesses > 0)
      parts.push(`${a.runningBackgroundProcesses} background process(es) running (stop them first)`);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }

  /**
   * Make `next` the current Core. Synchronous: the caller checks
   * busyReason() and swaps in the same step. Returns the previous Core,
   * which the caller shuts down.
   */
  swap(next: CrotCore, handle: CoreCompositionHandle): CrotCore {
    this.assertAdmission();
    const previous = this.current;
    this.current = next;
    this.handle = handle;
    return previous;
  }

  private countingProxy(service: object, member: string): object {
    return new Proxy(service, {
      get: (target, prop) => {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        const fn = value as (...a: unknown[]) => unknown;
        return (...args: unknown[]) => {
          this.assertAdmission();
          this.calls++;
          let result: unknown;
          try {
            result = this.operation
              ? this.operation(member, String(prop), args, (a) => fn.apply(target, a))
              : fn.apply(target, args);
          } catch (error) {
            this.calls--;
            throw error;
          }
          if (result instanceof Promise) {
            return result.finally(() => {
              this.calls--;
            });
          }
          this.calls--;
          return result;
        };
      },
    });
  }
}
