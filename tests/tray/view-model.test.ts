import { describe, expect, it } from "vitest";
import type { PresentedApproval } from "../../src/core/approvals/types.js";
import type { ControlOverview } from "../../src/service/protocol.js";
import { approvalCard, trayView, visibleText } from "../../src/tray/view-model.js";

/** WP-22 / AD-19 point 4: how the tray presents an approval subject (docs/design/approval-gates.md §6.3). */

function approval(overrides: Partial<PresentedApproval["subject"]> = {}): PresentedApproval {
  return {
    requestId: "req-1",
    subjectDigest: "d".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:02:00.000Z",
    subject: {
      operation: "filesystem.write",
      capabilities: ["filesystem.write"],
      summary: "Write a file",
      effects: [
        { label: "Bytes", value: "12" },
        { label: "Target", value: "/etc/hosts", flag: "outside_workspace" },
      ],
      paths: [
        { absolute: "/work/a.txt", insideWorkspace: true },
        { absolute: "/etc/hosts", insideWorkspace: false },
      ],
      network: [],
      principal: {
        id: "local-user",
        kind: "local",
        transport: "stdio",
        client: { name: "Evil\u202eAgent", version: "1" },
      },
      mode: "sandbox",
      rule: "writes",
      ...overrides,
    },
  };
}

describe("visibleText", () => {
  it("makes bidi, zero-width and control characters visible", () => {
    expect(visibleText("a\u202eb")).toBe("a[U+202E]b");
    expect(visibleText("a\u200bb\u2066c\ufeff")).toBe("a[U+200B]b[U+2066]c[U+FEFF]");
    expect(visibleText("x\u0000y\u001bz\u007f")).toBe("x[U+0000]y[U+001B]z[U+007F]");
    expect(visibleText("tag\u{e0041}")).toBe("tag[U+E0041]");
    expect(visibleText("a\tb")).toBe("a[TAB]\tb");
    expect(visibleText("1\n2\r\n3")).toBe("1↵\n2[U+000D]↵\n3");
  });

  it("never shortens a value", () => {
    const long = "x".repeat(50_000);
    expect(visibleText(long)).toBe(long);
    const card = approvalCard(approval({ effects: [{ label: "Content", value: long }] }));
    const r = card.rows.find((x) => x.label === "Content")!;
    expect(r.value).toBe(long);
    expect(r.length).toBe(50_000);
  });
});

describe("approvalCard", () => {
  it("lists fields in Core's order with marks", () => {
    const card = approvalCard(approval());
    expect(card.rows.map((r) => r.label)).toEqual([
      "Operation",
      "Capabilities",
      "Bytes",
      "Target",
      "Path",
      "Path",
      "Agent",
      "Transport",
      "Client",
      "Mode",
      "Rule",
    ]);
    expect(card.rows.find((r) => r.label === "Target")!.marks).toEqual(["outside workspace"]);
    expect(card.rows.filter((r) => r.label === "Path").map((r) => r.marks)).toEqual([[], ["outside workspace"]]);
    const client = card.rows.find((r) => r.label === "Client")!;
    expect(client.marks).toEqual(["self-reported"]);
    expect(client.value).toBe("Evil[U+202E]Agent 1");
    expect(card.banners).toEqual(["OUTSIDE THE WORKSPACE — a path is outside the workspace."]);
    expect(card.subjectDigest).toBe("d".repeat(64));
  });

  it("puts remote, full control, outside workspace and page-supplied banners first, in that order", () => {
    const card = approvalCard(
      approval({
        mode: "full_control",
        effects: [{ label: "Tab URL", value: "https://evil.example/\u200bApprove", flag: "page_supplied" }],
        principal: {
          id: "acct",
          kind: "remote",
          transport: "http",
          authMethod: "relay-token",
          accountId: "acct",
          deviceId: "dev",
          clientId: "cli",
        },
        browser: { tabId: 7, origin: "https://evil.example", connectionId: "c1" },
      }),
    );
    expect(card.banners).toHaveLength(4);
    expect(card.banners[0]).toMatch(/^REMOTE AGENT/);
    expect(card.banners[1]).toMatch(/^FULL CONTROL/);
    expect(card.banners[2]).toMatch(/^OUTSIDE THE WORKSPACE/);
    expect(card.banners[3]).toMatch(/supplied by a web page/);
    const tab = card.rows.find((r) => r.label === "Tab URL")!;
    expect(tab.marks).toEqual(["page-supplied"]);
    expect(tab.value).toBe("https://evil.example/[U+200B]Approve");
    expect(card.rows.find((r) => r.label === "Agent")!.marks).toEqual(["remote"]);
    expect(card.rows.find((r) => r.label === "Mode")!.marks).toEqual(["full control"]);
    expect(card.rows.find((r) => r.label === "Transport")!.value).toBe("http (relay-token)");
    expect(card.rows.slice(-2).map((r) => r.label)).toEqual(["Browser tab", "Browser origin"]);
  });

  it("escapes the summary used as the title", () => {
    expect(approvalCard(approval({ summary: "Run\u2067 rm" })).title).toBe("Run[U+2067] rm");
  });
});

