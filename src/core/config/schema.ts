import { z } from "zod";
import {
  DEFAULT_APPROVAL_MAX_PENDING,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_APPROVAL_TIMEOUT_MS,
} from "../approvals/rules.js";
import { UNTRUSTED_CONTENT_SETTINGS } from "../approvals/exposure.js";
import { CapabilitySchema } from "../permissions/capabilities.js";
import { NetworkPolicyConfigSchema } from "../permissions/network/policy.js";
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
    maxReadBytes: z
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    /** Default timeout for foreground commands. */
    defaultCommandTimeoutMs: z.number().int().positive().default(120_000),
    /** Upper bound a caller may request for a foreground command timeout. */
    maxCommandTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(60 * 60 * 1000),
    /** Maximum captured bytes per output stream (stdout / stderr) of a command. */
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .default(1024 * 1024),
    /** Maximum number of concurrently running background processes. */
    maxBackgroundProcesses: z.number().int().positive().default(16),
    /** Default timeout of a network request (DNS, connect, every redirect hop and the response body). */
    defaultNetworkTimeoutMs: z.number().int().positive().default(30_000),
    /** Upper bound a caller may request for a network request timeout. */
    maxNetworkTimeoutMs: z.number().int().positive().default(120_000),
    /** Maximum response body bytes returned by a network request (the rest is reported as truncated). */
    maxNetworkResponseBytes: z
      .number()
      .int()
      .positive()
      .default(1024 * 1024),
    /** Maximum redirects a network request follows. */
    maxNetworkRedirects: z.number().int().min(0).max(20).default(5),
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

/**
 * Authentication modes of the HTTP transport.
 *
 * local-token: provisional bearer token stored in a private file in the CROT
 * state directory (loopback only). Future verifiers (e.g. an OAuth/OIDC
 * resource-server verifier) are added as new modes behind the same verifier
 * interface; authorization always stays with the PermissionEngine.
 */
export const HTTP_AUTH_MODES = ["local-token"] as const;
export type HttpAuthMode = (typeof HTTP_AUTH_MODES)[number];

export const HttpAuthConfigSchema = z
  .object({
    mode: z.enum(HTTP_AUTH_MODES).default("local-token"),
    /** Token file for local-token; defaults to http-token in the platform state directory. */
    tokenFile: z.string().min(1).optional(),
  })
  .strict();

/**
 * Streamable HTTP MCP transport. Read only by the HTTP adapter; Core does not
 * act on it. Disabled by default; when enabled it binds to loopback and every
 * request must be authenticated.
 */
export const HttpConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Bind address. Only loopback addresses are accepted in this version. */
    host: z.string().min(1).default("127.0.0.1"),
    /** TCP port (0 picks a free port). */
    port: z.number().int().min(0).max(65535).default(7337),
    auth: HttpAuthConfigSchema.default({ mode: "local-token" }),
    /** Browser origins allowed to call the endpoint. Empty: requests carrying an Origin header are rejected. */
    allowedOrigins: z.array(z.string().min(1)).default([]),
    /** Maximum size of a request body. */
    maxRequestBytes: z
      .number()
      .int()
      .positive()
      .default(4 * 1024 * 1024),
    /** Maximum number of concurrent MCP sessions. */
    maxSessions: z.number().int().positive().default(16),
    /** Sessions without requests for this long are closed. */
    sessionIdleTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1000),
  })
  .strict();

/**
 * Browser bridge for the CROT Browser Extension (Chromium). Read only by the
 * CROT host, which starts the bridge and hands it to Core; Core does not act
 * on it. Disabled by default. Enabling the bridge grants nothing: browser
 * tools still require browser.read / browser.control from the
 * PermissionEngine (off in sandbox mode unless listed explicitly).
 */
export const BrowserConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strict();

/** One approval gate rule: an operation needs approval when every given condition matches. */
export const ApprovalRuleConfigSchema = z
  .object({
    /** Recorded in audit events and shown to the user ("why am I asked"). */
    id: z.string().min(1).max(100),
    match: z
      .object({
        operations: z.array(z.string().min(1)).min(1).optional(),
        capabilities: z.array(CapabilitySchema).min(1).optional(),
        principalKinds: z
          .array(z.enum(["local", "remote"]))
          .min(1)
          .optional(),
        modes: z.array(z.enum(PERMISSION_MODES)).min(1).optional(),
        outsideWorkspace: z.boolean().optional(),
        /** The session's exposure state (AD-12): true after it read untrusted content. */
        exposed: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

/**
 * Approval gates (ARCHITECTURE.md §27, AD-10, AD-12). No user rules by
 * default; the built-in `untrusted-content` rule is active unless turned off. With rules but without a registered approval provider (no tray app),
 * gated operations are denied.
 */
export const ApprovalsConfigSchema = z
  .object({
    rules: z.array(ApprovalRuleConfigSchema).default([]),
    /** How long a request waits for the user; then it expires (denied). At most 300 s. */
    timeoutMs: z.number().int().positive().max(MAX_APPROVAL_TIMEOUT_MS).default(DEFAULT_APPROVAL_TIMEOUT_MS),
    /** Pending requests at the same time; more are denied immediately. */
    maxPending: z.number().int().positive().default(DEFAULT_APPROVAL_MAX_PENDING),
    /**
     * Built-in rule `untrusted-content` (AD-12): after a session read a web
     * page, screenshot, tab list or network response, operations with effects
     * need approval. On by default; "off" turns it off.
     */
    untrustedContent: z.enum(UNTRUSTED_CONTENT_SETTINGS).default("require-approval"),
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
        /** Host policy of network.access; deny by default (ARCHITECTURE.md §27, AD-4). */
        network: NetworkPolicyConfigSchema.default({ allow: [], deny: [] }),
        /** Approval gates (AD-10). */
        approvals: ApprovalsConfigSchema.default(ApprovalsConfigSchema.parse({})),
      })
      .strict()
      .default({ mode: "sandbox", network: { allow: [], deny: [] }, approvals: ApprovalsConfigSchema.parse({}) }),
    limits: LimitsSchema.default(LimitsSchema.parse({})),
    audit: AuditConfigSchema.default({ sink: "stderr" }),
    environment: EnvironmentConfigSchema.default({ path: "auto" }),
    http: HttpConfigSchema.default(HttpConfigSchema.parse({})),
    browser: BrowserConfigSchema.default({ enabled: false }),
  })
  .strict();

export type CrotConfig = z.output<typeof CrotConfigSchema>;
export type CrotConfigInput = z.input<typeof CrotConfigSchema>;
export type Limits = z.output<typeof LimitsSchema>;
export type AuditConfig = z.output<typeof AuditConfigSchema>;
export type HttpConfig = z.output<typeof HttpConfigSchema>;
export type HttpConfigInput = z.input<typeof HttpConfigSchema>;
export type ApprovalsConfig = z.output<typeof ApprovalsConfigSchema>;
export type BrowserConfig = z.output<typeof BrowserConfigSchema>;
export type BrowserConfigInput = z.input<typeof BrowserConfigSchema>;
