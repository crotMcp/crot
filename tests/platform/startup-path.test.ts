import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEnvironmentPolicy } from "../../src/core/platform/environment.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import {
  loginShellPathCommand,
  mergePathLists,
  parseLoginShellPath,
  resolveStartupPath,
  standardPathEntries,
  type LoginShellRunner,
} from "../../src/core/platform/startup-path.js";
import { createTestCore, isWindows, makeTempDirs, testContext as ctx, type TempDirs } from "../helpers.js";

const posixEnv = createEnvironmentPolicy(false);
const minimalMacPath = "/usr/bin:/bin:/usr/sbin:/sbin";
const fakeLogin =
  (pathValue: string): LoginShellRunner =>
  async (_shell, args) => {
    expect(args.slice(0, 3)).toEqual(["-l", "-i", "-c"]);
    // Startup files may print noise around the marked value.
    return `Welcome!\n${args[3]!.replace(/^printf '%s' '([^']+)'"\$PATH"'[^']+'$/, `$1${pathValue}$1`)}\nbye`;
  };
const dirsThatExist =
  (...dirs: string[]) =>
  async (d: string) =>
    dirs.includes(d);

describe("startup PATH (pure)", () => {
  it("builds login shell commands for POSIX shells and fish only", () => {
    expect(loginShellPathCommand("/bin/zsh")?.slice(0, 3)).toEqual(["-l", "-i", "-c"]);
    expect(loginShellPathCommand("/usr/bin/fish")?.[3]).toContain("string join : -- $PATH");
    expect(loginShellPathCommand("/bin/tcsh")).toBeNull();
  });

  it("extracts the marked PATH and ignores startup noise", () => {
    const [, , , script] = loginShellPathCommand("/bin/bash")!;
    const marker = /'([^']+)'/.exec(script!.slice("printf '%s' ".length))![1]!;
    expect(parseLoginShellPath(`motd\n${marker}/a:/b${marker}`)).toBe("/a:/b");
    expect(parseLoginShellPath("nothing")).toBeNull();
  });

  it("merges PATH lists in order without duplicates", () => {
    expect(mergePathLists(["/a", "/b"], ["/b", "", "/c"], ["/a", "/d"])).toEqual(["/a", "/b", "/c", "/d"]);
  });

  it("has OS-specific standard directories and none on Windows", () => {
    expect(standardPathEntries("macos")).toContain("/opt/homebrew/bin");
    expect(standardPathEntries("linux")).toContain("/usr/local/bin");
    expect(standardPathEntries("windows")).toEqual([]);
  });

  it("auto: uses the login shell PATH when not started from a shell (desktop launch)", async () => {
    const r = await resolveStartupPath({
      os: "macos",
      env: { PATH: minimalMacPath, SHELL: "/bin/zsh", HOME: "/Users/u" },
      environment: posixEnv,
      mode: "auto",
      run: fakeLogin("/opt/homebrew/bin:/Users/u/.nvm/bin:/usr/bin:/bin"),
      isDirectory: dirsThatExist("/opt/homebrew/bin", "/usr/local/bin"),
    });
    expect(r.env.PATH).toBe("/opt/homebrew/bin:/Users/u/.nvm/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin");
    expect(r.env.HOME).toBe("/Users/u");
    expect(r.info).toEqual({
      mode: "auto",
      source: "login-shell",
      shell: "/bin/zsh",
      added: ["/opt/homebrew/bin", "/Users/u/.nvm/bin", "/usr/local/bin"],
    });
  });

  it("auto: keeps the inherited PATH when started from a shell, adding only missing standard directories", async () => {
    let ran = false;
    const r = await resolveStartupPath({
      os: "linux",
      env: { PATH: "/home/u/bin:/usr/bin", SHELL: "/bin/bash", SHLVL: "2" },
      environment: posixEnv,
      mode: "auto",
      run: async () => ((ran = true), ""),
      isDirectory: dirsThatExist("/usr/bin", "/usr/local/bin"),
    });
    expect(ran).toBe(false);
    expect(r.env.PATH).toBe("/home/u/bin:/usr/bin:/usr/local/bin");
    expect(r.info).toEqual({ mode: "auto", source: "inherited", added: ["/usr/local/bin"] });
  });

  it("inherited: leaves PATH untouched", async () => {
    const r = await resolveStartupPath({
      os: "macos",
      env: { PATH: minimalMacPath },
      environment: posixEnv,
      mode: "inherited",
      isDirectory: dirsThatExist("/opt/homebrew/bin"),
    });
    expect(r.env.PATH).toBe(minimalMacPath);
    expect(r.info).toEqual({ mode: "inherited", source: "inherited", added: [] });
  });

  it("falls back to the inherited PATH with a note when the login shell fails", async () => {
    const r = await resolveStartupPath({
      os: "linux",
      env: { PATH: "/usr/bin", SHELL: "/bin/bash" },
      environment: posixEnv,
      mode: "login-shell",
      run: async () => {
        throw new Error("timed out");
      },
      isDirectory: dirsThatExist(),
    });
    expect(r.env.PATH).toBe("/usr/bin");
    expect(r.info).toMatchObject({ source: "inherited", added: [], note: expect.stringContaining("timed out") });
  });

  it("reports unsupported or missing login shells", async () => {
    const base = {
      os: "linux" as const,
      environment: posixEnv,
      mode: "login-shell" as const,
      isDirectory: dirsThatExist(),
    };
    expect((await resolveStartupPath({ ...base, env: { PATH: "/usr/bin", SHELL: "/bin/tcsh" } })).info.note).toContain(
      "not supported",
    );
    expect((await resolveStartupPath({ ...base, env: { PATH: "/usr/bin" } })).info.note).toContain("$SHELL is not set");
  });

  it("Windows: always uses the inherited environment", async () => {
    const env = { Path: "C:\\Windows", SHELL: "/bin/bash" };
    const r = await resolveStartupPath({
      os: "windows",
      env,
      environment: createEnvironmentPolicy(true),
      mode: "login-shell",
      run: async () => {
        throw new Error("must not run");
      },
      isDirectory: dirsThatExist(),
    });
    expect(r.env).toEqual(env);
    expect(r.info).toEqual({ mode: "login-shell", source: "inherited", added: [] });
  });
});

