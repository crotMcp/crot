import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { AuthContext } from "../../auth/principal.js";
import type { Limits } from "../../config/schema.js";
import { CrotError, parseInput } from "../../errors.js";
import type { ExecutionGuard } from "../../execution/guard.js";
import { parseIp, type IpAddress } from "../../permissions/network/addresses.js";
import { normalizeHost, type NetworkTarget } from "../../permissions/network/policy.js";
import {
  CREDENTIAL_HEADERS,
  MAX_NETWORK_REQUEST_BYTES,
  NetworkRequestInputSchema,
  type NetworkRedirect,
  type NetworkRequestInput,
  type NetworkResponse,
} from "./schemas.js";

/**
 * Resolves a hostname to every address the connection may use. Replaceable
 * for tests and embedding; the default uses the operating system resolver.
 */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

type NetworkLimits = Pick<
  Limits,
  "defaultNetworkTimeoutMs" | "maxNetworkTimeoutMs" | "maxNetworkResponseBytes" | "maxNetworkRedirects"
>;

export interface NetworkServiceOptions {
  readonly guard: ExecutionGuard;
  readonly limits: NetworkLimits;
  readonly resolver?: HostResolver;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = "crot";

/** Names that always mean this machine (RFC 6761); never sent to DNS. */
function isLocalhostName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

export const systemResolver: HostResolver = async (hostname) => {
  if (isLocalhostName(hostname)) return ["127.0.0.1", "::1"];
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

interface ParsedUrl {
  readonly url: URL;
  readonly target: Omit<NetworkTarget, "addresses" | "requireTls">;
  /** Address of an IP-literal host. */
  readonly literal?: IpAddress;
}

/**
 * NetworkService: dedicated HTTP(S) requests gated by `network.access`
 * (ARCHITECTURE.md §27, AD-4).
 *
 * Every request runs through the ExecutionGuard in up to two operations per hop:
 * 1. `network.resolve` (names only): the hostname is authorized against the
 *    host policy *before* any DNS query, then resolved once;
 * 2. `network.request`: the hostname together with every resolved address is
 *    authorized (non-public addresses need explicit IP/CIDR rules), then the
 *    connection is made to exactly those addresses — the name is never
 *    resolved again, so a changed DNS answer (rebinding) cannot redirect it.
 * Redirects are followed manually and every hop is checked from step 1.
 * Proxy settings (HTTP_PROXY, HTTPS_PROXY, NO_PROXY, NODE_USE_ENV_PROXY) are
 * never used; CROT connects directly.
 */
export class NetworkService {
  private readonly guard: ExecutionGuard;
  private readonly limits: NetworkLimits;
  private readonly resolver: HostResolver;
  private readonly active = new Set<http.ClientRequest>();
  private closed = false;

  constructor(options: NetworkServiceOptions) {
    this.guard = options.guard;
    this.limits = options.limits;
    this.resolver = options.resolver ?? systemResolver;
  }

  async request(context: AuthContext, input: NetworkRequestInput): Promise<NetworkResponse> {
    const req = parseInput(NetworkRequestInputSchema, input);
    const timeoutMs = req.timeoutMs ?? this.limits.defaultNetworkTimeoutMs;
    if (timeoutMs > this.limits.maxNetworkTimeoutMs) {
      throw new CrotError("LIMIT_EXCEEDED", `timeoutMs exceeds the maximum of ${this.limits.maxNetworkTimeoutMs} ms.`);
    }
    const maxBytes = Math.min(
      req.maxResponseBytes ?? this.limits.maxNetworkResponseBytes,
      this.limits.maxNetworkResponseBytes,
    );
    let body =
      req.body === undefined ? undefined : Buffer.from(req.body, req.bodyEncoding === "base64" ? "base64" : "utf8");
    if (body && body.length > MAX_NETWORK_REQUEST_BYTES) {
      throw new CrotError("LIMIT_EXCEEDED", `Request body exceeds ${MAX_NETWORK_REQUEST_BYTES} bytes.`);
    }
    const deadline = Date.now() + timeoutMs;
    let method: string = req.method;
    let headers: Record<string, string> = { ...(req.headers ?? {}) };
    let current = parseTargetUrl(req.url);
    const redirects: NetworkRedirect[] = [];
    let requireTls = false;

    for (let hop = 0; ; hop++) {
      const target = await this.authorizeTarget(context, current, requireTls, deadline, hop);
      const response = await this.guard.run(
        context,
        {
          operation: "network.request",
          capability: "network.access",
          network: [target],
          details: { method, origin: current.url.origin, hop, followRedirects: req.followRedirects },
          approval: {
            summary: "Send an HTTP request",
            effects: [
              { label: "method", value: method },
              { label: "URL", value: current.url.href },
              { label: "redirect hop", value: String(hop) },
              { label: "header names", value: Object.keys(headers).join(", ") },
              ...(body ? [{ label: "body bytes", value: String(body.length), flag: "secret_size_only" as const }] : []),
            ],
          },
        },
        () => this.send(current, target, method, headers, body, maxBytes, deadline),
      );
      const location = response.location;
      if (req.followRedirects && REDIRECT_STATUSES.has(response.status) && location !== undefined) {
        if (redirects.length >= this.limits.maxNetworkRedirects) {
          throw new CrotError(
            "LIMIT_EXCEEDED",
            `Too many redirects (maximum ${this.limits.maxNetworkRedirects}); last location was not followed.`,
          );
        }
        let next: ParsedUrl;
        try {
          next = parseTargetUrl(new URL(location, current.url).href);
        } catch (error) {
          throw new CrotError(
            "OPERATION_FAILED",
            `Redirect to an unsupported location refused: ${(error as Error).message}`,
          );
        }
        redirects.push({ url: current.url.href, status: response.status });
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          if (method !== "HEAD") method = "GET";
          body = undefined;
          headers = withoutHeaders(headers, ["content-type"]);
        }
        if (next.url.origin !== current.url.origin) headers = withoutHeaders(headers, [...CREDENTIAL_HEADERS]);
        requireTls = current.url.protocol === "https:";
        current = next;
        continue;
      }
      return {
        url: current.url.href,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: req.responseEncoding === "base64" ? response.body.toString("base64") : response.body.toString("utf8"),
        bodyEncoding: req.responseEncoding,
        bytes: response.body.length,
        truncated: response.truncated,
        redirects,
        remoteAddress: response.remoteAddress,
      };
    }
  }

  /** Abort requests in flight and refuse new ones. */
  shutdown(): void {
    this.closed = true;
    for (const request of this.active) request.destroy(new CrotError("OPERATION_FAILED", "CROT is shutting down."));
    this.active.clear();
  }

  /**
   * Build the authorized destination of one hop. An IP literal is its own
   * address; a name is authorized by name first (no DNS query for a refused
   * name) and then resolved exactly once.
   */
  private async authorizeTarget(
    context: AuthContext,
    parsed: ParsedUrl,
    requireTls: boolean,
    deadline: number,
    hop: number,
  ): Promise<NetworkTarget> {
    const base: NetworkTarget = { ...parsed.target, ...(requireTls ? { requireTls } : {}) };
    if (parsed.literal) return { ...base, addresses: [parsed.literal] };
    return this.guard.run(
      context,
      {
        operation: "network.resolve",
        capability: "network.access",
        network: [base],
        details: { host: base.host, hop },
      },
      async () => {
        this.assertOpen();
        const answers = await withDeadline(this.resolver(base.host), deadline, `DNS lookup of ${base.host}`).catch(
          (error: unknown) => {
            if (error instanceof CrotError) throw error;
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOTFOUND" || code === "ENODATA") {
              throw new CrotError("NOT_FOUND", `Host not found: ${base.host}`, { errno: code });
            }
            throw new CrotError("OPERATION_FAILED", `DNS lookup of ${base.host} failed: ${code ?? String(error)}`, {
              ...(code ? { errno: code } : {}),
            });
          },
        );
        const addresses: IpAddress[] = [];
        for (const answer of answers) {
          const address = parseIp(answer);
          if (!address)
            throw new CrotError("OPERATION_FAILED", `DNS lookup of ${base.host} returned an invalid address.`);
          if (!addresses.some((a) => a.family === address.family && a.value === address.value)) addresses.push(address);
        }
        if (addresses.length === 0) throw new CrotError("NOT_FOUND", `Host not found: ${base.host}`);
        return { ...base, addresses };
      },
    );
  }

