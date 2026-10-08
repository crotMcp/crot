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
import type { ControlOverview, PresetValue, RemoteClientView } from "../service/protocol.js";

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

export interface TrayView {
  readonly connection: Connection;
  readonly headline: string;
  readonly notice?: string;
  readonly cards: readonly ApprovalCard[];
  readonly status: readonly DisplayRow[];
  readonly presets: readonly PresetOption[];
  readonly presetBlockedBy?: string;
  readonly remoteMode: boolean;
  readonly fullControl: boolean;
  readonly fullControlNote: string;
  readonly remoteNotes: readonly string[];
  readonly clients: readonly RemoteClientRow[];
  readonly pairing: string;
  /** Tray icon: attention while approvals wait, remote while remote mode is on. */
  readonly icon: "idle" | "remote" | "attention" | "offline";
  readonly tooltip: string;
}

const PRESET_LABELS: Readonly<Record<PresetValue, string>> = {
  "require-approval": "Ask for every action",
  "autonomous-browser": "Autonomous browser",
  off: "Off (no built-in approvals)",
};

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
        row("CDP browser backend", `not available — ${o.cdp.reason}`),
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
        ...(o.preset.source === "fail-closed"
          ? ["The device settings cannot be read: the most restrictive settings apply."]
          : []),
        ...o.remote.errors.map(visibleText),
      ]
    : [];
  const icon = offline ? "offline" : cards.length > 0 ? "attention" : o.remote.mode ? "remote" : "idle";
  const tooltip = offline
    ? `CROT — ${headline}`
    : `CROT — ${cards.length > 0 ? headline : o.remote.mode ? "remote mode ON" : "running"}`;
  return {
    connection: state.connection,
    headline,
    ...(state.notice ? { notice: visibleText(state.notice) } : {}),
    cards,
    status,
    presets,
    ...(o?.preset.blockedBy ? { presetBlockedBy: o.preset.blockedBy } : {}),
    remoteMode: o?.remote.mode ?? false,
    fullControl: o?.remote.fullControl ?? false,
    fullControlNote: o?.remote.fullControlNote ?? "",
    remoteNotes,
    clients,
    pairing: o?.pairing.reason ?? "",
    icon,
    tooltip,
  };
}

/** The L1 row: state, reason code and its explanation as reported by the service (AD-20 point 12). */
function confinementText(mode: string, c: ControlOverview["confinement"]): string {
  const detail = c.detail ? ` (${c.detail})` : "";
  if (mode === "full_control")
    return `does not apply in full control${c.available ? "" : `; not available — ${c.reason ?? "unknown"}`}${detail}`;
  if (c.available) return `active, network ${c.network}${detail}`;
  return `not available — ${c.reason ?? "unknown"}${detail}`;
}
