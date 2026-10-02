import { z } from "zod";
import { CapabilitySchema } from "../permissions/capabilities.js";
import { PERMISSION_MODES } from "../permissions/policy.js";
import { STARTUP_PATH_MODES } from "../platform/types.js";

/**
 * CROT configuration (version 1).
 *
 * No paths are built in: the workspace root is always supplied by the user,
 * either in a config file or on the command line.
 */
export const LimitsSchema = z
  .object({
    /** Maximum bytes returned by a single file read. */
    maxReadBytes: z.number().int().positive().default(10 * 1024 * 1024),
    /** Default timeout for foreground commands. */
    defaultCommandTimeoutMs: z.number().int().positive().default(120_000),
    /** Upper bound a caller may request for a foreground command timeout. */
    maxCommandTimeoutMs: z.number().int().positive().default(60 * 60 * 1000),
    /** Maximum captured bytes per output stream (stdout / stderr) of a command. */
    maxOutputBytes: z.number().int().positive().default(1024 * 1024),
    /** Maximum number of concurrently running background processes. */
    maxBackgroundProcesses: z.number().int().positive().default(16),
  })
  .strict();

export const AuditConfigSchema = z
  .object({
    /**
     * file: append JSON lines to `path`; stderr: write JSON lines to standard error;
     * none: disable auditing. Audit data never leaves the machine.
     */
    sink: z.enum(["file", "stderr", "none"]).default("stderr"),
    /** Audit file for the file sink; defaults to audit.jsonl in the platform logs directory. */
    path: z.string().min(1).optional(),
  })
  .strict();

export const EnvironmentConfigSchema = z
  .object({
    /**
     * PATH for commands. auto: on macOS/Linux, read the login shell's PATH when
     * CROT was not started from a shell (desktop-launched MCP clients);
     * login-shell: always; inherited: use the PATH CROT was started with.
     */
    path: z.enum(STARTUP_PATH_MODES).default("auto"),
  })
  .strict();

export const CrotConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    workspace: z
      .object({
        /** Workspace root. Relative values in a config file are resolved against the file's directory. */
        root: z.string().min(1),
        name: z.string().min(1).optional(),
      })
      .strict(),
    permissions: z
      .object({
        mode: z.enum(PERMISSION_MODES).default("sandbox"),
        /** Explicit capability set; omitted means the mode's defaults. */
        capabilities: z.array(CapabilitySchema).optional(),
      })
      .strict()
      .default({ mode: "sandbox" }),
    limits: LimitsSchema.default(LimitsSchema.parse({})),
    audit: AuditConfigSchema.default({ sink: "stderr" }),
    environment: EnvironmentConfigSchema.default({ path: "auto" }),
  })
  .strict();

export type CrotConfig = z.output<typeof CrotConfigSchema>;
export type CrotConfigInput = z.input<typeof CrotConfigSchema>;
export type Limits = z.output<typeof LimitsSchema>;
export type AuditConfig = z.output<typeof AuditConfigSchema>;