describe.runIf(!isWindows)("startup PATH with a real login shell (POSIX)", () => {
  let dirs: TempDirs;
  beforeEach(async () => {
    dirs = await makeTempDirs();
  });
  afterEach(() => dirs.cleanup());

  /** A fake login shell named "bash" whose "profile" prepends a tools directory. */
  async function fakeShell(body: string): Promise<{ shell: string; tools: string }> {
    const tools = path.join(dirs.outside, "login-tools");
    await mkdir(tools);
    const tool = path.join(tools, "crot-login-tool");
    await writeFile(tool, "#!/bin/sh\necho login-tool-ran\n");
    await chmod(tool, 0o755);
    const shell = path.join(dirs.outside, "bash");
    await writeFile(shell, `#!/bin/sh\nPATH="${tools}:$PATH"; export PATH\n${body}\n`);
    await chmod(shell, 0o755);
    return { shell, tools };
  }

  it("finds executables that only the login shell PATH contains", async () => {
    const { shell, tools } = await fakeShell('echo "profile noise"\nexec /bin/sh -c "$4"');
    const platform = await createNodePlatform({
      env: { PATH: "/usr/bin:/bin", HOME: dirs.outside },
      startupPath: "auto",
      loginShell: shell,
    });
    expect(platform.info.startupPath).toMatchObject({ source: "login-shell", shell });
    expect(platform.baseEnvironment.PATH!.split(":")[0]).toBe(tools);
    const core = await createTestCore({ workspace: { root: dirs.workspace } }, undefined, { platform });
    try {
      const r = await core.processes.exec(ctx, { command: "crot-login-tool" });
      expect(r.stdout.trim()).toBe("login-tool-ran");
      expect(core.status().platform.startupPath.source).toBe("login-shell");
    } finally {
      await core.shutdown();
    }
  });

  it("does not hang on a login shell that never finishes", async () => {
    const { shell } = await fakeShell("sleep 30");
    const started = Date.now();
    const platform = await createNodePlatform({
      env: { PATH: "/usr/bin:/bin" },
      startupPath: "login-shell",
      loginShell: shell,
      loginShellTimeoutMs: 500,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(platform.info.startupPath).toMatchObject({
      source: "inherited",
      note: expect.stringContaining("did not finish"),
    });
    expect(platform.baseEnvironment.PATH!.startsWith("/usr/bin:/bin")).toBe(true);
  });
});

describe.runIf(isWindows)("startup PATH (Windows)", () => {
  it("keeps the inherited environment", async () => {
    const platform = await createNodePlatform({ startupPath: "login-shell" });
    expect(platform.info.startupPath).toEqual({ mode: "login-shell", source: "inherited", added: [] });
    expect(platform.environment.get(platform.baseEnvironment, "PATH")).toBe(
      platform.environment.get(process.env, "PATH"),
    );
  });
});
