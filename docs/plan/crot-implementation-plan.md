# CROT — Implementation Plan (v1: Remote MCP)

This file is the working plan for CROT v1. It is derived from
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) (the source of truth) and from the
Remote MCP v1 review recorded in ARCHITECTURE.md §27 AD-14. The detailed work
packages are in [`crot-agent-work-packages.md`](crot-agent-work-packages.md).

Precedence when documents disagree: `ARCHITECTURE.md` (including §27
decisions) > this plan > the work-package cards > `README.md` and `docs/*`
(which describe the current implementation).

## 1. Goal of v1

```text
remote MCP client (any compatible type)
  -> internet / CROT Cloud Relay
  -> local CROT on the user's device
  -> the user's computer (project files, commands, Git, Docker)
     + the user's real browser, its tabs and the web services the user is logged in to
```

- A remote agent must be able to carry out **real multi-step tasks in the
  user's browser** (navigate, operate controls, forms, dialogs, file upload and
  download, several tabs and pop-ups), combined with local project work — not
  only read pages and perform a few simple actions (ARCHITECTURE.md §1, §7.1).
- Concrete clients (Notion, Claude, Cursor, …) are **compatibility examples**,
  never a basis of the architecture or a milestone (§11, §14).
- The **external MCP gateway** (CROT as an MCP client of external servers,
  §18) is a separate direction, **post-v1**, and is not mixed with this plan.

## 2. Current state (`main` at `0f0634c`)

Work packages before WP-10 were not numbered in the repository; they are
listed by content.

| Old WP / item | What | Status |
| --- | --- | --- |
| Foundation (unnumbered) | Core, PermissionEngine, ExecutionGuard, audit, files, processes and shell, platform layer Linux/macOS/Windows, MCP over stdio | Done |
| Same | Streamable HTTP, loopback only, local token | Done; **needs change** in WP-19: HTTP principal is always `kind: "remote"`, no stateless 2026-07-28 requests |
| Same | Native Host (Job Objects, ACLs) | Done |
| Same | Browser bridge, native-messaging relay, MV3 extension, `browser install`, E2E on real Chromium | **Partial**: chain works, command set too small for v1 (WP-24…WP-27) |
| WP-04 | ESLint, Prettier, `npm run check` | Done |
| WP-10 / WP-11 | `git.read` / `git.write` (AD-1, AD-2) | Done |
| WP-12 | `docker.use` (AD-3) | Done |
| WP-13 | `network.access` (AD-4); OS-level egress is post-v1 | Done |
| WP-14 | Approval gates design (AD-5…AD-7) | Done |
| WP-15 | Approval gates mechanism, tab/origin/connection binding (AD-8…AD-11) | Done as mechanism; no UI provider (→ WP-22) |
| WP-16a / WP-16b | Session exposure and the `untrusted-content` rule (AD-12) | Done; **needs change** for remote principals without sessions (AD-15, WP-19) |
| PR #10, AD-13 | v1 scope | Done; amended by AD-14 (browser contract v1, order, acceptance) |
| §16 items 8–9 | Client-specific and project-specific first milestones | **Withdrawn**, replaced by WP-32 |
| §16 items 19, 23; Git network / Docker build | External MCP gateway, OS egress, Git/Docker extensions | **Post-v1**, do not touch |

## 3. Phases and work packages

Sizes: S — up to 2 days, M — 3–5 days, L — 1–2 weeks, XL — more than 2 weeks.
Status values: `Not started`, `In progress`, `In review`, `Done`. Update the
status in the same PR that completes a work package.

| WP | Phase | Title | Depends on | Size | Status |
| --- | --- | --- | --- | --- | --- |
| WP-17 | 0 | AD-15 "Remote MCP request contract" (documents only) | — | S | Done (AD-15) |
| WP-18 | 0 | Browser spike CDP vs scripting, AD-16 "Browser contract v1" | — (parallel to WP-17) | S–M | Done (AD-16) |
| WP-19 | 1 | Principal kinds, exposure key, stateless HTTP per AD-15 | WP-17 | M | Not started |
| WP-20 | 1 | Supervised service, thin stdio shim, local control channel | WP-19 | L | Not started |
| WP-21 | 1 | Secret storage, child-process environment allowlist | WP-20 | M | Not started |
| WP-22 | 1 | Tray v1 and approval provider | WP-20 | L | Not started |
| WP-23a | 2 | Command confinement L1: Linux (bubblewrap, AppArmor) | WP-21 | M | Not started |
| WP-23b | 2 | Command confinement L1: macOS (Seatbelt, Keychain) | WP-21 | M | Not started |
| WP-23c | 2 | Command confinement L1: Windows (spike, then restricted / low-IL token + Job Object) | WP-21 | L | Not started |
| WP-24 | 2B | Browser v1 (AD-16): CDP backend, snapshot and references, trusted input, keys, frames, shadow DOM, waiting, history, `openerTabId` | WP-18 | L | Not started |
| WP-25 | 2B | Browser v1 (AD-16): dialogs and file choosers, background screenshots, debugger lifecycle, CROT tab group | WP-24 | M | Not started |
| WP-26 | 2B | Browser v1 (AD-16): file upload from and download to the workspace | WP-24 | M | Not started |
| WP-27 | 2B | Browser v1 (AD-16): multi-agent safety (per-tab queue, explicit `tabId` for remote, `openedBy`) | WP-24, WP-19 | S–M | Not started |
| WP-28 | 3 | Identity and device binding | WP-17, WP-21, WP-22 (pairing UI) | L | Not started |
| WP-29 | 3 | Cloud Relay v1 | WP-17, WP-28 | XL | Not started |
| WP-30 | 3 | Device tunnel adapter | WP-20, WP-28, WP-29 | M–L | Not started |
| WP-31 | 3 | Remote permission profile and presets | WP-19, WP-22, WP-23a/b/c, WP-30 | M | Not started |
| WP-32 | 3 | Remote E2E acceptance suite and client compatibility | WP-30, WP-31, WP-24…WP-26 | L | Not started |
| WP-33 | 3 | External security review and fixes | WP-32 | M | Not started |
| WP-34 | 4 | Installers, signing, updates, native-host registration, service autostart | WP-20, WP-22 | L | Not started |
| WP-35 | 4 | Extension publication (Chrome Web Store, Edge Add-ons) | WP-25 | M | Not started |
| WP-36 | 4 | Minimal accounts and plans, entitlement check at the relay | WP-29 | M | Not started |
| WP-37 | 4 | Hardening, documentation, legal, release checklist | all above | M | Not started |