  private send(
    parsed: ParsedUrl,
    target: NetworkTarget,
    method: string,
    headers: Readonly<Record<string, string>>,
    body: Buffer | undefined,
    maxBytes: number,
    deadline: number,
  ): Promise<RawResponse> {
    this.assertOpen();
    const addresses = target.addresses ?? [];
    const first = addresses[0];
    if (!first) return Promise.reject(new CrotError("OPERATION_FAILED", "No authorized address to connect to."));
    // The connection may only use the addresses that were just authorized: the
    // lookup never consults DNS again (no rebinding between check and use).
    const pinned: LookupFunction = (_hostname, options, callback) => {
      const wanted = typeof options === "object" && options !== null ? options : {};
      const usable = addresses.filter((a) => !wanted.family || a.family === wanted.family);
      const list = usable.length > 0 ? usable : addresses;
      if (wanted.all) {
        (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(
          null,
          list.map((a) => ({ address: a.text, family: a.family })),
        );
      } else {
        callback(null, list[0]!.text, list[0]!.family);
      }
    };
    const secure = target.scheme === "https";
    const transport = secure ? https : http;
    // A private agent per request: no connection reuse across hosts or
    // requests, and no proxy configuration from the environment.
    const agent = new transport.Agent({ keepAlive: false, maxSockets: 1 });
    const outgoing: Record<string, string> = {
      "user-agent": USER_AGENT,
      "accept-encoding": "identity",
      ...lowerCaseKeys(headers),
    };
    if (body) outgoing["content-length"] = String(body.length);

    return new Promise<RawResponse>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, value?: RawResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(request);
        agent.destroy();
        if (error) reject(toNetworkError(error, target));
        else resolve(value!);
      };
      const options: https.RequestOptions = {
        method,
        protocol: secure ? "https:" : "http:",
        host: target.hostKind === "address" ? first.text : target.host,
        port: target.port,
        path: `${parsed.url.pathname}${parsed.url.search}`,
        headers: outgoing,
        agent,
        lookup: pinned,
        ...(secure && target.hostKind === "name" ? { servername: target.host } : {}),
      };
      const request = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const done = () =>
          finish(undefined, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            headers: res.headers as Record<string, string | string[]>,
            location: typeof res.headers.location === "string" ? res.headers.location : undefined,
            body: Buffer.concat(chunks),
            truncated,
            remoteAddress: res.socket?.remoteAddress ?? first.text,
          });
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const room = maxBytes - size;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, room));
            size = maxBytes;
            truncated = true;
            done();
            res.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on("end", done);
        res.on("error", (e) => finish(e));
        res.on("aborted", () => finish(new CrotError("OPERATION_FAILED", "The response was aborted.")));
      });
      this.active.add(request);
      const timer = setTimeout(
        () => {
          const error = new CrotError("TIMEOUT", `Network request timed out (${parsed.url.origin}).`);
          request.destroy(error);
          finish(error);
        },
        Math.max(0, deadline - Date.now()),
      );
      request.on("error", (e) => finish(e));
      request.end(body);
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new CrotError("OPERATION_FAILED", "CROT is shutting down.");
  }
}

