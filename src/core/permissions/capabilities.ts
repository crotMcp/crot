import { z } from "zod";

/**
 * The single capability vocabulary of CROT (ARCHITECTURE.md §6).
 *
 * Every component (filesystem, process, browser, git, and later docker, network)
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
  "git.read":
    "Run read-only Git operations (status, diff, log, branch, show) without repository-controlled programs.",
  "git.write": "Reserved: dedicated Git write operations.",
  "docker.use": "Reserved: dedicated Docker operations.",
  "browser.read":
    "Read browser state through the CROT Browser Extension: bridge status, open tabs, page content and screenshots.",
  "browser.control":
    "Control the browser through the CROT Browser Extension: open, navigate, activate and close tabs; click and type on pages.",
  "network.access": "Reserved: dedicated network operations.",
};

/**
 * Capabilities that currently gate implemented operations. The rest are part of
 * the model so that policies and clients can already reason about them, but no
 * operation uses them yet.
 */
export const ENFORCED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "filesystem.read",
  "filesystem.write",
  "filesystem.full",
  "shell.execute",
  "process.manage",
  "git.read",
  "browser.read",
  "browser.control",
]);
