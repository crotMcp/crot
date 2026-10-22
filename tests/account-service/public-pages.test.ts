import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PORTAL_CSS } from "../../src/account-service/portal.js";
import { RelayHarness } from "../cloud-relay/harness.js";
let relay: RelayHarness | undefined;
afterEach(async () => {
  await relay?.stop();
  relay = undefined;
});
describe("unconditional public HTML before MCP admission", () => {
  it.each(["/", "/welcome", "/portal", "/portal/callback"])(
    "serves GET and HEAD %s without a token or configured portal OAuth",
    async (pathname) => {
      relay = await new RelayHarness().start();
      const response = await fetch(relay.origin + pathname + "?from=browser", {
        headers: { accept: "text/html", authorization: "Bearer invalid-and-not-needed" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await response.text();
      expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(html).toContain("<style>" + PORTAL_CSS + "</style>");
      expect(html).toContain('class="topbar"');
      expect(html).not.toContain('"jsonrpc"');
      expect(response.headers.get("content-security-policy")).toContain(
        "'sha256-" + createHash("sha256").update(PORTAL_CSS).digest("base64") + "'",
      );
      const head = await fetch(relay.origin + pathname, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(html)));
      expect(await head.text()).toBe("");
    },
  );
  it("keeps unknown routes and non-page APIs out of the HTML fallback", async () => {
    relay = await new RelayHarness().start();
    const unknown = await fetch(relay.origin + "/does-not-exist");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("application/json");
    expect((await fetch(relay.origin + "/portal", { method: "POST" })).status).toBe(405);
    expect((await fetch(relay.origin + "/account")).status).toBe(401);
  });
});
