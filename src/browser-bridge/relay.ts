/**
 * crot-browser-relay: the native-messaging host the browser launches for the
 * CROT Browser Extension (ARCHITECTURE.md §16).
 *
 *   CROT Browser Extension <-native messaging (stdin/stdout)-> crot-browser-relay <-IPC-> BrowserBridge (CROT Host)
 *
 * The relay is a dumb transport. It performs no authorization and never
 * interprets the messages it carries:
 * - It reads the bridge token from <state>/browser-token, connects to the
 *   bridge endpoint derived from it and sends the `auth` frame first.
 * - It then copies frames in both directions, checking only the framing
 *   (non-empty, within the direction's size limit). Frames are never altered,
 *   merged or synthesized; any framing violation ends the relay.
 * - It connects only to the bridge endpoint, never retries and never starts
 *   CROT. When the bridge is unavailable it exits; the extension reconnects.
 *
 * Every message from the browser is validated by the BrowserBridge, which only
 * accepts responses to requests it sent, and every request is issued by Core
 * after the PermissionEngine authorized the operation. The relay cannot widen
 * either.
 *
 * The browser checks the extension origin against the host manifest's
 * allowed_origins before launching the relay. The relay ignores the origin
 * argument (and --parent-window on Windows); the launcher installed by
 * `crot-mcp browser install` passes --state-dir.
 *
 * stdout carries frames only. Diagnostics go to `log` (stderr in the
 * executable) and never include the token.
 */
import net from "node:net";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { CrotError } from "../core/errors.js";
import { bridgeEndpoint, bridgeTokenFile, readBridgeToken } from "./endpoint.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  FrameReader,
  MAX_BROWSER_TO_HOST_FRAME_BYTES,
  MAX_HANDSHAKE_FRAME_BYTES,
  MAX_HOST_TO_BROWSER_FRAME_BYTES,
  encodeFrame,
  encodeMessage,
} from "./protocol.js";

/** After the browser closed stdin: how long to wait for the bridge to close the connection. */
export const RELAY_CLOSE_TIMEOUT_MS = 2_000;

const STATE_DIR_OPTION = "--state-dir";

export interface RelayArgs {
  readonly stateDir: string;
}

export interface RelayOptions {
  /** CROT state directory (token file, POSIX socket). */
  readonly stateDir: string;
  /** Frames from the browser (stdin). */
  readonly input: Readable;
  /** Frames to the browser (stdout). Nothing else is ever written to it. */
  readonly output: Writable;
  /** Diagnostics (never receives the token or message contents). */
  readonly log: (message: string) => void;
}

/**
 * Parse the relay's command line: --state-dir <dir> or --state-dir=<dir>, an
 * absolute path, exactly once. Other arguments (the extension origin, and
 * --parent-window=N on Windows, appended by the browser) are ignored.
 */
export function parseRelayArgs(args: readonly string[]): RelayArgs {
  let stateDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === STATE_DIR_OPTION) {
      value = args[++i];
      if (value === undefined) throw new CrotError("CONFIG_ERROR", STATE_DIR_OPTION + " requires a value.");
    } else if (arg.startsWith(STATE_DIR_OPTION + "=")) {
      value = arg.slice(STATE_DIR_OPTION.length + 1);
    } else {
      continue;
    }
    if (stateDir !== undefined) throw new CrotError("CONFIG_ERROR", STATE_DIR_OPTION + " was given more than once.");
    if (value === "" || !path.isAbsolute(value)) throw new CrotError("CONFIG_ERROR", STATE_DIR_OPTION + " must be an absolute path.");
    stateDir = value;
  }
  if (stateDir === undefined) {
    throw new CrotError(
      "CONFIG_ERROR",
      "Missing " + STATE_DIR_OPTION + " <dir>. crot-browser-relay is started by the browser through the launcher installed by `crot-mcp browser install`.",
    );
  }
  return { stateDir };
}

/**
 * Run the relay until either side closes. Resolves with the process exit code
 * (0 after an orderly close, 1 on any error); never rejects.
 */
export async function runRelay(options: RelayOptions): Promise<number> {
  const { stateDir, log } = options;
  let token: string | undefined;
  let endpoint: string;
  try {
    const tokenFile = bridgeTokenFile(stateDir);
    token = await readBridgeToken(tokenFile);
    if (token === undefined) {
      log("The browser bridge is not set up: " + tokenFile + " does not exist. Start CROT with the browser bridge enabled.");
      return 1;
    }
    endpoint = bridgeEndpoint(stateDir, token).path;
  } catch (error) {
    log(errorMessage(error));
    return 1;
  }

  let socket: net.Socket;
  try {
    socket = await connect(endpoint);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The endpoint is not part of the message: on Windows its name is derived from the token.
    log(
      code === "ENOENT" || code === "ECONNREFUSED"
        ? "No CROT instance is listening on the browser bridge (" + code + "). Start CROT with the browser bridge enabled."
        : "Cannot connect to the browser bridge (" + (code ?? "unknown error") + ").",
    );
    return 1;
  }
  const auth = encodeMessage({ type: "auth", protocol: BRIDGE_PROTOCOL_VERSION, token }, MAX_HANDSHAKE_FRAME_BYTES);
  return relay(socket, auth, options);
}

