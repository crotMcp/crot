import { bridgeTokenFile } from "../browser-bridge/endpoint.js";
import { BrowserBridge, type BrowserBridgeOptions } from "../browser-bridge/server.js";
import type { PrivateFileProtection } from "../core/platform/types.js";

/**
 * Host-side wiring of the browser bridge (ARCHITECTURE.md §16).
 *
 * The bridge is a transport only: it is handed to Core as its browser
 * connection and every browser tool call is still authorized by the
 * PermissionEngine. Nothing here grants a capability.
 */
export interface BrowserWiringOptions {
  /** `browser.enabled` from the parsed configuration. */
  readonly enabled: boolean;
  /** CROT state directory (token file, POSIX socket). */
  readonly stateDir: string;
  readonly privateFiles: PrivateFileProtection;
  /** Diagnostics on stderr (never receives the token). */
  readonly log: (message: string) => void;
  /** Replace BrowserBridge.start (tests). */
  readonly start?: (options: BrowserBridgeOptions) => Promise<BrowserBridge>;
}

/**
 * Files that CROT tools may never touch when the browser bridge is enabled:
 * the bridge token file. The path is deterministic, so it is protected even
 * when the bridge fails to start (the file may still exist).
 */
export function browserProtectedPaths(enabled: boolean, stateDir: string): string[] {
  return enabled ? [bridgeTokenFile(stateDir)] : [];
}

/**
 * Start the browser bridge when it is enabled. A bridge that cannot start
 * (invalid token file, a non-socket file at the socket path, a socket path
 * that is too long, ...) never stops CROT: a warning is logged and CROT runs
 * without a browser connection. Another CROT instance owning the bridge is not
 * an error: the bridge then stays in_use for its lifetime.
 */
export async function startBrowserBridge(options: BrowserWiringOptions): Promise<BrowserBridge | undefined> {
  if (!options.enabled) return undefined;
  const start = options.start ?? ((o: BrowserBridgeOptions) => BrowserBridge.start(o));
  let bridge: BrowserBridge;
  try {
    bridge = await start({ stateDir: options.stateDir, privateFiles: options.privateFiles, log: options.log });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.log(`warning: browser bridge unavailable: ${detail}; continuing without browser tools`);
    return undefined;
  }
  const status = bridge.status();
  if (status.state === "in_use") {
    options.log("browser bridge: in use by another CROT instance; browser operations fail with BROWSER_BRIDGE_IN_USE in this instance");
  } else {
    options.log(`browser bridge: ${status.state} for the CROT Browser Extension on ${status.endpoint.path}`);
  }
  return bridge;
}
