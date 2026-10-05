/**
 * Client of the control channel (WP-20, AD-17): `crot-mcp service status`
 * and `crot-mcp service stop`. The tray and its ApprovalProvider (WP-22) use
 * the same channel. The channel carries no MCP and no tools.
 */
import type { PrivateFileProtection } from "../core/platform/types.js";
import { ChannelError, connectChannel, type AuthenticatedChannel } from "./channel.js";
import { fileCredentialStore, isListening, serviceEndpoint, type CredentialStore } from "./endpoints.js";
import { parseControlResponse, type ControlMethod } from "./protocol.js";

const REQUEST_TIMEOUT_MS = 10_000;

export class ControlClient {
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(private readonly channel: AuthenticatedChannel) {
    channel.onmessage = (value) => {
      const response = parseControlResponse(value);
      const waiter = response ? this.waiting.get(response.id) : undefined;
      if (!response || !waiter) return channel.destroy();
      this.waiting.delete(response.id);
      if ("error" in response) waiter.reject(new Error(response.error.message));
      else waiter.resolve(response.result);
    };
    channel.onclose = () => {
      for (const waiter of this.waiting.values())
        waiter.reject(new ChannelError("closed", "The CROT service closed the control connection."));
      this.waiting.clear();
    };
    channel.start();
  }

  /** Connect to the running service; undefined when no service is running. */
  static async connect(options: {
    readonly stateDir: string;
    readonly privateFiles: PrivateFileProtection;
    readonly credentials?: CredentialStore;
    readonly windows?: boolean;
  }): Promise<ControlClient | undefined> {
    const store = options.credentials ?? fileCredentialStore(options.stateDir, options.privateFiles);
    const credential = await store.read("control");
    if (credential === undefined) return undefined;
    const endpoint = serviceEndpoint(options.stateDir, "control", credential, options.windows);
    try {
      return new ControlClient(
        await connectChannel(endpoint.path, { channel: "control", credential, maxFrameBytes: 1024 * 1024 }),
      );
    } catch (error) {
      if (error instanceof ChannelError && error.reason === "unreachable") return undefined;
      throw error;
    }
  }

  request(method: ControlMethod): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new ChannelError("timeout", `The CROT service did not answer '${method}'.`));
      }, REQUEST_TIMEOUT_MS);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      if (!this.channel.send({ t: "request", id, method }) && this.channel.isClosed) {
        this.waiting.delete(id);
        clearTimeout(timer);
        reject(new ChannelError("closed", "The control connection is closed."));
      }
    });
  }

  close(): void {
    this.channel.close();
  }
}

/** Wait until nothing listens on the service's shim endpoint any more (after `shutdown`). */
export async function waitForServiceExit(
  stateDir: string,
  credential: string | undefined,
  timeoutMs: number,
  windows?: boolean,
): Promise<boolean> {
  if (credential === undefined) return true;
  const endpoint = serviceEndpoint(stateDir, "service", credential, windows);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await isListening(endpoint.path, 500))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