function connect(endpoint: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

function relay(socket: net.Socket, auth: Uint8Array, { input, output, log }: RelayOptions): Promise<number> {
  return new Promise((resolve) => {
    const fromBrowser = new FrameReader(MAX_BROWSER_TO_HOST_FRAME_BYTES);
    const fromHost = new FrameReader(MAX_HOST_TO_BROWSER_FRAME_BYTES);
    let framesFromHost = 0;
    let inputEnded = false;
    let inputPaused = false;
    let socketPaused = false;
    let finished = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const ignore = () => undefined;

    const finish = (code: number, reason?: string) => {
      if (finished) return;
      finished = true;
      if (reason !== undefined) log(reason);
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      input.off("data", onInput);
      input.off("end", onInputEnd);
      input.off("close", onInputClose);
      input.off("error", onInputError);
      input.pause();
      socket.off("data", onSocketData);
      socket.off("close", onSocketClose);
      socket.off("error", onSocketError);
      output.off("error", onOutputError);
      // Late errors (EPIPE, reset) must not surface as unhandled 'error' events.
      input.on("error", ignore);
      socket.on("error", ignore);
      output.on("error", ignore);
      socket.destroy();
      resolve(code);
    };

    // Browser -> CROT.
    const onInput = (chunk: Buffer) => {
      if (finished) return;
      let bodies: Uint8Array[];
      try {
        bodies = fromBrowser.push(chunk);
      } catch (error) {
        finish(1, "Invalid frame from the browser: " + errorMessage(error));
        return;
      }
      let flowing = true;
      for (const body of bodies) if (!socket.write(encodeFrame(body))) flowing = false;
      if (!flowing && !inputPaused) {
        inputPaused = true;
        input.pause();
        socket.once("drain", () => {
          inputPaused = false;
          if (!finished) input.resume();
        });
      }
    };
    const onInputEnd = () => {
      if (fromBrowser.bufferedBytes > 0) {
        finish(1, "The browser closed the connection in the middle of a frame.");
        return;
      }
      // The browser disconnected: close the IPC connection and let the bridge return to waiting.
      inputEnded = true;
      socket.end();
      closeTimer = setTimeout(() => finish(0), RELAY_CLOSE_TIMEOUT_MS);
    };
    // A stdin destroyed without an orderly end is the same disconnect.
    const onInputClose = () => {
      if (!inputEnded) onInputEnd();
    };
    const onInputError = (error: Error) => finish(1, "Cannot read from the browser: " + errorMessage(error));

    // CROT -> browser.
    const onSocketData = (chunk: Buffer) => {
      if (finished) return;
      let bodies: Uint8Array[];
      try {
        bodies = fromHost.push(chunk);
      } catch (error) {
        finish(1, "Invalid frame from CROT: " + errorMessage(error));
        return;
      }
      framesFromHost += bodies.length;
      let flowing = true;
      for (const body of bodies) if (!output.write(encodeFrame(body))) flowing = false;
      if (!flowing && !socketPaused) {
        socketPaused = true;
        socket.pause();
        output.once("drain", () => {
          socketPaused = false;
          if (!finished) socket.resume();
        });
      }
    };
    const onSocketClose = () => {
      if (inputEnded) finish(0);
      else if (fromHost.bufferedBytes > 0) finish(1, "CROT closed the browser bridge connection in the middle of a frame.");
      else if (framesFromHost === 0) {
        finish(
          1,
          "CROT closed the browser bridge connection during the handshake (authentication failed, the handshake timed out, or another browser is already connected).",
        );
      } else finish(0, "CROT closed the browser bridge connection.");
    };
    const onSocketError = (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(1, "Browser bridge connection error (" + (code ?? error.message) + ").");
    };
    const onOutputError = (error: Error) => {
      // After the browser closed stdin, a failing stdout is part of the same orderly disconnect.
      if (inputEnded) finish(0);
      else finish(1, "Cannot write to the browser: " + errorMessage(error));
    };

    socket.on("error", onSocketError);
    socket.on("close", onSocketClose);
    output.on("error", onOutputError);
    // The auth frame always goes first; browser frames are read only from here on.
    socket.write(auth);
    socket.on("data", onSocketData);
    input.on("error", onInputError);
    input.on("end", onInputEnd);
    input.on("close", onInputClose);
    input.on("data", onInput);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
