import { z } from "zod";

/**
 * The single capability vocabulary of CROT (ARCHITECTURE.md §6).
 *
 * Every component (filesystem, process, browser, git, docker, and later network)
 * is authorized through these capabilities by the one PermissionEngine.
 */
export const CAPABILITIES = [
  "filesystem.read",
  "filesystem.write",
  "filesystem.full",
  "shell.execute",
  "process.manage",
  "git.read",
  "git.write",
  "docker.use",
  "browser.read",
  "browser.control",
  "network.access",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const CapabilitySchema = z.enum(CAPABILITIES);

export const CAPABILITY_DESCRIPTIONS: Readonly<Record<Capability, string>> = {
  "filesystem.read": "Read files and directory listings.",
  "filesystem.write": "Create, modify, move and delete files and directories.",
  "filesystem.full": "Access paths outside the configured workspace (filesystem and process working directories).",
  "shell.execute": "Run commands and shell scripts.",
  "process.manage": "Start, inspect and stop long-running background processes.",
  "git.read": "Run read-only Git operations (status, diff, log, branch, show) without repository-controlled programs.",
  "git.write":
    "Run local Git write operations (add, commit, branch create/rename/delete, checkout of a branch or an explicit detached commit) without repository-controlled programs; no push or other network operations.",
  "docker.use":
    "Run dedicated Docker operations: list containers, read container logs, Compose up/down. Containers, Compose files and mounted host paths outside the workspace also need filesystem.full; no shell, no arbitrary Docker commands, no build, pull, push or run.",
  "browser.read":
    "Read browser state through the CROT Browser Extension: bridge status, open tabs, page content and screenshots.",
  "browser.control":
    "Control the browser through the CROT Browser Extension: open, navigate, activate and close tabs; click and type on pages.",
  "network.access":
    "Send HTTP(S) requests to hosts allowed by the network policy (permissions.network); deny by default. Loopback, private and link-local addresses need explicit IP/CIDR rules. Does not grant commands, processes or containers anything.",
};

/**
 * Capabilities that currently gate implemented operations. The rest are part of
 * the model so that policies and clients can already reason about them, but no
 * operation uses them yet (currently: none).
 */
export const ENFORCED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "filesystem.read",
  "filesystem.write",
  "filesystem.full",
  "shell.execute",
  "process.manage",
  "git.read",
  "git.write",
  "docker.use",
  "browser.read",
  "browser.control",
  "network.access",
]);
