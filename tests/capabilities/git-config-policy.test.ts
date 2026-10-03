import { describe, expect, it } from "vitest";
import {
  isAllowedRepositoryKey,
  parseConfigList,
  reviewConfig,
} from "../../src/core/capabilities/git/config-policy.js";

describe("git config policy", () => {
  it("parses --null --show-scope output", () => {
    const out = "local\0core.bare\nfalse\0local\0core.flag\0global\0user.name\nA B\0";
    expect(parseConfigList(out)).toEqual([
      { scope: "local", key: "core.bare", value: "false" },
      { scope: "local", key: "core.flag", value: null },
      { scope: "global", key: "user.name", value: "A B" },
    ]);
  });

  it("allows data-only repository keys", () => {
    for (const key of ["core.repositoryformatversion", "core.bare", "core.autocrlf", "branch.main.remote"]) {
      expect(isAllowedRepositoryKey(key)).toBe(true);
    }
  });

  it("refuses keys that can run programs and unknown keys", () => {
    for (const key of [
      "core.fsmonitor",
      "core.pager",
      "core.sshCommand",
      "core.hooksPath",
      "diff.external",
      "diff.x.textconv",
      "filter.lfs.clean",
      "alias.st",
      "include.path",
      "includeIf.gitdir:/x.path",
      "pager.log",
      "gpg.program",
      "credential.helper",
      "something.unknown",
    ]) {
      expect(isAllowedRepositoryKey(key), key).toBe(false);
    }
  });

  it("reports unsafe keys from every non-inherited scope", () => {
    const review = reviewConfig([
      { scope: "local", key: "core.bare", value: "false" },
      { scope: "local", key: "core.fsmonitor", value: "x" },
      { scope: "worktree", key: "diff.external", value: "y" },
      { scope: "command", key: "core.pager", value: "z" },
      { scope: "local", key: "core.fsmonitor", value: "again" },
    ]);
    expect(review.unsafeKeys).toEqual(["core.fsmonitor", "diff.external", "core.pager"]);
  });

  it("ignores system and global keys except forwarded ones", () => {
    const review = reviewConfig([
      { scope: "global", key: "core.fsmonitor", value: "x" },
      { scope: "system", key: "core.pager", value: "less" },
    ]);
    expect(review.unsafeKeys).toEqual([]);
    expect(review.forwarded.some((f) => f.startsWith("core.fsmonitor") || f.startsWith("core.pager"))).toBe(false);
  });
});
