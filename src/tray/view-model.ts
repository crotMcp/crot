/**
 * What the tray shows (ARCHITECTURE.md §27, AD-19 points 4 and 10;
 * docs/design/approval-gates.md §6.3). Pure functions, no Electron: the
 * main process turns control-channel data into plain display rows, and the
 * renderer only puts these strings into the page as text.
 *
 * Presentation rules for an approval subject:
 * - every value is plain text, never Markdown, HTML or a link;
 * - control, bidi and zero-width characters are made visible;
 * - nothing is shortened: the full value is always shown;
 * - fields in Core's order with Core's labels;
 * - remote principal, outside-workspace paths, full_control and
 *   page-supplied values are marked prominently; `client` is self-reported.
 */
import type { PresentedApproval } from "../core/approvals/types.js";
import type { ControlOverview, PairingView, PresetValue, RemoteClientView } from "../service/protocol.js";

/** Characters that are invisible or reorder text: shown as [U+XXXX] (ASCII, so every font can show it). */
// The class deliberately lists variation selectors and other combining characters one by one.
const INVISIBLE =
  // eslint-disable-next-line no-misleading-character-class
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]|\udb40[\udc00-\udcff]/g;

/** Make every invisible, control, bidi or zero-width character visible; tabs and line feeds stay but are marked (a carriage return is shown as [U+000D]). */
export function visibleText(value: string): string {
  return value
    .replace(INVISIBLE, (ch) => {
      const cp = ch.codePointAt(0)!;
      return `[U+${cp.toString(16).toUpperCase().padStart(4, "0")}]`;
    })
    .replace(/\t/g, "[TAB]\t")
    .replace(/\n/g, "↵\n");
}

export type Mark = "outside workspace" | "page-supplied" | "size only" | "self-reported" | "remote" | "full control";

export interface DisplayRow {
  readonly label: string;
  readonly value: string;
  readonly marks: readonly Mark[];
  /** Number of characters of the original value (shown for long values; nothing is cut). */
  readonly length: number;
}

