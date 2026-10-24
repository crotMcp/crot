import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import {
  canonicalPath,
  sbplString,
  seatbeltProfile,
  projectSecretRule,
} from "../../../src/native-host/macos-l1/profile.js";

describe("macOS Seatbelt profile compiler", () => {
  it.runIf(process.platform !== "win32")("canonicalizes existing POSIX aliases and absent leaves", () => {
    expect(canonicalPath(path.join(os.tmpdir(), "missing-crot-leaf", "file"))).toBe(
      path.join(realpathSync(os.tmpdir()), "missing-crot-leaf", "file"),
    );
  });
  it("rejects Windows paths instead of accepting them as Darwin policy paths", () => {
    expect(() => canonicalPath("C:\\Users\\owner\\workspace")).toThrow("invalid policy path");
    expect(() => canonicalPath("\\\\host\\share")).toThrow("invalid policy path");
  });
  it("escapes Scheme literals, rejects controls, never interpolates raw policy", () => {
    expect(sbplString('a"b\\c')).toBe('"a\\"b\\\\c"');
    for (const p of ["relative", "/tmp/a\n(allow default)", "/tmp/\0x"]) expect(() => canonicalPath(p)).toThrow();
    expect(() => sbplString("a\nb")).toThrow();
  });
  it("denies by default, confines writes, keychain IPC and process-group escape", () => {
    const p = seatbeltProfile({
      writable: ["/workspace", "/private/home"],
      protectedPaths: ["/protected", "/Keychains"],
      dockerSocket: "/private/d.sock",
      network: "off",
    });
    expect(p).toContain("(deny default)");
    expect(p).toContain('(deny file-read* file-write* (subpath "/protected")');
    expect(p).toContain("(syscall-number 82) (syscall-number 147)");
    expect(p).not.toContain("(allow mach-lookup)");
    expect(p).not.toContain("securityd");
    expect(p).not.toContain("(allow network*)");
    expect(p).toContain('(remote unix-socket (literal "/private/d.sock"))');
    expect(p).toContain("localhost:*");
  });
  it.runIf(process.platform !== "win32")(
    "anchors secret rules and escapes project names without recursive grants",
    () => {
      const root = canonicalPath(path.join(os.tmpdir(), "crot-[project]+(x)"));
      const rule = projectSecretRule({ root, allowedPaths: [root + "/.env"] });
      expect(rule).toContain("(require-not (literal " + sbplString(root + "/.env") + "))");
      expect(rule).toContain(sbplString("crot-\\[project\\]\\+\\(x\\)").slice(1, -1));
      expect(rule).toContain("(syscall-number 9) (syscall-number 471)");
      expect(rule).not.toContain("(subpath ");
      expect(() => projectSecretRule({ root, allowedPaths: [root + "-sibling/.env"] })).toThrow("outside workspace");
      expect(() => projectSecretRule({ root, allowedPaths: [root] })).toThrow("outside workspace");
      expect(projectSecretRule({ root: "/", allowedPaths: [] })).toContain("^/([^/]+/)*");
    },
  );
});
