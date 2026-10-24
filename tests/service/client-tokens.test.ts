import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { ClientTokenRegistry, clientTokenPath, TokenIssueSchema } from "../../src/service/client-tokens.js";
import { principalFromAuthInfo } from "../../src/adapters/http/context.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { makeTempDirs } from "../helpers.js";

it("persists hashes only, binds verified scopes, rotates without extending TTL and revokes across restart", async () => {
  const dirs = await makeTempDirs(),
    file = clientTokenPath(dirs.outside);
  let registry: ClientTokenRegistry | undefined;
  const audit = vi.fn(async () => {}),
    invalidate = vi.fn(async () => {}),
    failClosed = vi.fn();
  let time = Date.now();
  const options = {
    file,
    privateFiles: createPrivateFileProtection(process.platform === "win32"),
    audit,
    invalidate,
    failClosed,
    clock: () => time,
  };
  try {
    registry = await ClientTokenRegistry.open(options);
    const issued = await registry.issue({ name: "editor", ttlSeconds: 60, scopes: ["files"] });
    const first = String(issued.token);
    expect(first).toHaveLength(43);
    expect(await readFile(file, "utf8")).not.toContain(first);
    expect(JSON.stringify(registry.list())).not.toMatch(/digest|generation|"token"/);
    const auth = (await registry.verifyAccessToken(first))!;
    const principal = principalFromAuthInfo("loopback", auth)!;
    expect(principal.tokenAccess).toMatchObject({ id: issued.id, scopes: ["files"] });
    expect(principalFromAuthInfo("relay", auth)).toBeUndefined();
    expect(() => registry!.authorize(principal)).not.toThrow();
    expect(registry.list()[0]?.lastUsedAt).toBe(time);
    time += 1000;
    const rotated = await registry.rotate(String(issued.id));
    expect(rotated.expiresAt).toBe(issued.expiresAt);
    expect(invalidate).toHaveBeenCalledWith(issued.id, principal.tokenAccess!.generation);
    expect(await registry.verifyAccessToken(first)).toBeUndefined();
    expect(() => registry!.authorize(principal)).toThrow(/expired or revoked/);
    expect(await registry.verifyAccessToken(String(rotated.token))).toBeDefined();
    await registry.close();
    registry = await ClientTokenRegistry.open(options);
    expect(await registry.verifyAccessToken(first)).toBeUndefined();
    expect(await registry.verifyAccessToken(String(rotated.token))).toBeDefined();
    await registry.revoke(String(issued.id));
    expect(await registry.verifyAccessToken(String(rotated.token))).toBeUndefined();
    await registry.close();
    registry = await ClientTokenRegistry.open(options);
    expect(await registry.verifyAccessToken(String(rotated.token))).toBeUndefined();
    expect(audit.mock.calls.map((v: unknown[]) => v[0])).toEqual(["token_issue", "token_rotate", "token_revoke"]);
    expect(failClosed).not.toHaveBeenCalled();
  } finally {
    await registry?.close();
    await dirs.cleanup();
  }
});

it("expires pending credentials and invalidates their running work without authenticating them", async () => {
  const dirs = await makeTempDirs();
  const invalidate = vi.fn(async () => {});
  let time = Date.now();
  const registry = await ClientTokenRegistry.open({
    file: clientTokenPath(dirs.outside),
    privateFiles: createPrivateFileProtection(false),
    audit: async () => {},
    invalidate,
    failClosed: () => {},
    clock: () => time,
  });
  try {
    const issued = await registry.issue({ name: "short lived", ttlSeconds: 60, scopes: ["terminal"] });
    const principal = principalFromAuthInfo("loopback", (await registry.verifyAccessToken(String(issued.token)))!)!;
    time += 60000;
    expect(await registry.verifyAccessToken(String(issued.token))).toBeUndefined();
    expect(() => registry.authorize(principal)).toThrow();
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledOnce(), { timeout: 1500 });
    expect(registry.list()[0]?.active).toBe(false);
  } finally {
    await registry.close();
    await dirs.cleanup();
  }
});

it("an audit failure never activates an issued token, including after restart; malformed storage fails closed", async () => {
  const dirs = await makeTempDirs(),
    file = path.join(dirs.outside, "tokens.json");
  const options = {
    file,
    privateFiles: createPrivateFileProtection(false),
    audit: async () => {
      throw new Error("audit unavailable");
    },
    invalidate: async () => {},
    failClosed: () => {},
  };
  let registry: ClientTokenRegistry | undefined;
  try {
    registry = await ClientTokenRegistry.open(options);
    await expect(registry.issue({ name: "pending", ttlSeconds: 60, scopes: ["browser"] })).rejects.toThrow(
      "audit unavailable",
    );
    expect(registry.list()[0]?.active).toBe(false);
    await registry.close();
    registry = await ClientTokenRegistry.open(options);
    expect(registry.list()[0]?.active).toBe(false);
    await registry.close();
    registry = undefined;
    await writeFile(file, '{"version":1,"tokens":[{"digest":"malformed"}]}');
    await expect(ClientTokenRegistry.open(options)).rejects.toThrow();
  } finally {
    await registry?.close();
    await dirs.cleanup();
  }
});

it("rejects zero/oversized TTL, unknown/duplicate/empty scopes and injected fields", () => {
  const valid = { name: "editor", ttlSeconds: 3600, scopes: ["files"] };
  for (const p of [
    { ttlSeconds: 0 },
    { ttlSeconds: 366 * 86400 },
    { scopes: [] },
    { scopes: ["files", "files"] },
    { scopes: ["admin"] },
    { name: "x\nforged" },
    { token: "chosen" },
  ])
    expect(TokenIssueSchema.safeParse({ ...valid, ...p }).success).toBe(false);
  expect(TokenIssueSchema.safeParse(valid).success).toBe(true);
});
