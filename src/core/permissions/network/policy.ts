import { z } from "zod";
import { CrotError } from "../../errors.js";
import type { PermissionMode } from "../policy.js";
import {
  classifyAddress,
  parseIp,
  parseRange,
  rangeContains,
  type AddressClass,
  type IpAddress,
  type IpRange,
} from "./addresses.js";

/**
 * Host policy of `network.access` (ARCHITECTURE.md §27, AD-4).
 *
 * Contract:
 * - Deny by default. With no allow rule nothing is reachable, in every mode.
 * - Rule forms: `example.com` (exactly that name), `*.example.com` (any
 *   subdomain, not the name itself), `203.0.113.7` / `[2001:db8::1]` (one
 *   address), `10.0.0.0/8` / `fd00::/8` (CIDR range), `*` (any host;
 *   full_control only). Optional `:port` or `:*` suffix; IPv6 must be bracketed
 *   when a port is given. Allow rules without a port allow ports 80 and 443
 *   only; deny rules without a port deny every port.
 * - Name rules match only names, IP/CIDR rules only addresses: allowing
 *   `example.com` does not allow its IP literal, and allowing an address does
 *   not allow names that resolve to it.
 * - Deny rules win over allow rules. Deny IP/CIDR rules also apply to every
 *   address a name resolves to.
 * - Every address the connection may use must be public, or be covered by an
 *   explicit IP/CIDR allow rule. A name allow rule or `*` never allows
 *   loopback, private, link-local or other non-public addresses.
 */
export const NetworkPolicyConfigSchema = z
  .object({
    /** Hosts the agent may reach (see the rule forms above). Empty: nothing is reachable. */
    allow: z.array(z.string().min(1).max(300)).max(1000).default([]),
    /** Hosts that are never reachable; deny rules win over allow rules. */
    deny: z.array(z.string().min(1).max(300)).max(1000).default([]),
  })
  .strict();

export type NetworkPolicyConfig = z.output<typeof NetworkPolicyConfigSchema>;

/** Ports an allow rule without an explicit port covers. */
export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

type HostPattern =
  | { readonly kind: "any" }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "subdomains"; readonly suffix: string }
  | { readonly kind: "address"; readonly range: IpRange };

/** undefined: the rule's default ports; "any": every port. */
type PortPattern = number | "any" | undefined;

export interface NetworkRule {
  /** The rule as written in the configuration. */
  readonly source: string;
  readonly host: HostPattern;
  readonly port: PortPattern;
}

/**
 * One destination of a network operation, as the PermissionEngine sees it.
 * Built by Core from the parsed URL (never from agent-supplied fields).
 */
export interface NetworkTarget {
  readonly scheme: "http" | "https";
  /** Lower-case hostname without a trailing dot, or the canonical IP text of an IP literal. */
  readonly host: string;
  readonly hostKind: "name" | "address";
  readonly port: number;
  /**
   * Every address the connection may use. Undefined only for the
   * authorization of a name before it is resolved (no DNS query is made for a
   * name the policy refuses).
   */
  readonly addresses?: readonly IpAddress[];
  /** The previous redirect hop used TLS: a plain-HTTP destination is refused. */
  readonly requireTls?: boolean;
}

export type NetworkDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export interface NetworkPolicySummary {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly defaultAllowedPorts: readonly number[];
}

export class NetworkPolicy {
  private constructor(
    private readonly allowRules: readonly NetworkRule[],
    private readonly denyRules: readonly NetworkRule[],
  ) {}

  /** Parse and validate the configured rules for a permission mode. Throws CONFIG_ERROR. */
  static create(config: Partial<NetworkPolicyConfig> | undefined, mode: PermissionMode): NetworkPolicy {
    const allow = (config?.allow ?? []).map((r) => parseRule(r, "allow", mode));
    const deny = (config?.deny ?? []).map((r) => parseRule(r, "deny", mode));
    return new NetworkPolicy(allow, deny);
  }

  /** A policy that refuses every destination. */
  static denyAll(): NetworkPolicy {
    return new NetworkPolicy([], []);
  }

  summary(): NetworkPolicySummary {
    return {
      allow: this.allowRules.map((r) => r.source),
      deny: this.denyRules.map((r) => r.source),
      defaultAllowedPorts: DEFAULT_ALLOWED_PORTS,
    };
  }

  evaluate(target: NetworkTarget): NetworkDecision {
    const where = `${target.hostKind === "address" && target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`;
    if (target.requireTls && target.scheme !== "https") {
      return { allowed: false, reason: `Redirect from https to plain http (${where}) is refused.` };
    }
    const addresses = target.addresses ?? [];
    for (const rule of this.denyRules) {
      if (!portMatches(rule.port, target.port, "deny")) continue;
      if (hostMatches(rule.host, target)) {
        return { allowed: false, reason: `Network destination ${where} is denied by rule '${rule.source}'.` };
      }
      if (rule.host.kind === "address") {
        const range = rule.host.range;
        const hit = addresses.find((a) => rangeContains(range, a));
        if (hit) {
          return {
            allowed: false,
            reason: `Network destination ${where} resolves to ${hit.text}, denied by rule '${rule.source}'.`,
          };
        }
      }
    }
    const allowedBy = this.allowRules.find(
      (r) => portMatches(r.port, target.port, "allow") && hostMatches(r.host, target),
    );
    if (!allowedBy) {
      return {
        allowed: false,
        reason:
          this.allowRules.length === 0
            ? `Network destination ${where} is not allowed: the network policy has no allow rules (permissions.network.allow).`
            : `Network destination ${where} is not allowed by the network policy (permissions.network.allow).`,
      };
    }
    if (target.addresses !== undefined) {
      if (addresses.length === 0) {
        return { allowed: false, reason: `Network destination ${where} has no address.` };
      }
      for (const address of addresses) {
        const cls: AddressClass = classifyAddress(address);
        if (cls === "public") continue;
        const explicit = this.allowRules.some(
          (r) =>
            r.host.kind === "address" &&
            portMatches(r.port, target.port, "allow") &&
            rangeContains(r.host.range, address),
        );
        if (!explicit) {
          return {
            allowed: false,
            reason:
              `Network destination ${where} uses the ${cls} address ${address.text}; ` +
              "non-public addresses must be allowed explicitly by an IP or CIDR rule.",
          };
        }
      }
    }
    return { allowed: true };
  }
}

