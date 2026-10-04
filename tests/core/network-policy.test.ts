import { describe, expect, it } from "vitest";
import { classifyAddress, parseIp, parseRange, rangeContains } from "../../src/core/permissions/network/addresses.js";
import { NetworkPolicy, type NetworkTarget } from "../../src/core/permissions/network/policy.js";
import { parseTargetUrl } from "../../src/core/capabilities/network/service.js";
import { CrotError } from "../../src/core/errors.js";

const ip = (text: string) => {
  const a = parseIp(text);
  if (!a) throw new Error(`bad ip ${text}`);
  return a;
};

/** The destination Core builds for a URL, with the given resolved addresses (names) or the literal (IPs). */
function target(url: string, resolved?: readonly string[]): NetworkTarget {
  const parsed = parseTargetUrl(url);
  const addresses = parsed.literal ? [parsed.literal] : resolved?.map(ip);
  return { ...parsed.target, ...(addresses ? { addresses } : {}) };
}

const policy = (allow: string[], deny: string[] = [], mode: "sandbox" | "full_control" = "full_control") =>
  NetworkPolicy.create({ allow, deny }, mode);

describe("IP addresses", () => {
  it("parses IPv4 and IPv6 into one canonical value", () => {
    expect(ip("0:0:0:0:0:0:0:1").text).toBe("::1");
    expect(ip("[::1]").text).toBe("::1");
    expect(ip("::ffff:127.0.0.1").value).toBe(ip("::ffff:7f00:1").value);
    expect(parseIp("fe80::1%eth0")).toBeUndefined();
    expect(parseIp("127.1")).toBeUndefined();
    expect(parseIp("example.com")).toBeUndefined();
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["10.0.0.1", "private"],
    ["172.16.5.4", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["fd12:3456::1", "private"],
    ["::ffff:10.1.2.3", "private"],
    ["169.254.169.254", "link-local"],
    ["fe80::1", "link-local"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["ff02::1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["64:ff9b::7f00:1", "loopback"],
    ["2002:7f00:1::1", "loopback"],
    ["2001::1", "reserved"],
    ["::127.0.0.1", "reserved"],
    ["192.0.2.1", "documentation"],
    ["2001:db8::1", "documentation"],
    ["8.8.8.8", "public"],
    ["2606:4700:4700::1111", "public"],
    ["::ffff:8.8.8.8", "public"],
  ])("classifies %s as %s", (address, cls) => {
    expect(classifyAddress(ip(address))).toBe(cls);
  });

  it("matches IPv4-mapped IPv6 addresses against IPv4 ranges", () => {
    expect(rangeContains(parseRange("127.0.0.0/8")!, ip("::ffff:127.0.0.9"))).toBe(true);
    expect(rangeContains(parseRange("10.0.0.0/8")!, ip("::ffff:11.0.0.1"))).toBe(false);
    expect(parseRange("10.0.0.1/8")).toBeUndefined(); // host bits set
  });
});

describe("request URLs", () => {
  it("normalizes non-standard IPv4 spellings to the address they denote", () => {
    for (const url of [
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0x7f.1/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://127.0.0.1./",
    ]) {
      const t = target(url);
      expect(t.hostKind, url).toBe("address");
      expect(t.host, url).toBe("127.0.0.1");
    }
    expect(target("http://[0:0:0:0:0:ffff:7f00:1]/").host).toBe("::ffff:7f00:1");
  });

  it("normalizes names (case, trailing dot, IDNA)", () => {
    expect(target("http://EXAMPLE.com./x").host).toBe("example.com");
    expect(target("https://exаmple.com/").host).toBe("xn--exmple-4nf.com"); // Cyrillic 'а'
    expect(target("https://example.com/").port).toBe(443);
    expect(target("http://example.com:8080/").port).toBe(8080);
  });

  it("refuses other schemes, credentials and zone identifiers", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/",
      "gopher://example.com/",
      "ws://example.com/",
      "javascript:alert(1)",
      "http://user:pass@example.com/",
      "http://example.com@127.0.0.1/",
      "http://[fe80::1%25eth0]/",
      "//example.com/",
      "example.com",
    ]) {
      expect(() => parseTargetUrl(url), url).toThrow(CrotError);
    }
  });
});