interface RawResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly location: string | undefined;
  readonly body: Buffer;
  readonly truncated: boolean;
  readonly remoteAddress: string;
}

/**
 * Parse and validate a request URL. Only absolute http:/https: URLs without
 * credentials are accepted. The host is normalized by the WHATWG URL parser,
 * so numeric and other non-standard IPv4 spellings (`2130706433`, `0x7f.1`,
 * `0177.0.0.1`, `127.1`) become the address they denote and are checked as
 * that address.
 */
export function parseTargetUrl(raw: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CrotError("INVALID_INPUT", "url must be an absolute http: or https: URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CrotError(
      "INVALID_INPUT",
      `Unsupported URL scheme '${url.protocol}': only http: and https: are allowed.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new CrotError("INVALID_INPUT", "URLs with credentials (user:password@) are not accepted; use a header.");
  }
  const normalized = normalizeHost(url.hostname);
  if (!normalized) throw new CrotError("INVALID_INPUT", `Invalid host in URL: ${url.hostname}`);
  const scheme = url.protocol === "https:" ? "https" : "http";
  const port = url.port === "" ? (scheme === "https" ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CrotError("INVALID_INPUT", "Invalid port in URL.");
  url.hash = "";
  const literal = normalized.kind === "address" ? parseIp(normalized.host) : undefined;
  return {
    url,
    target: { scheme, host: normalized.host, hostKind: normalized.kind, port },
    ...(literal ? { literal } : {}),
  };
}

function lowerCaseKeys(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

function withoutHeaders(headers: Readonly<Record<string, string>>, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !names.includes(k.toLowerCase())));
}

function withDeadline<T>(promise: Promise<T>, deadline: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CrotError("TIMEOUT", `${what} timed out.`)),
        Math.max(0, deadline - Date.now()),
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function toNetworkError(error: unknown, target: NetworkTarget): CrotError {
  if (error instanceof CrotError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const where = `${target.host}:${target.port}`;
  const message = error instanceof Error ? error.message : String(error);
  return new CrotError(
    "OPERATION_FAILED",
    `Network request to ${where} failed: ${code ?? message}`,
    code ? { errno: code } : undefined,
    { cause: error },
  );
}