describe("trayView", () => {
  const overview = (extra: Partial<ControlOverview["remote"]> = {}): ControlOverview => ({
    service: { state: "running", pid: 1, version: "0.1.0", launch: "managed", uptimeMs: 1 },
    mode: "workspace",
    workspace: "/work",
    preset: {
      effective: "require-approval",
      source: "device",
      configured: "require-approval",
      selectable: ["require-approval", "off"],
      unavailable: [{ value: "autonomous-browser", reason: "Comes with WP-31." }],
    },
    remote: {
      mode: false,
      fullControl: false,
      fullControlNote: "Recorded only.",
      tunnel: "No tunnel.",
      clients: [],
      errors: [],
      ...extra,
    },
    agents: { stdio: 1, httpSessions: 0, httpSessionlessInFlight: 0, remoteClients: 0 },
    browser: { state: "disconnected" },
    approvals: { trays: 1, pending: 0 },
    confinement: { available: false, reason: "WP-23" },
    cdp: { available: false, reason: "WP-24" },
    pairing: { available: false, reason: "WP-28" },
  });

  it("shows offline states", () => {
    expect(trayView({ connection: "not_running", pending: [] })).toMatchObject({
      icon: "offline",
      headline: "CROT service is not running",
      cards: [],
      presets: [],
    });
    expect(trayView({ connection: "error", error: "bad\u202e", pending: [] }).headline).toBe(
      "Cannot connect: bad[U+202E]",
    );
  });

  it("shows pending requests, presets and the remote icon", () => {
    const busy = trayView({ connection: "connected", overview: overview(), pending: [approval()] });
    expect(busy.icon).toBe("attention");
    expect(busy.headline).toBe("1 request waiting for your approval");
    expect(busy.presets.map((p) => [p.value, p.selected, p.available])).toEqual([
      ["require-approval", true, true],
      ["autonomous-browser", false, false],
      ["off", false, true],
    ]);
    expect(busy.presets[1]!.note).toBe("Comes with WP-31.");
    const remote = trayView({ connection: "connected", overview: overview({ mode: true }), pending: [] });
    expect(remote.icon).toBe("remote");
    expect(remote.tooltip).toBe("CROT — remote mode ON");
  });

  it("escapes remote client identifiers", () => {
    const v = trayView({
      connection: "connected",
      overview: overview({
        clients: [
          {
            accountId: "a",
            deviceId: "d",
            clientId: "c\u200b",
            firstSeen: "t0",
            lastSeen: "t1",
            exposure: "exposed",
          },
        ],
      }),
      pending: [],
    });
    expect(v.clients[0]!.text).toContain("c[U+200B]");
    expect(v.clients[0]!.clientId).toBe("c\u200b");
  });
});