WP-28 needs the pairing screen of WP-22 only for its final step; the identity
provider selection and the verifier can start right after WP-17.

## 4. The full v1 chain and its work packages

```text
remote MCP client
  --(OAuth: WP-28)--> Cloud Relay (WP-29)
  --(outbound tunnel: WP-30)--> local CROT service (WP-20)
  --> Core: ExecutionGuard, approvals in the tray (WP-22), exposure (WP-19),
      remote profile and presets (WP-31)
  --> project: files, commands under L1 (WP-23a/b/c), Git, Docker (done)
  --> user's real browser (bridge done; browser v1: WP-24…WP-27)
  --> result
verified end to end by WP-32, reviewed by WP-33, shipped by WP-34…WP-37
```

## 5. Critical path and parallel work

Critical path to Remote MCP v1:

```text
WP-17 -> WP-19 -> WP-20 -> WP-22 -> WP-30 -> WP-31 -> WP-32 -> WP-33 -> WP-34 + WP-37 -> release
```

- Relay branch, merges into WP-30: `WP-17 -> WP-28 -> WP-29`.
- Browser branch, merges into WP-32: `WP-18 -> WP-24 -> WP-25` and `WP-24 -> WP-26` (and WP-27).

In parallel:

- WP-18 together with WP-17;
- WP-28 and WP-29 right after WP-17, without waiting for phase 1;
- L1 (WP-23a/b/c) after WP-21;
- browser v1 (WP-24…WP-27);
- WP-35 early (store review takes long);
- WP-36.

The longest branches are the relay (XL) and the browser (L + 2×M, AD-16); they start
earlier than AD-13 originally planned (AD-14 point 6).

## 6. Simplifications that keep v1 complete

- **The relay does not implement MCP.** It is an HTTP router with a tunnel;
  the device reuses its HTTP pipeline and `createCrotMcpServer`.
- **Control channel and stdio shim** reuse the framing, token and endpoint
  handling of the browser bridge.
- **The tray** is an implementation of the existing `ApprovalProvider`
  interface; broker, digest and audit stay unchanged.
- **Remote profile and presets** are configuration on the existing matchers
  (`principalKinds`, `exposed`, capabilities); no second mechanism.
- **The spike chose CDP (AD-16)**: one mechanism covers snapshot, input,
  frames, file inputs, dialogs and background screenshots. WP-24 therefore
  takes trusted input, frames and shadow DOM; WP-25 shrinks to dialogs,
  background screenshots and the debugger lifecycle; WP-26 depends only on
  WP-24.
- **No own authorization server, no local licensing, no relay end-to-end
  encryption in v1** (AD-13 point 6).
- **No client-specific milestones**; WP-32 replaces them.

## 7. Next work packages

WP-17 and WP-18 are done: AD-15 fixes the remote MCP request contract, AD-16
the browser contract v1. The current snapshot (last completed, next, open
questions) is in [`STATUS.md`](../../STATUS.md).

Now unblocked, in parallel:

1. **WP-19** — principal kinds, exposure scope and sessionless HTTP per AD-15
   (critical path; starts with the SDK decision, see STATUS.md).
2. **WP-24** — browser v1 on the CDP backend per AD-16 (browser branch),
   then WP-25, WP-26 and WP-27; **WP-35** can be submitted early with the
   AD-16 permission justification.
3. **WP-28** (identity-provider selection and verifier) and then **WP-29**
   (relay), which AD-14 point 6 starts right after AD-15.

## 8. Working rules

- Decision before code: a work package that changes an architectural
  boundary starts with an AD in ARCHITECTURE.md §27 (its own PR or the first
  commit of the WP PR, as the card says).
- One work package — one PR. The PR updates this plan's status column,
  `STATUS.md`, the status markers in ARCHITECTURE.md (§2.4, §25) and the
  user-facing docs (`README.md`, `docs/*`) it affects.
- `npm run check` passes; nothing that already works is broken. Behaviour
  changes are stated in the PR and in the docs.
- No client-specific code or tests in Core, adapters or the relay; clients
  are exercised only in WP-32.
- Nothing from the external MCP gateway (§18) or other post-v1 items
  (AD-13 point 7) is built as part of these work packages.