function portMatches(pattern: PortPattern, port: number, kind: "allow" | "deny"): boolean {
  if (pattern === "any") return true;
  if (pattern === undefined) return kind === "deny" || DEFAULT_ALLOWED_PORTS.includes(port);
  return pattern === port;
}

function hostMatches(pattern: HostPattern, target: NetworkTarget): boolean {
  switch (pattern.kind) {
    case "any":
      return true;
    case "name":
      return target.hostKind === "name" && target.host === pattern.name;
    case "subdomains":
      return target.hostKind === "name" && target.host.endsWith(`.${pattern.suffix}`);
    case "address": {
      if (target.hostKind !== "address") return false;
      const literal = parseIp(target.host);
      return literal !== undefined && rangeContains(pattern.range, literal);
    }
  }
}

/**
 * Normalize a hostname exactly as the WHATWG URL parser does for request URLs
 * (lower case, IDNA/punycode, percent-decoding), without a trailing dot.
 * Returns the IP text when the name is (a non-canonical form of) an IP address.
 */
export function normalizeHost(raw: string): { kind: "name" | "address"; host: string } | undefined {
  let hostname: string;
  try {
    hostname = new URL(`http://${raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw}/`).hostname;
  } catch {
    return undefined;
  }
  const ip = parseIp(hostname);
  if (ip) return { kind: "address", host: ip.text };
  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (host === "" || host.length > 253) return undefined;
  if (!host.split(".").every((label) => /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))) return undefined;
  return { kind: "name", host };
}

function parseRule(source: string, list: "allow" | "deny", mode: PermissionMode): NetworkRule {
  const fail = (why: string): never => {
    throw new CrotError("CONFIG_ERROR", `Invalid permissions.network.${list} rule '${source}': ${why}`);
  };
  if (/[\s/\\@?#]/.test(source.replace(/\/\d{1,3}(?=$|:|\])/, ""))) fail("unexpected character");

  // Split an optional port: "[v6]:port", "host:port", "a.b.c.d/n:port". Unbracketed IPv6 has no port.
  let hostPart = source;
  let portPart: string | undefined;
  if (source.startsWith("[")) {
    const close = source.indexOf("]");
    if (close < 0) fail("missing ']'");
    hostPart = source.slice(1, close);
    const rest = source.slice(close + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) fail("unexpected text after ']'");
      portPart = rest.slice(1);
    }
    const slashAfter = hostPart.indexOf("/");
    if (parseIp(slashAfter >= 0 ? hostPart.slice(0, slashAfter) : hostPart)?.family !== 6) {
      fail("brackets are only for IPv6 addresses");
    }
  } else if ((source.match(/:/g) ?? []).length === 1) {
    const colon = source.indexOf(":");
    hostPart = source.slice(0, colon);
    portPart = source.slice(colon + 1);
  }

  let port: PortPattern;
  if (portPart !== undefined) {
    if (portPart === "*") port = "any";
    else if (/^\d{1,5}$/.test(portPart) && Number(portPart) >= 1 && Number(portPart) <= 65535) port = Number(portPart);
    else fail("port must be 1-65535 or '*'");
  }

  let host: HostPattern;
  if (hostPart === "*") {
    if (mode === "sandbox" && list === "allow") fail("'*' (any host) is not allowed in sandbox mode");
    host = { kind: "any" };
  } else if (hostPart.startsWith("*.")) {
    const normalized = normalizeHost(hostPart.slice(2));
    if (!normalized || normalized.kind !== "name") fail("'*.' must be followed by a hostname");
    const suffix = normalized!.host;
    if (mode === "sandbox" && list === "allow" && !suffix.includes(".")) {
      fail("in sandbox mode a wildcard must name at least two labels (e.g. *.example.com)");
    }
    host = { kind: "subdomains", suffix };
  } else if (hostPart.includes("/") || parseIp(hostPart)) {
    const range = parseRange(hostPart);
    if (!range) fail("invalid IP address or CIDR range (canonical form, no host bits after the prefix)");
    const r = range!;
    if (mode === "sandbox" && list === "allow" && r.prefix < (r.family === 4 ? 8 : 32)) {
      fail(`in sandbox mode CIDR ranges must be /${r.family === 4 ? 8 : 32} or narrower`);
    }
    host = { kind: "address", range: r };
  } else {
    const normalized = normalizeHost(hostPart);
    if (!normalized) fail("invalid hostname");
    if (normalized!.kind === "address") {
      fail(`'${hostPart}' is an IP address in a non-canonical form; write it as ${normalized!.host}`);
    }
    host = { kind: "name", name: normalized!.host };
  }
  return { source, host, port };
}
