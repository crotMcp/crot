/**
 * Runner of the OS tools behind the secret backends (macOS `security`, Linux
 * `secret-tool`). No shell, absolute tool paths, bounded output, timeouts.
 *
 * Secrets are passed only on stdin and read only from stdout, never in the
 * argument vector (visible to other local users in the process list) and
 * never in the environment. Callers never put stdout into error messages:
 * only the first line of stderr is reported.
 */
import { spawn } from "node:child_process";

export interface ToolResult {
  /** Exit code; null when the tool was killed (timeout) or could not start. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Start failure (ENOENT, EACCES, ...). */
  readonly error?: string;
}

export interface ToolRunOptions {
  /** Written to stdin, then stdin is closed. */
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type SecretToolRunner = (file: string, args: readonly string[], options?: ToolRunOptions) => Promise<ToolResult>;

const MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

export const runSecretTool: SecretToolRunner = (file, args, options = {}) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        ...(options.env ? { env: { ...options.env } } : {}),
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: (error as Error).message });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let startError: string | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (outBytes < MAX_OUTPUT_BYTES) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (errBytes < MAX_OUTPUT_BYTES) err.push(chunk);
      errBytes += chunk.length;
    });
    child.on("error", (error) => {
      startError = error.message;
    });
    child.stdin!.on("error", () => undefined);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut || startError ? null : code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        ...(startError ? { error: startError } : {}),
      });
    });
    child.stdin!.end(options.input ?? "");
  });

/** First line of a tool's diagnostics, for error messages (never stdout: it may carry a secret). */
export function toolDiagnostic(result: ToolResult, tool: string): string {
  if (result.error) return `${tool} could not be started: ${result.error.split(/\r?\n/)[0]!.slice(0, 200)}`;
  if (result.timedOut) return `${tool} did not answer in time`;
  const line = result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 200);
  return `${tool} failed (exit ${String(result.code)})${line ? `: ${line}` : ""}`;
}
