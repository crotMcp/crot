import { describe, expect, it } from "vitest";
import { z } from "zod";
import { exposureScopeFor, httpContextResolver, LocalPrincipalScopes } from "../../src/adapters/http/context.js";
import { invokeTool } from "../../src/adapters/mcp/invoke.js";
import type { ToolDefinition } from "../../src/adapters/mcp/tools.js";
import { newSession, remotePrincipal, type AuthContext, type Principal } from "../../src/core/auth/principal.js";
import type { CrotCore } from "../../src/core/crot-core.js";

/**
 * invokeTool builds the request-scoped execution context (AD-15 point 7).
 * The ExecutionGuard is unchanged by WP-19 and keys exposure snapshots by
 * `session`; every context therefore has a session that never spans more
 * than one exposure scope.
 */

const seen: AuthContext[] = [];
const probe: ToolDefinition = {
  name: "probe",
  title: "probe",
  description: "probe",
  inputSchema: z.object({}),
  annotations: {},
  call: async (_core, context) => {
    seen.push(context);
    return { ok: true };
  },
};
const core = {} as CrotCore;
const loopback: Principal = { id: "local-token:abc", kind: "local", transport: "http", authMethod: "local-token" };
const remote = remotePrincipal({
  id: "acct",
  transport: "relay",
  authMethod: "oauth",
  accountId: "acct",
  deviceId: "dev",
  clientId: "cli",
});

async function contextOf(
  principal: Principal,
  mode: "session" | "sessionless",
  session?: ReturnType<typeof newSession>,
) {
  const scopes = new LocalPrincipalScopes();
  const resolver = httpContextResolver(principal, exposureScopeFor(principal, mode, scopes));
  await invokeTool(core, resolver, { definition: probe, args: {}, request: {}, ...(session ? { session } : {}) });
  return seen.at(-1)!;
}

describe("invokeTool: execution context", () => {
  it("sessionless loopback requests share the exposure scope but each gets its own session", async () => {
    const scopes = new LocalPrincipalScopes();
    const resolver = httpContextResolver(loopback, exposureScopeFor(loopback, "sessionless", scopes));
    await invokeTool(core, resolver, { definition: probe, args: {}, request: {} });
    await invokeTool(core, resolver, { definition: probe, args: {}, request: {} });
    const [a, b] = seen.slice(-2) as [AuthContext, AuthContext];
    expect(a.exposureScope).toBeDefined();
    expect(a.exposureScope).toBe(b.exposureScope);
    expect(a.session).toBeDefined();
    expect(b.session).toBeDefined();
    expect(a.session).not.toBe(b.session);
    expect(a.requestId).not.toBe(b.requestId);
  });

  it("sessionless remote requests: remote scope, own session per request", async () => {
    const a = await contextOf(remote, "sessionless");
    const b = await contextOf(remote, "sessionless");
    expect(a.exposureScope?.remoteKey).toBe(b.exposureScope?.remoteKey);
    expect(a.session).toBeDefined();
    expect(a.session).not.toBe(b.session);
  });

  it("legacy sessions and stdio keep their session as before", async () => {
    const session = newSession();
    const local = await contextOf(loopback, "session", session);
    expect(local.session).toBe(session);
    expect(local.exposureScope).toBeUndefined();
    const remoteLegacy = await contextOf(remote, "session", session);
    expect(remoteLegacy.session).toBe(session);
    expect(remoteLegacy.exposureScope?.remoteKey).toBeDefined();
  });
});
