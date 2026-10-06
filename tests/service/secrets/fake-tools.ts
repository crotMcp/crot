/**
 * In-memory stand-ins for /usr/bin/security (macOS Keychain) and secret-tool
 * (libsecret), as SecretToolRunner seams. They record every invocation so
 * tests can check that secrets never appear in an argument vector.
 */
import type { SecretToolRunner, ToolResult } from "../../../src/service/secrets/tool.js";

export interface FakeTools {
  readonly run: SecretToolRunner;
  readonly items: Map<string, string>;
  readonly calls: { file: string; args: readonly string[]; input?: string }[];
  /** Make the next matching operations fail ("store" | "lookup" | "clear" | "all"). */
  fail: Set<string>;
  /** Return this value from lookups instead of the stored one. */
  corruptLookup?: string;
}

const ok = (stdout = ""): ToolResult => ({ code: 0, stdout, stderr: "", timedOut: false });

export function fakeTools(): FakeTools {
  const items = new Map<string, string>();
  const calls: FakeTools["calls"] = [];
  const state: FakeTools = {
    items,
    calls,
    fail: new Set(),
    run: async (file, args, options = {}) => {
      calls.push({ file, args: [...args], ...(options.input !== undefined ? { input: options.input } : {}) });
      const failing = (op: string) => state.fail.has(op) || state.fail.has("all");
      if (file.endsWith("security")) {
        const option = (list: readonly string[], flag: string) => list[list.indexOf(flag) + 1]!;
        if (args[0] === "find-generic-password") {
          if (failing("lookup"))
            return { code: 51, stdout: "", stderr: "User interaction is not allowed.", timedOut: false };
          const value = items.get(`${option(args, "-s")}/${option(args, "-a")}`);
          if (value === undefined)
            return { code: 44, stdout: "", stderr: "The specified item could not be found.", timedOut: false };
          return ok(`${state.corruptLookup ?? value}\n`);
        }
        if (args[0] === "delete-generic-password") {
          if (failing("clear")) return { code: 51, stdout: "", stderr: "denied", timedOut: false };
          const key = `${option(args, "-s")}/${option(args, "-a")}`;
          if (!items.delete(key)) return { code: 44, stdout: "", stderr: "not found", timedOut: false };
          return ok();
        }
        if (args[0] === "-i") {
          if (failing("store")) return { code: 0, stdout: "", stderr: "add-generic-password: denied", timedOut: false };
          const words = (options.input ?? "").trim().match(/"[^"]*"|\S+/g) ?? [];
          if (words[0] !== "add-generic-password")
            return { code: 1, stdout: "", stderr: "bad command", timedOut: false };
          items.set(
            `${option(words, "-s")}/${option(words, "-a")}`,
            Buffer.from(option(words, "-X"), "hex").toString("utf8"),
          );
          return ok();
        }
        return { code: 2, stdout: "", stderr: "unknown", timedOut: false };
      }
      // secret-tool <store --label=L | lookup | clear> attr value ...
      const [command, ...rest] = args;
      const attributes = rest.filter((a) => !a.startsWith("--label="));
      const key = attributes.join("/");
      if (command === "lookup") {
        if (failing("lookup")) return { code: 1, stdout: "", stderr: "Cannot autolaunch D-Bus", timedOut: false };
        const value = items.get(key);
        return value === undefined
          ? { code: 1, stdout: "", stderr: "", timedOut: false }
          : ok(state.corruptLookup ?? value);
      }
      if (command === "store") {
        if (failing("store"))
          return { code: 1, stdout: "", stderr: "Cannot create an item in a locked collection", timedOut: false };
        items.set(key, options.input ?? "");
        return ok();
      }
      if (command === "clear") {
        if (failing("clear")) return { code: 1, stdout: "", stderr: "denied", timedOut: false };
        items.delete(key);
        return ok();
      }
      return { code: 2, stdout: "", stderr: "usage", timedOut: false };
    },
  };
  return state;
}
