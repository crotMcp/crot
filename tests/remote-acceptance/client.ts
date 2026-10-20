import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { MCP_CLIENT } from "../identity/test-authorization-server.js";
import type { RemoteAcceptance } from "./harness.js";
export const versions = ["2026-07-28", "2025-11-25", "2025-06-18"] as const;
export type Version = (typeof versions)[number];
export async function issueToken(h: RemoteAcceptance, clientId = MCP_CLIENT): Promise<string> {
  let redirect: URL | undefined;
  let verifier = "";
  let tokens: OAuthTokens | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:19872/callback",
    clientMetadata: {
      redirect_uris: ["http://127.0.0.1:19872/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    clientInformation: () => ({ client_id: clientId }),
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    redirectToAuthorization: (url) => {
      redirect = url;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
  };
  if ((await auth(provider, { serverUrl: h.uri, fetchFn: h.fetch })) !== "REDIRECT" || !redirect)
    throw new Error("OAuth did not redirect");
  const target = redirect as URL;
  if (target.searchParams.get("resource") !== h.uri || target.searchParams.get("code_challenge_method") !== "S256")
    throw new Error("OAuth resource/PKCE missing");
  const response = await h.fetch(target, { redirect: "manual" });
  if (response.status !== 302) throw new Error("authorization failed");
  const code = new URL(response.headers.get("location")!).searchParams.get("code")!;
  if (
    (await auth(provider, { serverUrl: h.uri, authorizationCode: code, fetchFn: h.fetch })) !== "AUTHORIZED" ||
    !tokens
  )
    throw new Error("token exchange failed");
  return (tokens as OAuthTokens).access_token;
}
export interface AcceptanceClient {
  token: string;
  call(name: string, args?: Record<string, unknown>, timeout?: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
export async function connectClient(h: RemoteAcceptance, version: Version, bearer?: string): Promise<AcceptanceClient> {
  const token = bearer ?? (await issueToken(h));
  const headers = { authorization: `Bearer ${token}` };
  const client =
    version === "2026-07-28"
      ? new ModernClient({ name: "WP32-acceptance", version: "1" }, { versionNegotiation: { mode: { pin: version } } })
      : new LegacyClient({ name: "WP32-acceptance", version: "1" });
  // SDK 1.x has no legacy revision-pinning option. Change only initialize's advertised revision;
  // all transport/session handling, negotiation, tools and timeouts remain the actual SDK's.
  const legacyFetch: typeof fetch = async (input, init) => {
    if (typeof init?.body === "string") {
      const body = JSON.parse(init.body) as { method?: string; params?: Record<string, unknown> };
      if (body.method === "initialize" && body.params)
        return h.fetch(input, {
          ...init,
          body: JSON.stringify({ ...body, params: { ...body.params, protocolVersion: version } }),
        });
    }
    return h.fetch(input, init);
  };
  if (client instanceof ModernClient)
    await client.connect(new ModernTransport(new URL(h.uri), { fetch: h.fetch, requestInit: { headers } }));
  else await client.connect(new LegacyTransport(new URL(h.uri), { fetch: legacyFetch, requestInit: { headers } }));
  return {
    token,
    call: async (name, args = {}, timeout) => {
      const params = { name, arguments: args };
      const options = timeout === undefined ? undefined : { timeout };
      const result =
        client instanceof ModernClient
          ? await client.callTool(params, options)
          : await client.callTool(params, undefined, options);
      const blocks = result.content as { type: string; text?: string }[];
      const value = JSON.parse(
        blocks
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join(""),
      ) as Record<string, unknown>;
      if (result.isError) return { error: value };
      return value;
    },
    close: () => client.close(),
  };
}
