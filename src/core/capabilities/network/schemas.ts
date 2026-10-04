import { z } from "zod";

/** HTTP methods of network_request. CONNECT and TRACE are never available. */
export const NETWORK_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/**
 * Headers the agent cannot set: CROT owns the connection (Host, framing,
 * connection management) and never talks to a proxy.
 */
export const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
  "expect",
  "http2-settings",
]);

/** Headers removed when a redirect leaves the origin. */
export const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(["authorization", "cookie"]);

/** Maximum request body (decoded bytes). */
export const MAX_NETWORK_REQUEST_BYTES = 1024 * 1024;

const HeaderNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, "invalid header name");
const HeaderValueSchema = z
  .string()
  .max(8192)
  .regex(/^[^\r\n\0]*$/, "header values cannot contain CR, LF or NUL");

export const NetworkRequestInputSchema = z
  .object({
    /** Absolute http: or https: URL without credentials. */
    url: z.string().min(1).max(8192),
    method: z.enum(NETWORK_METHODS).default("GET"),
    headers: z
      .record(HeaderNameSchema, HeaderValueSchema)
      .refine((h) => Object.keys(h).length <= 64, "at most 64 headers")
      .refine(
        (h) => Object.keys(h).every((name) => !FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())),
        `headers cannot include ${[...FORBIDDEN_REQUEST_HEADERS].join(", ")}`,
      )
      .optional(),
    /** Request body (not allowed for GET and HEAD). */
    body: z
      .string()
      .max(2 * MAX_NETWORK_REQUEST_BYTES)
      .optional(),
    bodyEncoding: z.enum(["utf8", "base64"]).default("utf8"),
    /** Follow redirects (each hop is checked like the first request). With false, 3xx responses are returned. */
    followRedirects: z.boolean().default(true),
    timeoutMs: z.number().int().positive().optional(),
    maxResponseBytes: z.number().int().positive().optional(),
    responseEncoding: z.enum(["utf8", "base64"]).default("utf8"),
  })
  .strict()
  .refine((r) => r.body === undefined || (r.method !== "GET" && r.method !== "HEAD"), {
    message: "GET and HEAD requests cannot have a body",
    path: ["body"],
  });

export type NetworkRequestInput = z.input<typeof NetworkRequestInputSchema>;

export interface NetworkRedirect {
  readonly url: string;
  readonly status: number;
}

export interface NetworkResponse {
  /** Final URL (after redirects). */
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly body: string;
  readonly bodyEncoding: "utf8" | "base64";
  /** Body bytes returned. */
  readonly bytes: number;
  /** The response body was longer than maxResponseBytes. */
  readonly truncated: boolean;
  readonly redirects: readonly NetworkRedirect[];
  /** Address the final response came from. */
  readonly remoteAddress: string;
}
