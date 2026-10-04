import net from "node:net";

/**
 * IP address handling for the network policy (ARCHITECTURE.md §27, AD-4).
 *
 * Addresses are compared as integers, never as strings, so different spellings
 * of one address (`::1`, `0:0:0:0:0:0:0:1`, `::ffff:127.0.0.1`) are the same
 * address for every rule. Non-canonical IPv4 forms in URLs (`2130706433`,
 * `0x7f.1`, `0177.0.0.1`, `127.1`) are normalized by the WHATWG URL parser
 * before they reach this module; this module itself accepts only canonical
 * dotted-quad IPv4 and RFC 4291 IPv6 text (no zone identifiers).
 */
export type IpFamily = 4 | 6;

export interface IpAddress {
  readonly family: IpFamily;
  /** 32-bit (IPv4) or 128-bit (IPv6) value. */
  readonly value: bigint;
  /** Canonical text (dotted quad, or compressed lower-case IPv6 without brackets). */
  readonly text: string;
}

export interface IpRange {
  readonly family: IpFamily;
  readonly base: bigint;
  readonly prefix: number;
}

/**
 * Address classes. Everything except `public` is refused by the network
 * policy unless an explicit IP/CIDR allow rule covers the address.
 */
export type AddressClass =
  "public" | "unspecified" | "loopback" | "private" | "link-local" | "multicast" | "documentation" | "reserved";

const bits = (family: IpFamily) => (family === 4 ? 32 : 128);

/** Parse canonical IPv4 or IPv6 text (IPv6 may be bracketed). Returns undefined for anything else. */
export function parseIp(input: string): IpAddress | undefined {
  const text = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (text.includes("%")) return undefined; // zone identifiers are never accepted
  const kind = net.isIP(text);
  if (kind === 4) {
    const parts = text.split(".").map(Number);
    const value = parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n);
    return { family: 4, value, text: formatIp(4, value) };
  }
  if (kind === 6) {
    const value = parseIpv6(text);
    if (value === undefined) return undefined;
    return { family: 6, value, text: formatIp(6, value) };
  }
  return undefined;
}

