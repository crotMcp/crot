import { z } from "zod";
import { SHELL_IDS } from "../../platform/types.js";

/** Input schemas for process operations, owned by Core and reused by adapters. */
const Cwd = z.string().min(1).default(".").describe("Working directory: absolute, or relative to the workspace root.");
const EnvName = z
  .string()
  .min(1)
  .regex(/^[^=\0]+$/, "Environment variable names must not contain '=' or NUL.");
const Env = z
  .record(EnvName, z.string().regex(/^[^\0]*$/, "Environment values must not contain NUL.").nullable())
  .optional()
  .describe(
    "Environment variables added to or overriding the CROT process environment; null removes a variable. Names are case-insensitive on Windows.",
  );
const Shell = z
  .enum(SHELL_IDS)
  .optional()
  .describe("Shell to use (sh, bash, zsh, cmd, powershell, pwsh). Defaults to the platform shell; see crot_status for available shells.");
const TimeoutMs = z.number().int().positive().optional().describe("Timeout in milliseconds (bounded by the configured maximum).");
const Command = z.string().min(1).describe("Executable name or path. Not interpreted by a shell.");
const Args = z.array(z.string()).default([]).describe("Arguments passed verbatim to the executable.");
const Script = z.string().min(1).describe("Script interpreted by the selected shell (default: /bin/sh on Linux/macOS, cmd.exe on Windows).");

export const ExecInputSchema = z
  .object({
    command: Command,
    args: Args,
    cwd: Cwd,
    env: Env,
    timeoutMs: TimeoutMs,
    stdin: z.string().optional().describe("Data written to the process's standard input."),
  })
  .strict();

export const ShellInputSchema = z
  .object({
    script: Script,
    shell: Shell,
    cwd: Cwd,
    env: Env,
    timeoutMs: TimeoutMs,
    stdin: z.string().optional(),
  })
  .strict();

export const StartProcessInputSchema = z
  .object({
    command: Command.optional(),
    args: Args,
    script: Script.optional(),
    shell: Shell.describe("Shell for 'script' (ignored for 'command')."),
    cwd: Cwd,
    env: Env,
    timeoutMs: TimeoutMs.describe("Optional lifetime limit. Background processes run until stopped by default."),
  })
  .strict()
  .refine((v) => (v.command === undefined) !== (v.script === undefined), {
    message: "Provide exactly one of 'command' or 'script'.",
  });

export const ProcessIdInputSchema = z.object({ id: z.string().min(1).describe("Background process id returned by start.") }).strict();

export const ReadOutputInputSchema = z
  .object({
    id: z.string().min(1),
    stdoutOffset: z.number().int().nonnegative().default(0).describe("Return stdout from this byte offset (use the previous nextStdoutOffset)."),
    stderrOffset: z.number().int().nonnegative().default(0).describe("Return stderr from this byte offset (use the previous nextStderrOffset)."),
  })
  .strict();

export const StopProcessInputSchema = z
  .object({
    id: z.string().min(1),
    force: z.boolean().default(false).describe("Kill immediately instead of requesting graceful termination."),
  })
  .strict();

export type ExecInput = z.input<typeof ExecInputSchema>;
export type ShellInput = z.input<typeof ShellInputSchema>;
export type StartProcessInput = z.input<typeof StartProcessInputSchema>;
export type ProcessIdInput = z.input<typeof ProcessIdInputSchema>;
export type ReadOutputInput = z.input<typeof ReadOutputInputSchema>;
export type StopProcessInput = z.input<typeof StopProcessInputSchema>;

export interface ExecResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when earlier output was discarded; only the last maxOutputBytes are kept. */
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export type ProcessStatus = "running" | "exited";

export interface ProcessInfo {
  readonly id: string;
  readonly pid: number | null;
  readonly command: string;
  readonly cwd: string;
  readonly status: ProcessStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
}

export interface ProcessOutput {
  readonly id: string;
  readonly status: ProcessStatus;
  readonly stdout: string;
  readonly stderr: string;
  readonly nextStdoutOffset: number;
  readonly nextStderrOffset: number;
  /** Bytes that were discarded before the requested offset could be served. */
  readonly stdoutDroppedBytes: number;
  readonly stderrDroppedBytes: number;
}
