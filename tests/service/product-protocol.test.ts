import { expect, it } from "vitest";
import { parseProduct, PRODUCT_METHODS } from "../../src/service/product-protocol.js";
import { parseControlRequest } from "../../src/service/protocol.js";
it("owner product RPC is a closed allowlist and rejects secrets in unsafe headers, arbitrary fields and malformed grants", () => {
  expect(PRODUCT_METHODS).toContain("mcpServers.callTool");
  for (const method of ["exec", "tools.call", "__proto__", "network_request"])
    expect(parseProduct(method, {})).toBeUndefined();
  expect(parseProduct("connectors.configure", { id: "GitHub", credential: "a\r\nInjected: yes" })).toBeUndefined();
  expect(parseProduct("projects.select", { id: "x", bypass: true })).toBeUndefined();
  expect(
    parseProduct("agents.configure", { id: "x", projects: [], browser: true, requestsPerMinute: 0 }),
  ).toBeUndefined();
  expect(
    parseControlRequest({ t: "request", id: 1, method: "pairing.start", params: { provider: "SSO" } }),
  ).toBeUndefined();
  expect(
    parseControlRequest({
      t: "request",
      id: 1,
      method: "pairing.start",
      params: { provider: "GoogleOAuth", login_hint: "not email" },
    }),
  ).toBeUndefined();
  expect(parseProduct("mcpServers.add", { name: "x", transport: "stdio", command: "node" })).toMatchObject({
    args: [],
  });
});

it("security RPC rejects implicit kill parameters and malformed runtime policy", () => {
  expect(parseProduct("security.kill", { force: true })).toBeUndefined();
  expect(parseProduct("security.setPolicy", { strict: "true", rules: [] })).toBeUndefined();
  expect(
    parseProduct("security.setPolicy", {
      strict: false,
      rules: [{ operation: "filesystem.read_file", capability: "filesystem.read", state: "allow" }],
    }),
  ).toBeUndefined();
  expect(
    parseProduct("security.setPolicy", {
      strict: false,
      rules: [
        { operation: "filesystem.read_file", state: "allow" },
        { operation: "filesystem.read_file", state: "deny" },
      ],
    }),
  ).toBeUndefined();
  expect(parseControlRequest({ t: "request", id: 1, method: "security.kill", params: {} })).toMatchObject({
    method: "security.kill",
    params: {},
  });
});
