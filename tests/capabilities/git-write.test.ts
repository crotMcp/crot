import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import {
  canSymlinkFiles,
  createTestCore,
  isWindows,
  makeTempDirs,
  testContext as ctx,
  type TempDirs,
} from "../helpers.js";

/**
 * git.write (ARCHITECTURE.md §27, AD-2): add, commit, branch create/rename/delete,
 * checkout of a branch or an explicit detached commit. Every test that expects
 * "nothing ran" also checks a marker file that a hook or configured program would create.
 */

const EMPTY_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "crot-git-write-test-"));
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
  // core.fsmonitor=false: test-side status/ls-files must never run a planted fsmonitor,
  // otherwise the marker checks below would observe the test helper, not CROT.
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" });
}

/**
 * Repository on main with one commit, a merged branch 'merged', an unmerged
 * branch 'topic', a tag, a repository-local identity, one modified and one untracked file.
 */
async function buildRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "config", "user.name", "Repo User");
  git(dir, "config", "user.email", "repo@example.com");
  await writeFile(path.join(dir, "a.txt"), "one\n");
  await writeFile(path.join(dir, "b.txt"), "bee\n");
  await writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  git(dir, "branch", "merged");
  git(dir, "tag", "v1");
  git(dir, "checkout", "-q", "-b", "topic");
  await writeFile(path.join(dir, "topic.txt"), "topic\n");
  git(dir, "add", "topic.txt");
  git(dir, "commit", "-q", "-m", "topic work");
  git(dir, "checkout", "-q", "main");
  await writeFile(path.join(dir, "a.txt"), "one\ntwo\n");
  await writeFile(path.join(dir, "new.txt"), "untracked\n");
  await writeFile(path.join(dir, "ignored.txt"), "ignored\n");
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

const head = (repo: string) => git(repo, "rev-parse", "HEAD").trim();
const commitCount = (repo: string) => Number(git(repo, "rev-list", "--count", "--all").trim());
const branches = (repo: string) =>
  git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").trim().split("\n").sort();

const MARKER = "crot-git-write-marker";

/** A command that would create `marker` if Git ever ran it (used for configured programs). */
function markerCommand(marker: string): string {
  const m = marker.replace(/\\/g, "/");
  return isWindows ? `cmd /c echo x > "${marker}"` : `touch '${m}'`;
}

/** Hooks a git.write operation could trigger; each would create the marker. */
const HOOKS = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "post-checkout",
  "reference-transaction",
  "pre-auto-gc",
  "post-index-change",
];

async function plantHooks(hooksDir: string, marker: string): Promise<void> {
  await mkdir(hooksDir, { recursive: true });
  const m = marker.replace(/\\/g, "/");
  for (const name of HOOKS) {
    const file = path.join(hooksDir, name);
    await writeFile(file, `#!/bin/sh\necho "${name}" >> '${m}'\nexit 0\n`);
    chmodSync(file, 0o755);
  }
}

/** Every git.write operation, each expected to change the repository when allowed. */
function allWriteOperations(core: CrotCore, cwd: string) {
  return [
    () => core.git.add(ctx, { cwd, paths: [path.join(cwd, "a.txt")] }),
    () => core.git.commit(ctx, { cwd, message: "x", allowEmpty: true }),
    () => core.git.branchCreate(ctx, { cwd, name: "created" }),
    () => core.git.branchRename(ctx, { cwd, from: "merged", to: "renamed" }),
    () => core.git.branchDelete(ctx, { cwd, name: "merged" }),
    () => core.git.checkout(ctx, { cwd, branch: "topic" }),
    () => core.git.checkout(ctx, { cwd, detach: "HEAD" }),
  ];
}

