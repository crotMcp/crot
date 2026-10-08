import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CrotCore } from "../../src/core/crot-core.js";
import { createTestCore, isWindows, makeTempDirs, testContext as ctx, type TempDirs } from "../helpers.js";

/** Empty global configuration for test-side Git (os.devNull is \\.\nul on Windows, which Git cannot access). */
const EMPTY_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "crot-git-test-"));
const EMPTY_CONFIG = path.join(EMPTY_CONFIG_DIR, "empty.gitconfig");
writeFileSync(EMPTY_CONFIG, "");
afterAll(() => rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

/** Environment for test-side Git: no system/global configuration, fixed identity. */
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))),
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

/** Repository with two commits on main, a feature branch, one modified, one staged and one untracked file. */
async function buildRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  await writeFile(path.join(dir, "a.txt"), "one\n");
  await writeFile(path.join(dir, "b.txt"), "bee\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  await writeFile(path.join(dir, "a.txt"), "one\ntwo\n");
  git(dir, "commit", "-q", "-am", "second");
  git(dir, "branch", "feature");
  await writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(path.join(dir, "b.txt"), "bee staged\n");
  git(dir, "add", "b.txt");
  await writeFile(path.join(dir, "new.txt"), "untracked\n");
  return dir;
}

let template: Promise<string> | undefined;
/**
 * A fresh copy of the repository of buildRepo. The repository is built once
 * per file (each build runs many synchronous Git processes, slow on Windows
 * runners) and copied into `dir` with its history, index and timestamps.
 */
async function makeRepo(dir: string): Promise<string> {
  template ??= buildRepo(path.join(EMPTY_CONFIG_DIR, "template-repo"));
  await mkdir(path.dirname(dir), { recursive: true });
  await cp(await template, dir, { recursive: true, preserveTimestamps: true });
  return dir;
}

/**
 * Diagnostics for the intermittent "Hook timed out in 10000ms" of the
 * sandbox-mode beforeEach on CI (Windows, Node 20): times its three steps and
 * prints one line when the hook takes more than 2 s. Shortly before the 10 s
 * hook timeout it also prints the step that is still running, because a timed
 * out hook may never finish. Prints nothing for an ordinary hook and changes
 * nothing else.
 */
function hookTimer(test: string): { step(next: string): void; done(): void } {
  const start = performance.now();
  const durations: string[] = [];
  let current = "makeTempDirs";
  let since = start;
  const elapsed = (from: number) => `${Math.round(performance.now() - from)}ms`;
  const watchdog = setTimeout(() => {
    console.warn(
      `[git.test beforeEach > 9 s] still in ${current} (${elapsed(since)}); ${[...durations, `total=${elapsed(start)}`].join(" ")} | ${test}`,
    );
  }, 9_000);
  watchdog.unref();
  return {
    step(next) {
      durations.push(`${current}=${elapsed(since)}`);
      current = next;
      since = performance.now();
    },
    done() {
      clearTimeout(watchdog);
      if (performance.now() - start <= 2_000) return;
      console.warn(
        `[git.test beforeEach > 2 s] ${[...durations, `${current}=${elapsed(since)}`, `total=${elapsed(start)}`].join(" ")} | ${test}`,
      );
    },
  };
}

const MARKER = "crot-git-read-marker";

/** A command that would create `marker` if Git ever ran it. */
function markerCommand(marker: string): string {
  const m = marker.replace(/\\/g, "/");
  return isWindows ? `cmd /c echo x > "${marker}"` : `touch '${m}'`;
}

