import { afterEach, expect, it } from "vitest";
import { RemoteAcceptance, eventually } from "./harness.js";
import { connectClient, issueToken, versions, type AcceptanceClient } from "./client.js";
import { MCP_CLIENT } from "../identity/test-authorization-server.js";
import { generateDeviceId } from "../../src/identity/device-id.js";
let h: RemoteAcceptance | undefined;
const clients: AcceptanceClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await h?.stop();
  h = undefined;
});
for (const version of versions)
  it(`WP-32 ${version}: revoked client403, wrong device401, remote off closes WSS`, async () => {
    h = new RemoteAcceptance();
    await h.start();
    const c = await connectClient(h, version);
    clients.push(c);
    const post = async (token: string) => {
      const response = await h!.fetch(h!.uri, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": version,
          "mcp-method": "tools/list",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 123, method: "tools/list" }),
      });
      await response.text();
      return response.status;
    };
    const wrong = h.as.token({ resource: `https://${h.as.relayHost}/d/${generateDeviceId()}/mcp`, sub: "user_01" });
    expect(await post(wrong)).toBe(401);
    expect(
      await h.ask("remote.revokeClient", { accountId: "user_01", deviceId: h.deviceId, clientId: MCP_CLIENT }),
    ).toMatchObject({ ok: true });
    expect(await post(c.token)).toBe(403);
    expect(
      await h.ask("remote.regrantClient", { accountId: "user_01", deviceId: h.deviceId, clientId: MCP_CLIENT }),
    ).toMatchObject({ ok: true });
    const token = await issueToken(h);
    expect(await h.ask("remote.setMode", { enabled: false })).toMatchObject({ ok: true });
    await eventually(() => h!.relay.status().tunnels.ready === 0);
    expect(await post(token)).toBe(503);
    const logs = JSON.stringify(h.logs);
    expect(logs).not.toContain(c.token);
    expect(logs).not.toContain(wrong);
  }, 60000);
it("WP-38 actual TLS health verifies the CA instead of disabling certificate verification", async () => {
  h = new RemoteAcceptance();
  await h.start();
  const health = `https://${h.as.relayHost}/.crot/health`;
  const response = await h.fetch(health);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  const ca = h.ca;
  try {
    h.ca = Buffer.from("not-the-fixture-CA");
    await expect(h.fetch(health)).rejects.toThrow(/certificate|self.signed|issuer/i);
  } finally {
    h.ca = ca;
  }
});
