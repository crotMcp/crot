import { describe, expect, it } from "vitest";
import {
  MAX_PROBE_WRITE,
  parseWorkspaceProbeRequest,
  probeRelativePath,
} from "../../../src/native-host/windows-l1/workspace-probe.js";

describe("Windows research workspace capability: strict request grammar", () => {
  it("accepts bounded Unicode names and only the four filesystem verbs", () => {
    expect(probeRelativePath("проект/данные 😀.txt")).toEqual(["проект", "данные 😀.txt"]);
    for (const request of [
      { op: "create", path: "a", text: "Привет 😀" },
      { op: "write", path: "a", text: "" },
      { op: "rename", path: "a", destination: "dir/b" },
      { op: "remove", path: "dir/b" },
    ])
      expect(parseWorkspaceProbeRequest(request)).toEqual(request);
  });
  it.each([
    "",
    ".",
    "..",
    "../outside",
    "dir/../outside",
    "/absolute",
    "//host/share/a",
    "C:/outside",
    "C:relative",
    "\\\\?\\C:\\file",
    "a\\b",
    "a:stream",
    "NUL",
    "con.txt",
    "COM¹.log",
    "LPT9",
    "conout$",
    "short~1/file",
    "a.",
    "a ",
    "dir//file",
    "a\0b",
    "a\nb",
    "*",
    "x".repeat(256),
    Array(34).fill("a").join("/"),
  ])("rejects ambiguous, escaping or alias spelling %j", (value) => {
    expect(() => probeRelativePath(value)).toThrow("refused");
  });
  it.each([
    null,
    [],
    { op: "exec", path: "a", command: "cmd.exe" },
    { op: "read", path: "a" },
    { op: "create", path: "a", text: "x", root: "C:/" },
    { op: "write", path: "a", text: "x", executable: "cmd.exe" },
    { op: "rename", path: "a", destination: "../b" },
    { op: "remove", path: "a", destination: "b" },
    { op: "write", path: "a", text: 1 },
    { op: "write", path: "a", text: "я".repeat(MAX_PROBE_WRITE) },
  ])("has no arbitrary command, read, root or handle service: %j", (request) => {
    expect(() => parseWorkspaceProbeRequest(request)).toThrow("refused");
  });
});