export interface ApprovalCard {
  readonly canApproveProject?: boolean;
  readonly requestId: string;
  readonly subjectDigest: string;
  readonly title: string;
  /** Prominent warnings, in this order: remote, full control, outside workspace, page-supplied text. */
  readonly banners: readonly string[];
  readonly rows: readonly DisplayRow[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

const row = (label: string, value: string, marks: Mark[] = []): DisplayRow => ({
  label: visibleText(label),
  value: visibleText(value),
  marks,
  length: value.length,
});

const FLAG_MARKS: Readonly<Record<string, Mark>> = {
  outside_workspace: "outside workspace",
  page_supplied: "page-supplied",
  secret_size_only: "size only",
};

/** An approval request as the tray shows it, in Core's field order. */
export function approvalCard(request: PresentedApproval): ApprovalCard {
  const s = request.subject;
  const rows: DisplayRow[] = [];
  rows.push(row("Operation", s.operation));
  if (s.workspace) rows.push(row("Project workspace", s.workspace));
  rows.push(row("Capabilities", s.capabilities.join(", ")));
  for (const effect of s.effects) {
    const mark = effect.flag ? FLAG_MARKS[effect.flag] : undefined;
    rows.push(row(effect.label, effect.value, mark ? [mark] : []));
  }
  for (const p of s.paths) rows.push(row("Path", p.absolute, p.insideWorkspace ? [] : ["outside workspace"]));
  for (const n of s.network) rows.push(row("Network", `${n.scheme}://${n.host}:${n.port}`));
  const principal = s.principal;
  const remote = principal.kind === "remote";
  rows.push(row("Agent", `${principal.kind} — ${principal.id}`, remote ? ["remote"] : []));
  rows.push(
    row("Transport", principal.authMethod ? `${principal.transport} (${principal.authMethod})` : principal.transport),
  );
  if (remote) {
    if (principal.accountId) rows.push(row("Account", principal.accountId, ["remote"]));
    if (principal.deviceId) rows.push(row("Device", principal.deviceId, ["remote"]));
    if (principal.clientId) rows.push(row("Client id", principal.clientId, ["remote"]));
  }
  if (principal.client) {
    const c = principal.client;
    rows.push(row("Client", `${c.name}${c.version ? ` ${c.version}` : ""}`, ["self-reported"]));
  }
  rows.push(row("Mode", s.mode, s.mode === "full_control" ? ["full control"] : []));
  rows.push(row("Rule", s.rule));
  if (s.browser) {
    rows.push(row("Browser tab", s.browser.tabId !== undefined ? String(s.browser.tabId) : "(new tab)"));
    rows.push(row("Browser origin", s.browser.origin));
  }
  const banners: string[] = [];
  if (remote) banners.push("REMOTE AGENT — this request comes through the relay, not from this computer.");
  if (s.mode === "full_control") banners.push("FULL CONTROL mode — the workspace boundary does not apply.");
  if (s.paths.some((p) => !p.insideWorkspace) || s.effects.some((e) => e.flag === "outside_workspace"))
    banners.push("OUTSIDE THE WORKSPACE — a path is outside the workspace.");
  if (s.effects.some((e) => e.flag === "page_supplied"))
    banners.push("Some values were supplied by a web page and may be misleading.");
  return {
    requestId: request.requestId,
    ...(s.workspace && s.rule === "runtime.ask" && s.paths.every((p) => p.insideWorkspace)
      ? { canApproveProject: true }
      : {}),
    subjectDigest: request.subjectDigest,
    title: visibleText(s.summary),
    banners,
    rows,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

export type Connection = "connecting" | "connected" | "not_running" | "error";

export interface TrayState {
  readonly connection: Connection;
  readonly error?: string;
  readonly overview?: ControlOverview;
  readonly pending: readonly PresentedApproval[];
  /** Result of the last action, shown once (e.g. "The preset can be changed only while CROT is idle"). */
  readonly notice?: string;
}

export interface PresetOption {
  readonly value: PresetValue;
  readonly label: string;
  readonly selected: boolean;
  readonly available: boolean;
  readonly note?: string;
}

export interface RemoteClientRow {
  readonly accountId: string;
  readonly deviceId: string;
  readonly clientId: string;
  /** Display text (visible characters). */
  readonly text: string;
  readonly exposure: RemoteClientView["exposure"];
  readonly revoked: boolean;
}

/** Pairing and identity (WP-28): state lines and the one action that applies. */
export interface PairingRow {
  readonly state: PairingView["state"] | "offline";
  /** Whether pairing can be started in this process. */
  readonly available: boolean;
  readonly action: "pair" | "cancel" | "unpair" | "none";
  /** Display lines (visible characters); never a token or credential. */
  readonly lines: readonly string[];
}

export interface TrayView {
  readonly accountSignedIn?: boolean;
  readonly agents?: ControlOverview["agents"];
  readonly browser?: ControlOverview["browser"];
  readonly workspace?: string;
  readonly mcpArgs?: readonly string[];
  readonly commercial?: ControlOverview["commercial"];
  readonly resourceUri?: string;
  readonly portalUrl?: string;
  readonly modules?: readonly { title: string; value: string; ready: boolean; note?: string; repair?: boolean }[];
  readonly connection: Connection;
  readonly headline: string;
  readonly notice?: string;
  readonly cards: readonly ApprovalCard[];
  readonly status: readonly DisplayRow[];
  readonly presets: readonly PresetOption[];
  readonly presetBlockedBy?: string;
  readonly remoteMode: boolean;
  /** The full-control opt-in as recorded in the device settings. */
  readonly fullControl: boolean;
  /** Whether the running Core applies it (WP-31): recorded and bound to the device paired here. */
  readonly fullControlEffective: boolean;
  readonly fullControlNote: string;
  /** Remote notes: tunnel, effective preset and its source, the remote profile and its restrictions (WP-31), errors. */
  readonly remoteNotes: readonly string[];
  readonly clients: readonly RemoteClientRow[];
  readonly pairing: PairingRow;
  /** Tray icon: attention while approvals wait, remote while remote mode is on. */
  readonly icon: "idle" | "remote" | "attention" | "offline";
  readonly tooltip: string;
}

const PRESET_LABELS: Readonly<Record<PresetValue, string>> = {
  "require-approval": "Ask for every action",
  "autonomous-browser": "Autonomous browser",
  off: "Off (no built-in approvals)",
};

const PRESET_SOURCES: Readonly<Record<ControlOverview["preset"]["source"], string>> = {
  device: "chosen on this device",
  configuration: "from the configuration file",
  "fail-closed": "device settings unreadable, most restrictive",
};

/**
 * The effective preset and the remote profile as reported by the running Core
 * (WP-31): what remote clients may do, whether the full-control opt-in is in
 * effect (and saved), and the restrictions that always apply to them.
 */
export function profileLines(o: ControlOverview): string[] {
  const lines = [
    `Approval preset: ${PRESET_LABELS[o.preset.effective]} (${o.preset.effective}), ${PRESET_SOURCES[o.preset.source]}`,
  ];
  const p = o.remote.profile;
  if (!p) return lines;
  lines.push(
    `Remote clients: mode ${p.mode}, untrusted-content protection ${p.untrustedContent}, capabilities ${p.capabilities.join(", ") || "none"}`,
  );
  const effective = o.remote.fullControlEffective ?? p.fullControl.enabled;
  const account = p.fullControl.accountId ? ` (account ${p.fullControl.accountId})` : "";
  const unsaved = o.remote.fullControl ? "" : " (not saved: off after a restart)";
  lines.push(
    effective && p.fullControl.deviceId
      ? `Remote full control: ON for device ${p.fullControl.deviceId}${account} only${unsaved}`
      : o.remote.fullControl
        ? "Remote full control: recorded in the device settings but NOT in effect; remote clients stay in the workspace"
        : "Remote full control: off",
  );
  for (const r of p.restrictions) lines.push(`Restriction: ${r}`);
  return lines;
}

export function trayView(state: TrayState): TrayView {
  const o = state.overview;
  const cards = state.pending.map(approvalCard);
  const offline = state.connection !== "connected" || !o;
  const headline =
    state.connection === "not_running"
      ? "CROT service is not running"
      : state.connection === "connecting"
        ? "Connecting to the CROT service…"
        : state.connection === "error"
          ? `Cannot connect: ${visibleText(state.error ?? "unknown error")}`
          : cards.length > 0
            ? `${cards.length} request${cards.length === 1 ? "" : "s"} waiting for your approval`
            : "CROT is running";
  const status: DisplayRow[] = o
    ? [
        row("Service", `${o.service.state}, pid ${o.service.pid}, ${o.service.launch}, version ${o.service.version}`),
        row("Mode", o.mode, o.mode === "full_control" ? ["full control"] : []),
        row("Workspace", o.workspace),
        row(
          "Agents",
          `${o.agents.stdio} local stdio, ${o.agents.httpSessions} HTTP session(s), ${o.agents.httpSessionlessInFlight} sessionless request(s) in flight, ${o.agents.remoteClients} remote client(s)`,
        ),
        row(
          "Browser",
          o.browser.state === "connected"
            ? `${o.browser.name ?? "browser"} ${o.browser.version ?? ""} (extension ${o.browser.extensionVersion ?? "?"}), connection ${o.browser.connectionId ?? "?"}`
            : o.browser.state,
        ),
        row("Approval UIs", `${o.approvals.trays} tray(s) connected, ${o.approvals.pending} pending`),
        row("Command confinement (L1)", confinementText(o.mode, o.confinement)),
        row("CDP browser backend", o.cdp.available ? "available" : `not available — ${o.cdp.reason}`),
      ]
    : [];
  const presets: PresetOption[] = o
    ? (["require-approval", "autonomous-browser", "off"] as const).map((value) => {
        const unavailable = o.preset.unavailable.find((u) => u.value === value);
        return {
          value,
          label: PRESET_LABELS[value],
          selected: o.preset.effective === value,
          available: o.preset.selectable.includes(value),
          ...(unavailable ? { note: unavailable.reason } : {}),
        };
      })
    : [];
  const clients: RemoteClientRow[] = (o?.remote.clients ?? []).map((c) => ({
    accountId: c.accountId,
    deviceId: c.deviceId,
    clientId: c.clientId,
    text: visibleText(`client ${c.clientId} — account ${c.accountId}, device ${c.deviceId}; last seen ${c.lastSeen}`),
    exposure: c.exposure,
    revoked: c.revokedAt !== undefined,
  }));
  const remoteNotes = o
    ? [
        o.remote.tunnel,
        ...(o.commercial
          ? [
              o.commercial.state === "current"
                ? `Cloud plan: ${o.commercial.plan}; remote ${o.commercial.entitled ? "entitled" : "not entitled"}; devices ${o.commercial.deviceCount}/${o.commercial.maxDevices}. Local mode is always free.`
                : "Cloud plan: unknown (offline or unavailable). Local mode is unaffected.",
            ]
          : []),
        ...(o.preset.source === "fail-closed"
          ? ["The device settings cannot be read: the most restrictive settings apply."]
          : []),
        ...profileLines(o),
        ...o.remote.errors,
      ].map(visibleText)
    : [];
  const icon = offline ? "offline" : cards.length > 0 ? "attention" : o.remote.mode ? "remote" : "idle";
  const tooltip = offline
    ? `CROT — ${headline}`
    : `CROT — ${cards.length > 0 ? headline : o.remote.mode ? "remote mode ON" : "running"}`;
  return {
    ...(o?.mcpArgs ? { mcpArgs: o.mcpArgs } : {}),
    ...(o?.workspace ? { workspace: o.workspace } : {}),
    ...(o?.commercial ? { commercial: o.commercial } : {}),
    accountSignedIn: o?.accountSignedIn === true,
    ...(o?.pairing.device?.resourceUri ? { resourceUri: o.pairing.device.resourceUri } : {}),
    ...(o?.pairing.environment ? { portalUrl: `https://${o.pairing.environment.relayHost}/portal` } : {}),
    modules: [
      {
        title: "Local service",
        value: offline ? "Not running" : "Online",
        ready: !offline,
        note: "Local tools are independent of your cloud plan.",
      },
      {
        title: "Browser & CDP",
        value: o?.browser.state === "connected" ? `${o.browser.name ?? "Browser"} connected` : "Not connected",
        ready: o?.browser.state === "connected",
        note: o?.cdp.available
          ? "Controlled browser automation is ready."
          : "Connect the CROT extension in Chrome, Edge or Brave.",
      },
      {
        title: "L1 sandbox",
        value: o?.confinement.available ? "Available" : "Setup required",
        ready: o?.confinement.available ?? false,
        repair: !o?.confinement.available,
        note: "Platform confinement is checked by the service, never inferred from installation.",
      },
      {
        title: "Cloud tunnel",
        value: o?.remote.mode ? "Remote mode enabled" : "Local mode",
        ready: o?.remote.mode ?? false,
        note: "Remote admission requires a current cloud entitlement.",
      },
    ],
    agents: o?.agents,
    browser: o?.browser,
    connection: state.connection,
    headline,
    ...(state.notice ? { notice: visibleText(state.notice) } : {}),
    cards,
    status,
    presets,
    ...(o?.preset.blockedBy ? { presetBlockedBy: o.preset.blockedBy } : {}),
    remoteMode: o?.remote.mode ?? false,
    fullControl: o?.remote.fullControl ?? false,
    fullControlEffective: o?.remote.fullControlEffective ?? o?.remote.profile?.fullControl.enabled ?? false,
    fullControlNote: o?.remote.fullControlNote ?? "",
    remoteNotes,
    clients,
    pairing: pairingRow(o?.pairing),
    icon,
    tooltip,
  };
}

/** The pairing section (WP-28, AD-21): environment, device URI, pending sign-in, last failure. */
export function pairingRow(p: PairingView | undefined): PairingRow {
  if (!p) return { state: "offline", available: false, action: "none", lines: [] };
  const lines: string[] = [];
  const env = p.environment;
  if (env)
    lines.push(
      `Identity environment: ${env.id} (${env.kind}), issuer ${env.issuer}, relay ${env.relayHost}; RFC 9207 ${env.rfc9207.replace("_", " ")}`,
    );
  if (!p.available && p.reason) lines.push(`Pairing is not available: ${p.reason}`);
  if (p.state === "paired" && p.device) {
    lines.push(`Paired to account ${p.device.accountId} as device ${p.device.deviceId} (since ${p.device.pairedAt})`);
    if (p.device.resourceUri) lines.push(`Device address for MCP clients: ${p.device.resourceUri}`);
  } else if (p.state === "pairing" && p.pending) {
    lines.push(`Waiting for sign-in until ${p.pending.expiresAt}: ${p.pending.authorizationUrl}`);
  } else if (p.state === "unpaired") {
    lines.push("This device is not paired: no remote request is accepted.");
  }
  if (p.error) lines.push(`Device binding: ${p.error}`);
  if (p.lastFailure) lines.push(`Last pairing attempt failed (${p.lastFailure.at}): ${p.lastFailure.reason}`);
  const action =
    p.state === "pairing"
      ? "cancel"
      : p.state === "paired" || p.state === "unavailable"
        ? "unpair"
        : p.available
          ? "pair"
          : "none";
  return { state: p.state, available: p.available, action, lines: lines.map(visibleText) };
}

/** The L1 row: state, reason code and its explanation as reported by the service (AD-20 point 12). */
function confinementText(mode: string, c: ControlOverview["confinement"]): string {
  const detail = c.detail ? ` (${c.detail})` : "";
  if (mode === "full_control")
    return `does not apply in full control${c.available ? "" : `; not available — ${c.reason ?? "unknown"}`}${detail}`;
  if (c.available) return `active, network ${c.network}${detail}`;
  return `not available — ${c.reason ?? "unknown"}${detail}`;
}