describe("git.read in sandbox mode", () => {
  let dirs: TempDirs;
  let core: CrotCore;
  let repo: string;

  beforeEach(async ({ task }) => {
    const timer = hookTimer(task.name);
    try {
      dirs = await makeTempDirs();
      timer.step("makeRepo");
      repo = await makeRepo(path.join(dirs.workspace, "repo"));
      timer.step("createTestCore");
      core = await createTestCore({ workspace: { root: dirs.workspace } });
    } finally {
      timer.done();
    }
  });
  afterEach(async () => {
    // After a failed beforeEach they may be unset: report its error, not a TypeError (both are idempotent).
    await core?.shutdown();
    await dirs?.cleanup();
  });

  it("reports git.read as granted and enforced", () => {
    const entry = core.status().capabilities.find((c) => c.capability === "git.read");
    expect(entry).toMatchObject({ granted: true, enforced: true });
  });

  it("status lists branch and changes", async () => {
    const r = await core.git.status(ctx, { cwd: "repo" });
    expect(r.branch.head).toBe("main");
    expect(r.clean).toBe(false);
    const byPath = Object.fromEntries(r.entries.map((e) => [e.path, e]));
    expect(byPath["a.txt"]).toBeDefined();
    expect(byPath["b.txt"]).toBeDefined();
    expect(byPath["new.txt"]?.kind).toBe("untracked");
  });

  it("status works from a subdirectory and limits to paths", async () => {
    await mkdir(path.join(repo, "sub"));
    const r = await core.git.status(ctx, { cwd: "repo/sub", paths: ["repo/a.txt"] });
    expect(r.entries.map((e) => e.path)).toEqual(["a.txt"]);
  });

  it("diff shows worktree, staged and revision changes", async () => {
    expect((await core.git.diff(ctx, { cwd: "repo" })).output).toContain("+three");
    expect((await core.git.diff(ctx, { cwd: "repo", staged: true })).output).toContain("+bee staged");
    const range = await core.git.diff(ctx, { cwd: "repo", from: "HEAD~1", to: "HEAD", paths: ["repo/a.txt"] });
    expect(range.output).toContain("+two");
    const names = await core.git.diff(ctx, { cwd: "repo", nameOnly: true });
    expect(names.output).toContain("a.txt");
  });

  it("log lists commits", async () => {
    const r = await core.git.log(ctx, { cwd: "repo" });
    expect(r.commits.map((c) => c.subject)).toEqual(["second", "first"]);
    expect((await core.git.log(ctx, { cwd: "repo", maxCount: 1, skip: 1 })).commits.map((c) => c.subject)).toEqual([
      "first",
    ]);
  });

  it("branch lists branches and the current branch", async () => {
    const r = await core.git.branch(ctx, { cwd: "repo" });
    expect(r.current).toBe("main");
    expect(r.detached).toBe(false);
    expect(r.branches.map((b) => b.name).sort()).toEqual(["feature", "main"]);
  });

  it("show returns a commit and a file at a revision", async () => {
    const commit = await core.git.show(ctx, { cwd: "repo", revision: "HEAD" });
    expect(commit.output).toContain("second");
    expect(commit.output).toContain("+two");
    const file = await core.git.show(ctx, { cwd: "repo", revision: "HEAD~1:a.txt" });
    expect(file.output).toBe("one\n");
  });

  it("handles a repository without commits", async () => {
    const empty = path.join(dirs.workspace, "empty");
    await mkdir(empty);
    git(empty, "init", "-q");
    expect((await core.git.log(ctx, { cwd: "empty" })).commits).toEqual([]);
    expect((await core.git.status(ctx, { cwd: "empty" })).entries).toEqual([]);
  });

  it("refuses option-like revisions", async () => {
    await expect(core.git.log(ctx, { cwd: "repo", revision: "--output=x" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(core.git.show(ctx, { cwd: "repo", revision: "-p" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("reports a bad revision as OPERATION_FAILED", async () => {
    await expect(core.git.show(ctx, { cwd: "repo", revision: "no-such-rev" })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
    });
  });

  it("refuses paths outside the worktree", async () => {
    await mkdir(path.join(dirs.workspace, "other"));
    await expect(core.git.status(ctx, { cwd: "repo", paths: ["other"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("denies a repository outside the workspace", async () => {
    const outsideRepo = await makeRepo(path.join(dirs.outside, "repo"));
    await expect(core.git.status(ctx, { cwd: outsideRepo })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("denies when git.read is not granted", async () => {
    const restricted = await createTestCore({
      workspace: { root: dirs.workspace },
      permissions: { capabilities: ["filesystem.read"] },
    });
    try {
      await expect(restricted.git.status(ctx, { cwd: "repo" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(restricted.status().capabilities.find((c) => c.capability === "git.read")?.granted).toBe(false);
    } finally {
      await restricted.shutdown();
    }
  });

  it("denies a workspace nested inside a repository whose Git directory is outside it", async () => {
    const outer = await makeRepo(path.join(dirs.outside, "outer"));
    const inner = path.join(outer, "inner");
    await mkdir(inner);
    const nested = await createTestCore({ workspace: { root: inner } });
    try {
      await expect(nested.git.status(ctx, { cwd: "." })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    } finally {
      await nested.shutdown();
    }
  });

  describe("repository configuration that could run programs", () => {
    const cases: Array<[string, (marker: string) => string[]]> = [
      ["core.fsmonitor", (m) => ["core.fsmonitor", markerCommand(m)]],
      ["diff.external", (m) => ["diff.external", markerCommand(m)]],
      ["core.pager", (m) => ["core.pager", markerCommand(m)]],
      ["filter.x.clean", (m) => ["filter.x.clean", markerCommand(m)]],
      ["alias.st", (m) => ["alias.st", `!${markerCommand(m)}`]],
    ];
    for (const [name, setting] of cases) {
      it(`refuses ${name} with UNSAFE_REPOSITORY and runs nothing`, async () => {
        const marker = path.join(dirs.outside, MARKER);
        git(repo, "config", ...setting(marker));
        for (const op of [
          () => core.git.status(ctx, { cwd: "repo" }),
          () => core.git.diff(ctx, { cwd: "repo" }),
          () => core.git.log(ctx, { cwd: "repo" }),
          () => core.git.branch(ctx, { cwd: "repo" }),
          () => core.git.show(ctx, { cwd: "repo" }),
        ]) {
          await expect(op()).rejects.toMatchObject({ code: "UNSAFE_REPOSITORY" });
        }
        expect(existsSync(marker)).toBe(false);
      });
    }

    it("refuses include of uninspected configuration", async () => {
      const marker = path.join(dirs.outside, MARKER);
      const included = path.join(dirs.outside, "included.cfg");
      await writeFile(included, `[core]\n\tfsmonitor = ${markerCommand(marker).replace(/"/g, '\\"')}\n`);
      git(repo, "config", "include.path", included);
      await expect(core.git.status(ctx, { cwd: "repo" })).rejects.toMatchObject({ code: "UNSAFE_REPOSITORY" });
      expect(existsSync(marker)).toBe(false);
    });

    it("allows ordinary repository settings", async () => {
      git(repo, "config", "core.autocrlf", "false");
      git(repo, "config", "branch.main.remote", "origin");
      await expect(core.git.status(ctx, { cwd: "repo" })).resolves.toBeDefined();
    });
  });

  it("runs git.read and a filesystem write into .git without errors", async () => {
    const [status, write] = await Promise.all([
      core.git.status(ctx, { cwd: "repo" }),
      core.filesystem.writeFile(ctx, { path: "repo/.git/crot-note", content: "x" }),
    ]);
    expect(status.branch.head).toBe("main");
    expect(write.bytesWritten).toBe(1);
  });

  describe.runIf(isWindows)("Windows executable lookup", () => {
    it("never runs a git program planted in the repository", async () => {
      const marker = path.join(dirs.outside, MARKER);
      for (const name of ["git.bat", "git.cmd"]) {
        await writeFile(path.join(repo, name), `@echo off\r\necho x > "${marker}"\r\n`);
      }
      await core.git.status(ctx, { cwd: "repo" });
      expect(existsSync(marker)).toBe(false);
    });
  });
});

describe("git.read in full_control mode", () => {
  let dirs: TempDirs;
  let core: CrotCore;

  beforeEach(async () => {
    dirs = await makeTempDirs();
    core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
  });
  afterEach(async () => {
    // After a failed beforeEach they may be unset: report its error, not a TypeError (both are idempotent).
    await core?.shutdown();
    await dirs?.cleanup();
  });

  it("reads a repository outside the workspace", async () => {
    const repo = await makeRepo(path.join(dirs.outside, "repo"));
    expect((await core.git.status(ctx, { cwd: repo })).branch.head).toBe("main");
    expect((await core.git.log(ctx, { cwd: repo })).commits).toHaveLength(2);
    expect((await core.git.branch(ctx, { cwd: repo })).current).toBe("main");
    expect((await core.git.diff(ctx, { cwd: repo })).output).toContain("+three");
    expect((await core.git.show(ctx, { cwd: repo, revision: "HEAD:a.txt" })).output).toBe("one\ntwo\n");
  });

  it("still refuses unsafe repository configuration", async () => {
    const repo = await makeRepo(path.join(dirs.outside, "repo"));
    const marker = path.join(dirs.outside, MARKER);
    git(repo, "config", "core.fsmonitor", markerCommand(marker));
    await expect(core.git.status(ctx, { cwd: repo })).rejects.toMatchObject({ code: "UNSAFE_REPOSITORY" });
    expect(existsSync(marker)).toBe(false);
  });

  it("denies when git.read is not granted", async () => {
    const repo = await makeRepo(path.join(dirs.outside, "repo"));
    const restricted = await createTestCore({
      workspace: { root: dirs.workspace },
      permissions: { mode: "full_control", capabilities: ["filesystem.read", "filesystem.full"] },
    });
    try {
      await expect(restricted.git.status(ctx, { cwd: repo })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    } finally {
      await restricted.shutdown();
    }
  });
});
