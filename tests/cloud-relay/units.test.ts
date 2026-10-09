import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRelayConfig } from "../../src/cloud-relay/config.js";
import { jsonLineLogger, sanitizeRecord } from "../../src/cloud-relay/log.js";
import { FileDeviceRegistry, isDevicePublicKey, type DeviceRecord } from "../../src/cloud-relay/registry.js";
import {
  decodeFrame,
  encodeFrame,
  endToEndHeaders,
  FLAG_END_STREAM,
  FrameType,
  offeredMajors,
  parseHeaderList,
  parseJsonPayload,
  selectMajor,
  TunnelProtocolError,
  unsupportedVersionReason,
} from "../../src/tunnel/protocol.js";

/** WP-29: tunnel codec (AD-22 points 5, 7, 10), registry persistence, configuration and log sanitizing. */

describe("frame codec", () => {
  it("round-trips the 6-byte header", () => {
    const f = decodeFrame(encodeFrame(FrameType.DATA, 0xfffffffe, Buffer.from("abc"), FLAG_END_STREAM));
    expect(f).toMatchObject({ type: 0x12, flags: 1, stream: 0xfffffffe });
    expect(f.payload.toString()).toBe("abc");
  });

  it("rejects short frames, reserved flags and oversized payloads", () => {
    expect(() => decodeFrame(Buffer.alloc(5))).toThrow(TunnelProtocolError);
    expect(() => decodeFrame(encodeFrame(FrameType.DATA, 1, Buffer.alloc(1), 0x80))).toThrow(/reserved_flags/);
    expect(() => decodeFrame(encodeFrame(FrameType.DATA, 1, Buffer.alloc(65537)))).toThrow(/frame_too_large/);
  });

  it("accepts only UTF-8 JSON objects", () => {
    expect(parseJsonPayload(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
    for (const bad of ["[1]", "1", "null", "{", "\xff"])
      expect(() => parseJsonPayload(Buffer.from(bad, "latin1"))).toThrow();
  });

  it("validates header lists", () => {
    expect(parseHeaderList([["a", "b"]])).toEqual([["a", "b"]]);
    expect(parseHeaderList([["A", "b"]])).toBeUndefined();
    expect(parseHeaderList([["a", "b\r\nx: y"]])).toBeUndefined();
    expect(parseHeaderList([["a"]])).toBeUndefined();
    expect(parseHeaderList(Array.from({ length: 101 }, () => ["a", "b"]))).toBeUndefined();
  });

  it("removes hop-by-hop headers and those named by Connection, keeps order and duplicates", () => {
    const raw = [
      "Host",
      "h",
      "Connection",
      "close, X-Hop",
      "X-Hop",
      "1",
      "Keep-Alive",
      "5",
      "Proxy-Authorization",
      "p",
      "Accept",
      "a",
      "accept",
      "b",
      "Transfer-Encoding",
      "chunked",
      "TE",
      "trailers",
      "Upgrade",
      "ws",
    ];
    expect(endToEndHeaders(raw)).toEqual([
      ["host", "h"],
      ["accept", "a"],
      ["accept", "b"],
    ]);
  });

  it("negotiates the highest common major", () => {
    expect(offeredMajors("crot-tunnel.v1, crot-tunnel.v12, chat, crot-tunnel.v0")).toEqual(["v1", "v12"]);
    expect(selectMajor(["v1", "v3", "v2"], ["v1", "v2"])).toBe("v2");
    expect(selectMajor(["v3"], ["v1"])).toBeUndefined();
    expect(unsupportedVersionReason(["v1", "v2"])).toBe("unsupported_version;supported=v1,v2");
  });
});

describe("device registry file", () => {
  const record = (id: string, x = Buffer.alloc(32, 1).toString("base64url")): DeviceRecord => ({
    deviceId: id,
    accountId: "user_01",
    publicKey: { kty: "OKP", crv: "Ed25519", x },
    environment: "test",
    registeredAt: "2026-01-01T00:00:00.000Z",
  });

  it("persists registrations owner-only and reloads them", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "crot-relay-"));
    try {
      const file = path.join(dir, "state", "devices.json");
      const a = await FileDeviceRegistry.open(file);
      expect(await a.register(record("aaaaaaaaaaaaaaaaaaaaaaaaaa"))).toBe("created");
      expect(await a.register(record("aaaaaaaaaaaaaaaaaaaaaaaaaa"))).toBe("unchanged");
      expect(await a.register(record("aaaaaaaaaaaaaaaaaaaaaaaaaa", Buffer.alloc(32, 2).toString("base64url")))).toBe(
        "conflict",
      );
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
      const b = await FileDeviceRegistry.open(file);
      expect(await b.get("aaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual(record("aaaaaaaaaaaaaaaaaaaaaaaaaa"));
      expect(await readFile(file, "utf8")).not.toContain("token");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("only accepts Ed25519 public JWKs", () => {
    expect(isDevicePublicKey({ kty: "OKP", crv: "Ed25519", x: Buffer.alloc(32).toString("base64url") })).toBe(true);
    expect(isDevicePublicKey({ kty: "OKP", crv: "X25519", x: Buffer.alloc(32).toString("base64url") })).toBe(false);
    expect(isDevicePublicKey({ kty: "OKP", crv: "Ed25519", x: Buffer.alloc(31).toString("base64url") })).toBe(false);
    expect(isDevicePublicKey({ kty: "OKP", crv: "Ed25519", x: Buffer.alloc(32).toString("base64url"), d: "x" })).toBe(
      false,
    );
  });
});

describe("relay configuration", () => {
  const base = {
    relayHost: "relay.crot.example",
    issuer: "https://auth.crot.example",
    registryFile: "/var/lib/crot/devices.json",
  };
  it("defaults to a 15 minute deadline and refuses values outside 60 s … 15 min", () => {
    expect(parseRelayConfig(base)).toMatchObject({
      exchangeDeadlineMs: 900_000,
      port: 8443,
      environment: "development",
    });
    expect(() => parseRelayConfig({ ...base, exchangeDeadlineMs: 59_999 })).toThrow(/AD-22/);
    expect(() => parseRelayConfig({ ...base, exchangeDeadlineMs: 900_001 })).toThrow(/AD-22/);
    expect(() => parseRelayConfig({ ...base, relayHost: "Relay.Example" })).toThrow();
    expect(() => parseRelayConfig({ ...base, issuer: "http://auth.example" })).toThrow();
    expect(() => parseRelayConfig({ ...base, extra: 1 })).toThrow(/unknown/);
  });
});

describe("log records", () => {
  it("keep only known fields and a safe vocabulary", () => {
    const record = sanitizeRecord({
      event: "exchange",
      mcpMethod: "tools/call\r\nAuthorization: Bearer x",
      method: "POST",
      status: 200.4,
      ...({ token: "secret", body: "payload" } as object),
    });
    expect(record).toEqual({ event: "exchange", mcpMethod: "invalid", method: "POST", status: 200 });
    const lines: string[] = [];
    jsonLineLogger((l) => lines.push(l))({ event: "x", code: "a b" });
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "x", code: "invalid" });
  });
});