function parseIpv6(text: string): bigint | undefined {
  let body = text.toLowerCase();
  const last = body.lastIndexOf(":");
  const tail = body.slice(last + 1);
  if (tail.includes(".")) {
    // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1): rewrite it as two hex groups.
    if (net.isIP(tail) !== 4) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    body = `${body.slice(0, last + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  let groups: string[];
  const double = body.indexOf("::");
  if (double >= 0) {
    if (body.indexOf("::", double + 1) >= 0) return undefined;
    const head = body.slice(0, double) === "" ? [] : body.slice(0, double).split(":");
    const rest = body.slice(double + 2) === "" ? [] : body.slice(double + 2).split(":");
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return undefined;
    groups = [...head, ...Array<string>(fill).fill("0"), ...rest];
  } else {
    groups = body.split(":");
  }
  if (groups.length !== 8) return undefined;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

export function formatIp(family: IpFamily, value: bigint): string {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map((s) => String((value >> s) & 0xffn)).join(".");
  }
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  // Compress the longest run (length >= 2) of zero groups (RFC 5952).
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}

/** Parse `address/prefix` (or a single address, meaning a host range). */
export function parseRange(input: string): IpRange | undefined {
  const slash = input.indexOf("/");
  const addressText = slash >= 0 ? input.slice(0, slash) : input;
  const address = parseIp(addressText);
  if (!address) return undefined;
  const max = bits(address.family);
  let prefix = max;
  if (slash >= 0) {
    const p = input.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return undefined;
    prefix = Number(p);
    if (prefix > max) return undefined;
  }
  const mask = prefixMask(address.family, prefix);
  if ((address.value & ~mask & ((1n << BigInt(max)) - 1n)) !== 0n) return undefined; // host bits set
  return { family: address.family, base: address.value, prefix };
}

function prefixMask(family: IpFamily, prefix: number): bigint {
  const max = bits(family);
  if (prefix === 0) return 0n;
  return ((1n << BigInt(prefix)) - 1n) << BigInt(max - prefix);
}

export function rangeContains(range: IpRange, address: IpAddress): boolean {
  const a = effectiveAddress(address);
  if (a.family !== range.family) return false;
  const mask = prefixMask(range.family, range.prefix);
  return (a.value & mask) === (range.base & mask);
}

export function formatRange(range: IpRange): string {
  return `${formatIp(range.family, range.base)}/${range.prefix}`;
}

const MAPPED_PREFIX = 0xffffn << 32n; // ::ffff:0:0/96

/**
 * The address that is actually reached: an IPv4-mapped IPv6 address
 * (`::ffff:a.b.c.d`) is the IPv4 address `a.b.c.d` for every policy decision.
 */
export function effectiveAddress(address: IpAddress): IpAddress {
  if (address.family === 6 && address.value >> 32n === MAPPED_PREFIX >> 32n) {
    const value = address.value & 0xffffffffn;
    return { family: 4, value, text: formatIp(4, value) };
  }
  return address;
}

interface ClassRange {
  readonly range: IpRange;
  readonly cls: AddressClass;
}

const range = (text: string): IpRange => {
  const r = parseRange(text);
  if (!r) throw new Error(`invalid built-in range ${text}`);
  return r;
};

/** IPv4 special-purpose ranges (RFC 6890 and the IANA registry). */
const IPV4_CLASSES: readonly ClassRange[] = [
  { range: range("0.0.0.0/8"), cls: "unspecified" },
  { range: range("10.0.0.0/8"), cls: "private" },
  { range: range("100.64.0.0/10"), cls: "private" }, // shared address space (CGNAT)
  { range: range("127.0.0.0/8"), cls: "loopback" },
  { range: range("169.254.0.0/16"), cls: "link-local" },
  { range: range("172.16.0.0/12"), cls: "private" },
  { range: range("192.0.0.0/24"), cls: "reserved" },
  { range: range("192.0.2.0/24"), cls: "documentation" },
  { range: range("192.88.99.0/24"), cls: "reserved" },
  { range: range("192.168.0.0/16"), cls: "private" },
  { range: range("198.18.0.0/15"), cls: "reserved" }, // benchmarking
  { range: range("198.51.100.0/24"), cls: "documentation" },
  { range: range("203.0.113.0/24"), cls: "documentation" },
  { range: range("224.0.0.0/4"), cls: "multicast" },
  { range: range("240.0.0.0/4"), cls: "reserved" }, // includes 255.255.255.255
];

/** IPv6 special-purpose ranges; everything outside 2000::/3 is not public. */
const IPV6_CLASSES: readonly ClassRange[] = [
  { range: range("::/128"), cls: "unspecified" },
  { range: range("::1/128"), cls: "loopback" },
  { range: range("100::/64"), cls: "reserved" }, // discard
  { range: range("2001::/23"), cls: "reserved" }, // IETF protocol assignments, incl. Teredo 2001::/32
  { range: range("2001:db8::/32"), cls: "documentation" },
  { range: range("3fff::/20"), cls: "documentation" },
  { range: range("fc00::/7"), cls: "private" }, // unique local
  { range: range("fe80::/10"), cls: "link-local" },
  { range: range("fec0::/10"), cls: "private" }, // deprecated site-local
  { range: range("ff00::/8"), cls: "multicast" },
];

const GLOBAL_UNICAST = range("2000::/3");
const NAT64 = range("64:ff9b::/96");
const SIX_TO_FOUR = range("2002::/16");

/** Classify an address. IPv4 embedded in IPv6 (mapped, NAT64, 6to4) is classified as the IPv4 address. */
export function classifyAddress(address: IpAddress): AddressClass {
  const a = effectiveAddress(address);
  if (a.family === 4) {
    return IPV4_CLASSES.find((c) => rangeContains(c.range, a))?.cls ?? "public";
  }
  if (rangeContains(NAT64, a)) return classifyAddress(ipv4(a.value & 0xffffffffn));
  if (rangeContains(SIX_TO_FOUR, a)) {
    const embedded = classifyAddress(ipv4((a.value >> 80n) & 0xffffffffn));
    if (embedded !== "public") return embedded;
  }
  const special = IPV6_CLASSES.find((c) => rangeContains(c.range, a))?.cls;
  if (special) return special;
  return rangeContains(GLOBAL_UNICAST, a) ? "public" : "reserved";
}

function ipv4(value: bigint): IpAddress {
  return { family: 4, value, text: formatIp(4, value) };
}
