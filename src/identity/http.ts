/**
 * Outbound HTTP of the device's identity code (ARCHITECTURE.md §27, AD-21
 * point 7): authorization server metadata, JWKS and, during pairing, the
 * token endpoint. Fetched directly from the issuer over TLS — never through
 * the relay or the tunnel.
 *
 * - HTTPS only; redirects are refused (a redirect could point the device at
 *   another origin's keys).
 * - Bounded: a timeout and a response size limit.
 * - No ambient credentials: nothing but the explicit form fields is sent.
 */

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 256 * 1024;

export class IdentityHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityHttpError";
  }
}

export interface IdentityHttp {
  /** GET a JSON document; throws IdentityHttpError for anything but a 200 JSON response. */
  getJson(url: string): Promise<unknown>;
  /** POST an application/x-www-form-urlencoded form; the status and the JSON body (undefined when not JSON). */
  postForm(url: string, form: Readonly<Record<string, string>>): Promise<{ status: number; body: unknown }>;
}

export interface IdentityHttpOptions {
  /** The fetch implementation (tests route it to a test authorization server). */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** Whether `url` is an absolute https URL without credentials or fragment. */
export function isHttpsUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.hash === "";
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new IdentityHttpError("response too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new IdentityHttpError("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createIdentityHttp(options: IdentityHttpOptions = {}): IdentityHttp {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    if (!isHttpsUrl(url)) throw new IdentityHttpError("only https URLs are fetched");
    try {
      return await fetchImpl(url, {
        ...init,
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new IdentityHttpError(`request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    async getJson(url) {
      const response = await request(url, { method: "GET", headers: { Accept: "application/json" } });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new IdentityHttpError(`unexpected status ${response.status}`);
      }
      const text = await readLimited(response, maxBytes);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new IdentityHttpError("response is not JSON");
      }
    },
    async postForm(url, form) {
      const response = await request(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      });
      const text = await readLimited(response, maxBytes);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { status: response.status, body };
    },
  };
}