describe("git.write in sandbox mode", () => {
  let dirs: TempDirs;
  let core: CrotCore;
  let repo: string;

  beforeEach(async () => {
    dirs = await makeTempDirs();
    repo = await makeRepo(path.join(dirs.workspace, "repo"));
    core = await createTestCore({ workspace: { root: dirs.workspace } });
  });
  afterEach(async () => {
    // After a failed beforeEach they may be unset: report its error, not a TypeError (both are idempotent).
    await core?.shutdown();
    await dirs?.cleanup();
  });

  it("reports git.write as granted and enforced", () => {
    const entry = core.status().capabilities.find((c) => c.capability === "git.write");
    expect(entry).toMatchObject({ granted: true, enforced: true });
  });

  it("add stages the given paths, all=true stages every change including deletions", async () => {
    const r = await core.git.add(ctx, { cwd: "repo", paths: ["repo/a.txt"] });
    expect(r.staged).toEqual(["a.txt"]);
    await core.filesystem.delete(ctx, { path: "repo/b.txt" });
    const all = await core.git.add(ctx, { cwd: "repo", all: true });
    expect(all.staged.sort()).toEqual(["a.txt", "b.txt", "new.txt"]);
    expect(git(repo, "status", "--porcelain")).toContain("D  b.txt");
    expect(git(repo, "status", "--porcelain", "--ignored")).toContain("!! ignored.txt");
  });

  it("add works from a subdirectory with workspace-relative paths", async () => {
    await mkdir(path.join(repo, "sub"));
    await writeFile(path.join(repo, "sub", "c.txt"), "c\n");
    const r = await core.git.add(ctx, { cwd: "repo/sub", paths: ["repo/sub/c.txt"] });
    expect(r.staged).toEqual(["sub/c.txt"]);
  });

  it("add does not stage ignored files (no --force)", async () => {
    await expect(core.git.add(ctx, { cwd: "repo", paths: ["repo/ignored.txt"] })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
    });
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
  });

  it("add refuses paths outside the worktree and inside the Git directory", async () => {
    await mkdir(path.join(dirs.workspace, "other"));
    await writeFile(path.join(dirs.workspace, "other", "x.txt"), "x");
    await expect(core.git.add(ctx, { cwd: "repo", paths: ["other/x.txt"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(core.git.add(ctx, { cwd: "repo", paths: ["repo/.git/config"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(core.git.add(ctx, { cwd: "repo", paths: ["repo/.git"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
  });

  it("add refuses a path outside the workspace (outside the work tree, as in git.read)", async () => {
    await writeFile(path.join(dirs.outside, "x.txt"), "x");
    await expect(core.git.add(ctx, { cwd: "repo", paths: [path.join(dirs.outside, "x.txt")] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
  });

  it("add stages a symlink pointing outside the workspace as a link, never its target", async (t) => {
    if (!(await canSymlinkFiles())) t.skip();
    await writeFile(path.join(dirs.outside, "secret.txt"), "secret\n");
    await symlink(path.join(dirs.outside, "secret.txt"), path.join(repo, "link.txt"), "file");
    const r = await core.git.add(ctx, { cwd: "repo", paths: ["repo/link.txt"] });
    expect(r.staged).toEqual(["link.txt"]);
    const mode = git(repo, "ls-files", "-s", "link.txt");
    expect(mode.startsWith("120000")).toBe(true);
    // The blob is the link target path, never the target's content. Git for Windows reads link
    // targets with forward slashes (compat/mingw.c: read_reparse_point -> normalize_ntpath).
    const target = path.join(dirs.outside, "secret.txt").split(path.sep).join("/");
    expect(git(repo, "cat-file", "-p", ":link.txt")).toBe(target);
  });

  it("commit records the staged changes with the repository identity", async () => {
    await core.git.add(ctx, { cwd: "repo", paths: ["repo/a.txt"] });
    const r = await core.git.commit(ctx, { cwd: "repo", message: "second\n\nbody text" });
    expect(r.branch).toBe("main");
    expect(r.commit).toBe(head(repo));
    expect(git(repo, "log", "-1", "--format=%s|%b|%an <%ae>").trim()).toBe(
      "second|body text\n|Repo User <repo@example.com>".trim(),
    );
  });

  it("commit treats an option-like message as text and never amends", async () => {
    const before = head(repo);
    await core.git.commit(ctx, { cwd: "repo", message: "--amend", allowEmpty: true });
    expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("--amend");
    expect(git(repo, "rev-parse", "HEAD~1").trim()).toBe(before);
    for (const message of ["--no-verify", "-a", "--allow-empty-message", "-S"]) {
      await core.git.commit(ctx, { cwd: "repo", message, allowEmpty: true });
      expect(git(repo, "log", "-1", "--format=%s").trim()).toBe(message);
    }
    // Option-like messages never staged the modified file (-a was text).
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
  });

  it("commit fails when nothing is staged unless allowEmpty", async () => {
    const before = head(repo);
    await expect(core.git.commit(ctx, { cwd: "repo", message: "nothing" })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
    });
    expect(head(repo)).toBe(before);
  });

  it("commit fails without an identity instead of guessing one", async () => {
    git(repo, "config", "--unset", "user.name");
    git(repo, "config", "--unset", "user.email");
    // git.write forwards user.name/user.email from the user's global configuration (AD-2; tested
    // below), so a developer's own identity would make this commit succeed. This Core gets a home
    // without any global configuration: no identity is available to it at all.
    const home = path.join(dirs.outside, "home-without-identity");
    await mkdir(home);
    const savedHome = process.env.HOME;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    let isolated: CrotCore | undefined;
    try {
      isolated = await createTestCore({ workspace: { root: dirs.workspace } });
      const before = head(repo);
      await expect(isolated.git.commit(ctx, { cwd: "repo", message: "who", allowEmpty: true })).rejects.toMatchObject({
        code: "OPERATION_FAILED",
      });
      expect(head(repo)).toBe(before);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      await isolated?.shutdown();
    }
  });

  it("commit is never signed, even when the repository asks for it", async () => {
    git(repo, "config", "commit.gpgsign", "true");
    git(repo, "config", "user.signingkey", "DEADBEEF");
    await core.git.commit(ctx, { cwd: "repo", message: "unsigned", allowEmpty: true });
    expect(git(repo, "cat-file", "commit", "HEAD")).not.toContain("gpgsig");
  });

  it("creates, renames and deletes branches", async () => {
    const created = await core.git.branchCreate(ctx, { cwd: "repo", name: "feature/x", startPoint: "topic" });
    expect(created.commit).toBe(git(repo, "rev-parse", "topic").trim());
    expect(git(repo, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/main");
    const renamed = await core.git.branchRename(ctx, { cwd: "repo", from: "feature/x", to: "feature/y" });
    expect(renamed).toMatchObject({ branch: "feature/y", renamedFrom: "feature/x" });
    const deleted = await core.git.branchDelete(ctx, { cwd: "repo", name: "merged" });
    expect(deleted.branch).toBe("merged");
    expect(branches(repo)).toEqual(["feature/y", "main", "topic"]);
  });

  it("branch create sets no upstream and refuses an existing name (no force)", async () => {
    await core.git.branchCreate(ctx, { cwd: "repo", name: "t2", startPoint: "topic" });
    expect(() => git(repo, "config", "branch.t2.merge")).toThrow();
    const before = git(repo, "rev-parse", "merged").trim();
    await expect(
      core.git.branchCreate(ctx, { cwd: "repo", name: "merged", startPoint: "topic" }),
    ).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    expect(git(repo, "rev-parse", "merged").trim()).toBe(before);
  });

  it("branch rename refuses an existing target (no -M)", async () => {
    await expect(core.git.branchRename(ctx, { cwd: "repo", from: "merged", to: "topic" })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
    });
    expect(branches(repo)).toEqual(["main", "merged", "topic"]);
    await expect(core.git.branchRename(ctx, { cwd: "repo", from: "missing", to: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("branch delete refuses an unmerged branch and the current branch (no -D)", async () => {
    await expect(core.git.branchDelete(ctx, { cwd: "repo", name: "topic" })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
    });
    await expect(core.git.branchDelete(ctx, { cwd: "repo", name: "main" })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
    });
    await expect(core.git.branchDelete(ctx, { cwd: "repo", name: "v1" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(branches(repo)).toEqual(["main", "merged", "topic"]);
  });

  it("checkout switches branches and detaches only when asked explicitly", async () => {
    // Exact bytes are checked, so the line-ending configuration is fixed here: Git for Windows
    // sets core.autocrlf=true in its system configuration, which git.write applies like Git does
    // (covered by "applies the line-ending configuration like Git" below).
    git(repo, "config", "core.autocrlf", "false");
    const r = await core.git.checkout(ctx, { cwd: "repo", branch: "topic" });
    expect(r).toMatchObject({ branch: "topic", detached: false });
    expect(await readFile(path.join(repo, "topic.txt"), "utf8")).toBe("topic\n");
    const d = await core.git.checkout(ctx, { cwd: "repo", detach: "v1" });
    expect(d).toMatchObject({ branch: null, detached: true, commit: git(repo, "rev-parse", "v1^{commit}").trim() });
    // A tag or a commit is not a branch: without 'detach' nothing is checked out.
    await expect(core.git.checkout(ctx, { cwd: "repo", branch: "v1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(core.git.checkout(ctx, { cwd: "repo", branch: head(repo) })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("applies the line-ending configuration like Git (core.autocrlf, .gitattributes)", async () => {
    // Repository configuration wins over any system/global value of the host.
    git(repo, "config", "core.autocrlf", "true");
    await core.git.checkout(ctx, { cwd: "repo", branch: "topic" });
    expect(await readFile(path.join(repo, "topic.txt"), "utf8")).toBe("topic\r\n");
    await writeFile(path.join(repo, "crlf.txt"), "x\r\ny\r\n");
    await core.git.add(ctx, { cwd: "repo", paths: ["repo/crlf.txt"] });
    // The index stores the normalized text, as plain Git with the same configuration does.
    expect(git(repo, "cat-file", "-p", ":crlf.txt")).toBe("x\ny\n");
    await core.git.checkout(ctx, { cwd: "repo", branch: "main" });
    // An eol attribute overrides core.autocrlf for its paths.
    await writeFile(path.join(repo, ".gitattributes"), "topic.txt eol=lf\n");
    await core.git.checkout(ctx, { cwd: "repo", branch: "topic" });
    expect(await readFile(path.join(repo, "topic.txt"), "utf8")).toBe("topic\n");
  });

  it("checkout never checks out individual paths", async () => {
    // 'a.txt' is a modified file, not a branch: a path checkout would discard the change.
    await expect(core.git.checkout(ctx, { cwd: "repo", branch: "a.txt" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(core.git.checkout(ctx, { cwd: "repo", detach: "a.txt" })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
    });
    expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("checkout refuses to overwrite local changes (no force)", async () => {
    await writeFile(path.join(repo, "topic.txt"), "local, untracked\n");
    await expect(core.git.checkout(ctx, { cwd: "repo", branch: "topic" })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
    });
    expect(await readFile(path.join(repo, "topic.txt"), "utf8")).toBe("local, untracked\n");
    expect(git(repo, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/main");
  });

  it("checkout never creates a branch from a remote-tracking branch", async () => {
    git(repo, "update-ref", "refs/remotes/origin/remote-only", "HEAD");
    await expect(core.git.checkout(ctx, { cwd: "repo", branch: "remote-only" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(branches(repo)).toEqual(["main", "merged", "topic"]);
  });

  describe("input validation (no option injection, no forbidden forms)", () => {
    const invalid: Array<[string, () => Promise<unknown>]> = [
      ["branch name -D", () => core.git.branchDelete(ctx, { cwd: "repo", name: "-D" })],
      ["branch name --force", () => core.git.branchCreate(ctx, { cwd: "repo", name: "--force" })],
      ["branch name @{-1}", () => core.git.checkout(ctx, { cwd: "repo", branch: "@{-1}" })],
      ["branch name -", () => core.git.checkout(ctx, { cwd: "repo", branch: "-" })],
      ["branch name HEAD", () => core.git.branchCreate(ctx, { cwd: "repo", name: "HEAD" })],
      ["branch name with newline", () => core.git.branchCreate(ctx, { cwd: "repo", name: "a\nb" })],
      ["rename target -M", () => core.git.branchRename(ctx, { cwd: "repo", from: "merged", to: "-M" })],
      ["start point option", () => core.git.branchCreate(ctx, { cwd: "repo", name: "x", startPoint: "--force" })],
      ["detach option", () => core.git.checkout(ctx, { cwd: "repo", detach: "--force" })],
      ["checkout branch and detach", () => core.git.checkout(ctx, { cwd: "repo", branch: "topic", detach: "HEAD" })],
      ["checkout without target", () => core.git.checkout(ctx, { cwd: "repo" })],
      ["checkout of paths", () => core.git.checkout(ctx, { cwd: "repo", paths: ["a.txt"] } as never)],
      ["checkout with force", () => core.git.checkout(ctx, { cwd: "repo", branch: "topic", force: true } as never)],
      ["commit with amend", () => core.git.commit(ctx, { cwd: "repo", message: "m", amend: true } as never)],
      ["commit with NUL", () => core.git.commit(ctx, { cwd: "repo", message: "a\0b" })],
      ["commit with blank message", () => core.git.commit(ctx, { cwd: "repo", message: "  \n" })],
      ["delete with force", () => core.git.branchDelete(ctx, { cwd: "repo", name: "topic", force: true } as never)],
      ["add with force", () => core.git.add(ctx, { cwd: "repo", all: true, force: true } as never)],
      ["add without paths", () => core.git.add(ctx, { cwd: "repo" })],
      ["add paths and all", () => core.git.add(ctx, { cwd: "repo", all: true, paths: ["repo/a.txt"] })],
    ];
    for (const [name, op] of invalid) {
      it(`refuses ${name} with INVALID_INPUT`, async () => {
        const before = { head: head(repo), branches: branches(repo), count: commitCount(repo) };
        await expect(op()).rejects.toMatchObject({ code: "INVALID_INPUT" });
        expect({ head: head(repo), branches: branches(repo), count: commitCount(repo) }).toEqual(before);
      });
    }
  });

  it.runIf(!isWindows)("never runs repository hooks (control: plain Git runs them)", async () => {
    const marker = path.join(dirs.outside, MARKER);
    await plantHooks(path.join(repo, ".git", "hooks"), marker);
    // Control: the planted hooks are real and run under plain Git.
    git(repo, "commit", "-q", "--allow-empty", "-m", "control");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    await core.git.add(ctx, { cwd: "repo", paths: ["repo/a.txt"] });
    await core.git.commit(ctx, { cwd: "repo", message: "no hooks" });
    await core.git.branchCreate(ctx, { cwd: "repo", name: "h" });
    await core.git.branchRename(ctx, { cwd: "repo", from: "h", to: "h2" });
    await core.git.branchDelete(ctx, { cwd: "repo", name: "h2" });
    await core.git.checkout(ctx, { cwd: "repo", branch: "topic" });
    await core.git.checkout(ctx, { cwd: "repo", detach: "main" });
    expect(existsSync(marker)).toBe(false);
  });

  describe("repository configuration that could run programs", () => {
    const cases: Array<[string, (marker: string, hooks: string) => string[]]> = [
      ["core.hooksPath", (_m, hooks) => ["core.hooksPath", hooks]],
      ["core.fsmonitor", (m) => ["core.fsmonitor", markerCommand(m)]],
      ["core.editor", (m) => ["core.editor", markerCommand(m)]],
      ["filter.x.clean", (m) => ["filter.x.clean", markerCommand(m)]],
      ["filter.x.smudge", (m) => ["filter.x.smudge", markerCommand(m)]],
      ["gpg.program", (m) => ["gpg.program", markerCommand(m)]],
      ["core.sshCommand", (m) => ["core.sshCommand", markerCommand(m)]],
      ["alias.ci", (m) => ["alias.ci", `!${markerCommand(m)}`]],
    ];
    for (const [name, setting] of cases) {
      it(`refuses ${name} with UNSAFE_REPOSITORY for every operation and changes nothing`, async () => {
        const marker = path.join(dirs.outside, MARKER);
        const hooks = path.join(dirs.outside, "hooks");
        await plantHooks(hooks, marker);
        await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=x\n");
        git(repo, "config", ...setting(marker, hooks));
        const before = { head: head(repo), branches: branches(repo), index: git(repo, "ls-files", "-s") };
        for (const op of allWriteOperations(core, "repo")) {
          await expect(op()).rejects.toMatchObject({ code: "UNSAFE_REPOSITORY" });
        }
        expect({ head: head(repo), branches: branches(repo), index: git(repo, "ls-files", "-s") }).toEqual(before);
        expect(existsSync(marker)).toBe(false);
      });
    }

    it("refuses include of uninspected configuration", async () => {
      const marker = path.join(dirs.outside, MARKER);
      const hooks = path.join(dirs.outside, "hooks");
      await plantHooks(hooks, marker);
      const included = path.join(dirs.outside, "included.cfg");
      await writeFile(included, `[core]\n\thooksPath = ${hooks.replace(/\\/g, "/")}\n`);
      git(repo, "config", "include.path", included);
      for (const op of allWriteOperations(core, "repo")) {
        await expect(op()).rejects.toMatchObject({ code: "UNSAFE_REPOSITORY" });
      }
      expect(existsSync(marker)).toBe(false);
    });

    it("runs no filter named only in .gitattributes", async () => {
      await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=lfs diff=lfs merge=lfs\n");
      await core.git.add(ctx, { cwd: "repo", all: true });
      await core.git.commit(ctx, { cwd: "repo", message: "attrs" });
      expect(git(repo, "cat-file", "-p", "HEAD:a.txt")).toBe("one\ntwo\n");
    });
  });

  it("denies a repository outside the workspace and changes nothing", async () => {
    const outsideRepo = await makeRepo(path.join(dirs.outside, "repo"));
    const before = { head: head(outsideRepo), branches: branches(outsideRepo) };
    for (const op of allWriteOperations(core, outsideRepo)) {
      await expect(op()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
    expect({ head: head(outsideRepo), branches: branches(outsideRepo) }).toEqual(before);
  });

  it("denies a .git file that points outside the workspace", async () => {
    const outsideRepo = await makeRepo(path.join(dirs.outside, "real"));
    const linked = path.join(dirs.workspace, "linked");
    await mkdir(linked);
    await writeFile(path.join(linked, ".git"), `gitdir: ${path.join(outsideRepo, ".git")}\n`);
    for (const op of allWriteOperations(core, "linked")) {
      await expect(op()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
    expect(branches(outsideRepo)).toEqual(["main", "merged", "topic"]);
  });

  it("denies a linked worktree whose common directory is outside the workspace", async () => {
    const outsideRepo = await makeRepo(path.join(dirs.outside, "main-repo"));
    const wt = path.join(dirs.workspace, "wt");
    git(outsideRepo, "worktree", "add", "-q", wt, "merged");
    for (const op of allWriteOperations(core, "wt")) {
      await expect(op()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
    expect(branches(outsideRepo)).toEqual(["main", "merged", "topic"]);
  });

  it("denies a workspace nested inside a repository whose Git directory is outside it", async () => {
    const outer = await makeRepo(path.join(dirs.outside, "outer"));
    const inner = path.join(outer, "inner");
    await mkdir(inner);
    const nested = await createTestCore({ workspace: { root: inner } });
    try {
      for (const op of allWriteOperations(nested, ".")) {
        await expect(op()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      }
    } finally {
      await nested.shutdown();
    }
  });

  it("denies when git.write is not granted; git.read keeps working", async () => {
    const restricted = await createTestCore({
      workspace: { root: dirs.workspace },
      permissions: { capabilities: ["filesystem.read", "git.read"] },
    });
    try {
      const before = { head: head(repo), branches: branches(repo) };
      for (const op of allWriteOperations(restricted, "repo")) {
        await expect(op()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      }
      expect({ head: head(repo), branches: branches(repo) }).toEqual(before);
      expect((await restricted.git.status(ctx, { cwd: "repo" })).branch.head).toBe("main");
      expect(restricted.status().capabilities.find((c) => c.capability === "git.write")?.granted).toBe(false);
    } finally {
      await restricted.shutdown();
    }
  });

  it("git.write does not require git.read and does not grant it", async () => {
    const writeOnly = await createTestCore({
      workspace: { root: dirs.workspace },
      permissions: { capabilities: ["git.write"] },
    });
    try {
      await writeOnly.git.add(ctx, { cwd: "repo", paths: ["repo/a.txt"] });
      await writeOnly.git.commit(ctx, { cwd: "repo", message: "write only" });
      expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("write only");
      await expect(writeOnly.git.status(ctx, { cwd: "repo" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(writeOnly.git.log(ctx, { cwd: "repo" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    } finally {
      await writeOnly.shutdown();
    }
  });

  it("denies git.write in a repository that contains a CROT protected path; git.read is not affected", async () => {
    const auditFile = path.join(repo, ".crot", "audit.jsonl");
    await mkdir(path.dirname(auditFile), { recursive: true });
    await writeFile(auditFile, "");
    const guarded = await createTestCore({ workspace: { root: dirs.workspace } }, undefined, {
      protectedPaths: [auditFile],
    });
    try {
      const before = { head: head(repo), branches: branches(repo) };
      for (const op of allWriteOperations(guarded, "repo")) {
        await expect(op()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      }
      expect({ head: head(repo), branches: branches(repo) }).toEqual(before);
      expect((await guarded.git.status(ctx, { cwd: "repo" })).branch.head).toBe("main");
    } finally {
      await guarded.shutdown();
    }
  });

  it("audits success, denial and failure without the commit message", async () => {
    const audit = new MemoryAuditSink();
    const audited = await createTestCore({ workspace: { root: dirs.workspace } }, audit);
    const restricted = await createTestCore(
      { workspace: { root: dirs.workspace }, permissions: { capabilities: ["git.read"] } },
      audit,
    );
    try {
      await audited.git.add(ctx, { cwd: "repo", paths: ["repo/a.txt"] });
      await audited.git.commit(ctx, { cwd: "repo", message: "secret-token-in-message" });
      await expect(audited.git.branchDelete(ctx, { cwd: "repo", name: "topic" })).rejects.toBeDefined();
      await expect(restricted.git.checkout(ctx, { cwd: "repo", branch: "topic" })).rejects.toBeDefined();
    } finally {
      await audited.shutdown();
      await restricted.shutdown();
    }
    const summary = audit.events.map((e) => [e.operation, e.outcome, e.capabilities]);
    expect(summary).toEqual([
      ["git.add", "success", ["git.write"]],
      ["git.commit", "success", ["git.write"]],
      ["git.branch_delete", "error", ["git.write"]],
      ["git.checkout", "denied", ["git.write"]],
    ]);
    const commit = audit.events[1]!;
    expect(commit.details).toMatchObject({ messageLength: "secret-token-in-message".length });
    expect(JSON.stringify(audit.events)).not.toContain("secret-token-in-message");
    expect(commit.paths).toEqual(expect.arrayContaining([repo, path.join(repo, ".git")]));
  });

  it("serializes git.write with a filesystem write into .git", async () => {
    await core.git.add(ctx, { cwd: "repo", paths: ["repo/a.txt"] });
    const [commit, write, branch] = await Promise.all([
      core.git.commit(ctx, { cwd: "repo", message: "concurrent" }),
      core.filesystem.writeFile(ctx, { path: "repo/.git/crot-note", content: "x" }),
      core.git.branchCreate(ctx, { cwd: "repo", name: "concurrent" }),
    ]);
    expect(commit.branch).toBe("main");
    expect(write.bytesWritten).toBe(1);
    expect(branch.branch).toBe("concurrent");
  });

  it("runs git.read and git.write on the same repository concurrently without errors", async () => {
    const results = await Promise.all([
      core.git.status(ctx, { cwd: "repo" }),
      core.git.branchCreate(ctx, { cwd: "repo", name: "c1" }),
      core.git.log(ctx, { cwd: "repo" }),
      core.git.branchCreate(ctx, { cwd: "repo", name: "c2" }),
    ]);
    expect(results).toHaveLength(4);
    expect(branches(repo)).toEqual(["c1", "c2", "main", "merged", "topic"]);
  });

  describe.runIf(!isWindows)("PATH-only Git lookup", () => {
    it("never runs a git program planted in the repository or reachable through a relative PATH entry", async () => {
      const marker = path.join(dirs.outside, MARKER);
      const fake = path.join(repo, "git");
      await writeFile(fake, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
      chmodSync(fake, 0o755);
      const savedPath = process.env.PATH;
      process.env.PATH = `.:${savedPath ?? ""}`;
      let planted: CrotCore | undefined;
      try {
        planted = await createTestCore({ workspace: { root: dirs.workspace } });
        await planted.git.add(ctx, { cwd: "repo", paths: ["repo/a.txt"] });
        await planted.git.commit(ctx, { cwd: "repo", message: "real git" });
        await planted.git.checkout(ctx, { cwd: "repo", branch: "topic" });
      } finally {
        process.env.PATH = savedPath;
        await planted?.shutdown();
      }
      expect(existsSync(marker)).toBe(false);
      expect(git(repo, "log", "-1", "--format=%s", "main").trim()).toBe("real git");
    });
  });

  describe.runIf(isWindows)("Windows executable lookup", () => {
    it("never runs a git program planted in the repository", async () => {
      const marker = path.join(dirs.outside, MARKER);
      for (const name of ["git.bat", "git.cmd", "git.exe.bat"]) {
        await writeFile(path.join(repo, name), `@echo off\r\necho x > "${marker}"\r\n`);
      }
      await core.git.add(ctx, { cwd: "repo", paths: ["repo/a.txt"] });
      await core.git.commit(ctx, { cwd: "repo", message: "real git" });
      expect(existsSync(marker)).toBe(false);
    });
  });
});

describe.runIf(!isWindows)("git.write and the user's global configuration", () => {
  let dirs: TempDirs;
  let savedHome: string | undefined;
  let savedXdg: string | undefined;

  beforeEach(async () => {
    dirs = await makeTempDirs();
    savedHome = process.env.HOME;
    savedXdg = process.env.XDG_CONFIG_HOME;
  });
  afterEach(async () => {
    process.env.HOME = savedHome;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    await dirs.cleanup();
  });

  it("applies a global core.autocrlf exactly like plain Git with the same configuration", async () => {
    const repo = await makeRepo(path.join(dirs.workspace, "repo"));
    const home = path.join(dirs.outside, "home");
    await mkdir(home);
    await writeFile(path.join(home, ".gitconfig"), "[core]\n\tautocrlf = true\n");
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    const userGit = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, env: { ...GIT_ENV, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") } });
    const core = await createTestCore({ workspace: { root: dirs.workspace } });
    try {
      await core.git.checkout(ctx, { cwd: "repo", branch: "topic" });
      const viaCrot = await readFile(path.join(repo, "topic.txt"), "utf8");
      userGit("switch", "-q", "main");
      userGit("switch", "-q", "topic");
      expect(viaCrot).toBe("topic\r\n");
      expect(await readFile(path.join(repo, "topic.txt"), "utf8")).toBe(viaCrot);
      // A repository-local value wins over the global one.
      userGit("switch", "-q", "main");
      git(repo, "config", "core.autocrlf", "false");
      await core.git.checkout(ctx, { cwd: "repo", branch: "topic" });
      expect(await readFile(path.join(repo, "topic.txt"), "utf8")).toBe("topic\n");
    } finally {
      await core.shutdown();
    }
  });

  it("uses only user.name/user.email from it; global hooks, editors and signing are never applied", async () => {
    const repo = await makeRepo(path.join(dirs.workspace, "repo"));
    git(repo, "config", "--unset", "user.name");
    git(repo, "config", "--unset", "user.email");
    const home = path.join(dirs.outside, "home");
    const marker = path.join(dirs.outside, MARKER);
    const hooks = path.join(dirs.outside, "global-hooks");
    await plantHooks(hooks, marker);
    await mkdir(home);
    await writeFile(
      path.join(home, ".gitconfig"),
      [
        "[user]",
        "\tname = Global User",
        "\temail = global@example.com",
        "[core]",
        `\thooksPath = ${hooks}`,
        `\teditor = ${markerCommand(marker)}`,
        `\tfsmonitor = ${markerCommand(marker)}`,
        "[commit]",
        "\tgpgsign = true",
        "[gpg]",
        `\tprogram = ${markerCommand(marker)}`,
        "",
      ].join("\n"),
    );
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    const core = await createTestCore({ workspace: { root: dirs.workspace } });
    try {
      await core.git.add(ctx, { cwd: "repo", paths: ["repo/a.txt"] });
      await core.git.commit(ctx, { cwd: "repo", message: "global identity" });
      await core.git.checkout(ctx, { cwd: "repo", branch: "topic" });
    } finally {
      await core.shutdown();
    }
    expect(git(repo, "log", "-1", "--format=%an <%ae>", "main").trim()).toBe("Global User <global@example.com>");
    expect(git(repo, "cat-file", "commit", "main")).not.toContain("gpgsig");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("git.write in full_control mode", () => {
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

  it("writes to a repository outside the workspace", async () => {
    const repo = await makeRepo(path.join(dirs.outside, "repo"));
    expect((await core.git.add(ctx, { cwd: repo, paths: [path.join(repo, "a.txt")] })).staged).toEqual(["a.txt"]);
    const c = await core.git.commit(ctx, { cwd: repo, message: "outside" });
    expect(c.commit).toBe(head(repo));
    await core.git.branchCreate(ctx, { cwd: repo, name: "n1" });
    await core.git.branchRename(ctx, { cwd: repo, from: "n1", to: "n2" });
    await core.git.branchDelete(ctx, { cwd: repo, name: "merged" });
    expect((await core.git.checkout(ctx, { cwd: repo, branch: "n2" })).branch).toBe("n2");
    expect((await core.git.checkout(ctx, { cwd: repo, detach: "topic" })).detached).toBe(true);
    expect(branches(repo)).toEqual(["main", "n2", "topic"]);
  });

  it.runIf(!isWindows)("still never runs repository hooks", async () => {
    const repo = await makeRepo(path.join(dirs.outside, "repo"));
    const marker = path.join(dirs.outside, MARKER);
    await plantHooks(path.join(repo, ".git", "hooks"), marker);
    await core.git.add(ctx, { cwd: repo, all: true });
    await core.git.commit(ctx, { cwd: repo, message: "no hooks" });
    await core.git.checkout(ctx, { cwd: repo, branch: "topic" });
    expect(existsSync(marker)).toBe(false);
  });

  it("still refuses unsafe repository configuration", async () => {
    const repo = await makeRepo(path.join(dirs.outside, "repo"));
    const marker = path.join(dirs.outside, MARKER);
    const hooks = path.join(dirs.outside, "hooks");
    await plantHooks(hooks, marker);
    git(repo, "config", "core.hooksPath", hooks);
    for (const op of allWriteOperations(core, repo)) {
      await expect(op()).rejects.toMatchObject({ code: "UNSAFE_REPOSITORY" });
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("still refuses forbidden forms (amend, force, -D, path checkout)", async () => {
    const repo = await makeRepo(path.join(dirs.outside, "repo"));
    for (const op of [
      () => core.git.commit(ctx, { cwd: repo, message: "m", amend: true } as never),
      () => core.git.branchDelete(ctx, { cwd: repo, name: "topic", force: true } as never),
      () => core.git.branchDelete(ctx, { cwd: repo, name: "-D" }),
      () => core.git.checkout(ctx, { cwd: repo, branch: "topic", force: true } as never),
      () => core.git.checkout(ctx, { cwd: repo, paths: ["a.txt"] } as never),
    ]) {
      await expect(op()).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await expect(core.git.branchDelete(ctx, { cwd: repo, name: "topic" })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
    });
    expect(branches(repo)).toEqual(["main", "merged", "topic"]);
  });

  it("denies when git.write is not granted", async () => {
    const repo = await makeRepo(path.join(dirs.outside, "repo"));
    const restricted = await createTestCore({
      workspace: { root: dirs.workspace },
      permissions: { mode: "full_control", capabilities: ["filesystem.read", "filesystem.full", "git.read"] },
    });
    try {
      for (const op of allWriteOperations(restricted, repo)) {
        await expect(op()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      }
      expect(branches(repo)).toEqual(["main", "merged", "topic"]);
    } finally {
      await restricted.shutdown();
    }
  });

  it("denies a repository outside the workspace when filesystem.full is not granted", async () => {
    const repo = await makeRepo(path.join(dirs.outside, "repo"));
    const restricted = await createTestCore({
      workspace: { root: dirs.workspace },
      permissions: { mode: "full_control", capabilities: ["git.write"] },
    });
    try {
      for (const op of allWriteOperations(restricted, repo)) {
        await expect(op()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      }
    } finally {
      await restricted.shutdown();
    }
  });
});