describe("network policy", () => {
  it("denies everything without allow rules, in every mode", () => {
    for (const mode of ["sandbox", "full_control"] as const) {
      const p = NetworkPolicy.create(undefined, mode);
      expect(p.evaluate(target("https://example.com/", ["93.184.216.34"])).allowed).toBe(false);
      expect(p.evaluate(target("https://8.8.8.8/")).allowed).toBe(false);
    }
  });

  it("allows an exact name on ports 80/443 and checks resolved addresses", () => {
    const p = policy(["example.com"]);
    expect(p.evaluate(target("https://example.com/"))).toEqual({ allowed: true }); // before DNS
    expect(p.evaluate(target("https://example.com/", ["93.184.216.34"]))).toEqual({ allowed: true });
    expect(p.evaluate(target("http://example.com/", ["93.184.216.34"])).allowed).toBe(true);
    expect(p.evaluate(target("https://example.com:8443/", ["93.184.216.34"])).allowed).toBe(false);
    expect(p.evaluate(target("https://www.example.com/", ["93.184.216.34"])).allowed).toBe(false);
    expect(p.evaluate(target("https://example.com.evil.net/", ["93.184.216.34"])).allowed).toBe(false);
    expect(p.evaluate(target("https://evilexample.com/", ["93.184.216.34"])).allowed).toBe(false);
  });

  it("wildcards match subdomains only", () => {
    const p = policy(["*.example.com"]);
    expect(p.evaluate(target("https://a.b.example.com/", ["93.184.216.34"])).allowed).toBe(true);
    expect(p.evaluate(target("https://example.com/", ["93.184.216.34"])).allowed).toBe(false);
    expect(p.evaluate(target("https://badexample.com/", ["93.184.216.34"])).allowed).toBe(false);
  });

  it("a name rule never allows the host's IP literal, and an IP rule never allows names", () => {
    const p = policy(["example.com", "93.184.216.34"]);
    expect(p.evaluate(target("https://93.184.216.34/")).allowed).toBe(true);
    expect(policy(["example.com"]).evaluate(target("https://93.184.216.34/")).allowed).toBe(false);
    expect(policy(["93.184.216.34"]).evaluate(target("https://other.test/", ["93.184.216.34"])).allowed).toBe(false);
  });

  it("refuses loopback, private and link-local addresses behind an allowed name (DNS rebinding)", () => {
    const p = policy(["api.example.com", "*"]);
    for (const address of ["127.0.0.1", "::1", "10.0.0.5", "192.168.0.10", "169.254.169.254", "fe80::1", "fd00::1"]) {
      const decision = p.evaluate(target("https://api.example.com/", [address]));
      expect(decision.allowed, address).toBe(false);
      if (!decision.allowed) expect(decision.reason).toMatch(/non-public addresses must be allowed explicitly/);
    }
    // One bad address among good ones refuses the whole destination.
    expect(p.evaluate(target("https://api.example.com/", ["93.184.216.34", "127.0.0.1"])).allowed).toBe(false);
  });

  it("refuses localhost and loopback literals in every spelling unless explicitly allowed", () => {
    const p = policy(["*"]);
    for (const url of [
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://0.0.0.0/",
      "http://[::]/",
      "http://169.254.169.254/",
      "http://10.0.0.1/",
      "http://[fe80::1]/",
    ]) {
      expect(p.evaluate(target(url)).allowed, url).toBe(false);
    }
    expect(p.evaluate(target("http://localhost/", ["127.0.0.1", "::1"])).allowed).toBe(false);
    // Explicit address rules make loopback reachable (ports must match too).
    const local = policy(["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]);
    expect(local.evaluate(target("http://localhost:3000/", ["127.0.0.1", "::1"])).allowed).toBe(true);
    expect(local.evaluate(target("http://localhost:3001/", ["127.0.0.1"])).allowed).toBe(false);
    expect(local.evaluate(target("http://127.0.0.1:3000/")).allowed).toBe(true);
    expect(local.evaluate(target("http://2130706433:3000/")).allowed).toBe(true); // same address
  });

  it("deny rules win, including over resolved addresses", () => {
    const p = policy(["*", "10.0.0.0/8"], ["blocked.example.com", "*.internal.example.com", "10.1.0.0/16"]);
    expect(p.evaluate(target("https://blocked.example.com/")).allowed).toBe(false);
    expect(p.evaluate(target("https://a.internal.example.com/")).allowed).toBe(false);
    expect(p.evaluate(target("https://ok.example.com/", ["10.1.2.3"])).allowed).toBe(false);
    expect(p.evaluate(target("https://ok.example.com/", ["10.2.2.3"])).allowed).toBe(true);
    expect(p.evaluate(target("http://[::ffff:10.1.2.3]/")).allowed).toBe(false);
    const ports = policy(["example.com:*"], ["example.com:22"]);
    expect(ports.evaluate(target("http://example.com:22/", ["93.184.216.34"])).allowed).toBe(false);
    expect(ports.evaluate(target("http://example.com:8080/", ["93.184.216.34"])).allowed).toBe(true);
  });

  it("refuses https to http downgrades on redirect hops", () => {
    const p = policy(["example.com"]);
    expect(p.evaluate({ ...target("http://example.com/", ["93.184.216.34"]), requireTls: true }).allowed).toBe(false);
    expect(p.evaluate({ ...target("https://example.com/", ["93.184.216.34"]), requireTls: true }).allowed).toBe(true);
  });

  it("validates rules and keeps sandbox access bounded", () => {
    for (const rule of [
      "",
      "http://example.com",
      "exa mple.com",
      "example.com/path",
      "0x7f.1",
      "127.1",
      "10.0.0.1/8",
    ]) {
      expect(() => policy([rule]), rule).toThrow(CrotError);
    }
    // Unbracketed IPv6 never carries a port: "::1:80" is the address ::1:80, not ::1 port 80.
    expect(policy(["::1:80"]).evaluate(target("http://[::1]/")).allowed).toBe(false);
    for (const rule of ["[example.com]", "example.com:0", "example.com:70000", "user@example.com"]) {
      expect(() => policy([rule]), rule).toThrow(CrotError);
    }
    for (const rule of ["*", "*.com", "0.0.0.0/0", "::/0", "0.0.0.0/1"]) {
      expect(() => policy([rule], [], "sandbox"), rule).toThrow(CrotError);
      expect(() => policy([rule], [], "full_control"), rule).not.toThrow();
    }
    expect(() => policy(["*.example.com", "10.0.0.0/8", "[fd00::/48]:8080"], ["*"], "sandbox")).not.toThrow();
    expect(policy(["Example.COM.", "[::1]:8080"]).summary()).toEqual({
      allow: ["Example.COM.", "[::1]:8080"],
      deny: [],
      defaultAllowedPorts: [80, 443],
    });
  });
});
