/**
 * Child-process environment allowlist (WP-21, AD-18): the children of every
 * process tool (exec and shell: shell.execute; start: process.manage) and of
 * Git get only allowlisted variables of the CROT environment; overrides set
 * literal values or remove variables and never reach withheld ones.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CrotCore } from "../../src/core/crot-core.js";
import { CHILD_ENV_ALLOWLIST, createChildEnvironment } from "../../src/core/platform/child-environment.js";
import { createTestCore, isWindows, makeTempDirs, testContext as ctx, waitFor, type TempDirs } from "../helpers.js";

const node = process.execPath;
const PRINT_ENV = "process.stdout.write(JSON.stringify(process.env))";

// Variables of the CROT process environment (as an MCP client or supervisor would pass them).
const WITHHELD = {
  CROT_TEST_API_KEY: "sk-test-secret-value-1",
  AWS_SECRET_ACCESS_KEY: "aws-secret-value-2",
  GITHUB_TOKEN: "ghp_secret_value_3",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/crot-test-bus",
};
const EXTRA = { MYAPP_MODE: "extra-allowed", MYAPP_LEVEL: "2" };
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [name, value] of Object.entries({ ...WITHHELD, ...EXTRA })) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

let dirs: TempDirs;
let core: CrotCore;
beforeEach(async () => {
  dirs = await makeTempDirs();
  core = await createTestCore({
    workspace: { root: dirs.workspace },
    permissions: { mode: "full_control" },
    environment: { path: "inherited", allow: ["MYAPP_*"] },
  });
});
afterEach(async () => {
  await core.shutdown();
  await dirs.cleanup();
});

function expectFiltered(env: Record<string, string>): void {
  const text = JSON.stringify(env);
  for (const [name, value] of Object.entries(WITHHELD)) {
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain(name);
    expect(text).not.toContain(value);
  }
  // What children need is still there.
  expect(Object.keys(env).some((k) => k.toUpperCase() === "PATH")).toBe(true);
  // environment.allow adds the owner's own variables.
  expect(env.MYAPP_MODE).toBe("extra-allowed");
}

describe("process tools get an allowlisted environment", () => {
  it("exec (shell.execute)", async () => {
    const r = await core.processes.exec(ctx, { command: node, args: ["-e", PRINT_ENV] });
    expectFiltered(JSON.parse(r.stdout) as Record<string, string>);
  });

  it("shell (shell.execute): the shell and its commands see no withheld variable", async () => {
    const r = isWindows
      ? await core.processes.shell(ctx, { script: "set", shell: "cmd" })
      : await core.processes.shell(ctx, { script: "env", shell: "sh" });
    expect(r.exitCode).toBe(0);
    for (const [name, value] of Object.entries(WITHHELD)) {
      expect(r.stdout).not.toContain(value);
      expect(r.stdout.toUpperCase()).not.toContain(`${name}=`);
    }
    expect(r.stdout).toContain("MYAPP_MODE=extra-allowed");
  });

  it("start (process.manage): background processes", async () => {
    const p = await core.processes.start(ctx, { command: node, args: ["-e", PRINT_ENV] });
    await waitFor(async () => (await core.processes.list(ctx)).find((x) => x.id === p.id)?.status === "exited");
    const out = await core.processes.readOutput(ctx, { id: p.id });
    expectFiltered(JSON.parse(out.stdout) as Record<string, string>);
  });

  it("overrides set literal values and remove variables; they cannot reach withheld ones", async () => {
    const script =
      "process.stdout.write(JSON.stringify({k: process.env.CROT_TEST_API_KEY ?? null, m: process.env.MYAPP_MODE ?? null, x: process.env.CROT_TEST_X ?? null, d: process.env.DBUS_SESSION_BUS_ADDRESS ?? null}))";
    const r = await core.processes.exec(ctx, {
      command: node,
      args: ["-e", script],
      // A literal value is just that value; null removes; naming a withheld variable cannot "inherit" it.
      env: {
        CROT_TEST_X: "$CROT_TEST_API_KEY %CROT_TEST_API_KEY%",
        MYAPP_MODE: null,
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/chosen",
      },
    });
    expect(JSON.parse(r.stdout)).toEqual({
      k: null,
      m: null,
      x: "$CROT_TEST_API_KEY %CROT_TEST_API_KEY%",
      d: "unix:path=/chosen",
    });
  });

  it("crot_status reports the policy with names only", () => {
    const status = core.status();
    expect(status.childEnvironment.policy).toBe("allowlist");
    expect(status.childEnvironment.extraAllowed).toEqual(["MYAPP_*"]);
    expect(status.childEnvironment.passed).toContain("MYAPP_MODE");
    expect(status.childEnvironment.withheld).toBeGreaterThanOrEqual(Object.keys(WITHHELD).length);
    const text = JSON.stringify(status);
    for (const value of Object.values(WITHHELD)) expect(text).not.toContain(value);
  });
});

describe("Git children start from the allowlisted environment", () => {
  it("git commands do not see withheld variables", async () => {
    const env = (core.git as unknown as { createEnvironments(): Promise<Record<string, Record<string, string>>> })
      .createEnvironments;
    const environments = await env.call(core.git);
    for (const kind of ["listing", "command", "write", "standalone"]) {
      const e = environments[kind]!;
      for (const name of Object.keys(WITHHELD)) expect(Object.keys(e).map((k) => k.toUpperCase())).not.toContain(name);
      expect(e.GIT_TERMINAL_PROMPT).toBe("0");
    }
  });
});

describe("createChildEnvironment", () => {
  it("passes exact names and prefixes, withholds everything else", () => {
    const child = createChildEnvironment(
      { PATH: "/bin", LC_ALL: "C", SECRET: "x", MYAPP_A: "1", MY: "2", HOME: "/h", NPM_TOKEN: "t" },
      ["MYAPP_*"],
      false,
    );
    expect(child.base).toEqual({ PATH: "/bin", LC_ALL: "C", MYAPP_A: "1", HOME: "/h" });
    expect(child.summary.withheld).toBe(3);
    expect(child.allows("LC_MESSAGES")).toBe(true);
    expect(child.allows("path")).toBe(false);
  });

  it("compares names case-insensitively on Windows", () => {
    const child = createChildEnvironment({ Path: "C:\\bin", SystemRoot: "C:\\Windows", Secret: "x" }, [], true);
    expect(child.base).toEqual({ Path: "C:\\bin", SystemRoot: "C:\\Windows" });
  });

  it("passes the PowerShell module analysis cache location but not PSModulePath (Windows)", () => {
    const child = createChildEnvironment(
      { PSModuleAnalysisCachePath: "C:\\cache\\ModuleAnalysisCache", PSModulePath: "C:\\ps7\\Modules" },
      [],
      true,
    );
    expect(child.base).toEqual({ PSModuleAnalysisCachePath: "C:\\cache\\ModuleAnalysisCache" });
  });

  it("the built-in list holds no credential-like names and no session bus", () => {
    for (const entry of CHILD_ENV_ALLOWLIST) {
      expect(entry).not.toMatch(/TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|DBUS|PSMODULEPATH/i);
      expect(entry === "*" || entry.length < 2).toBe(false);
    }
  });

  it("environment.allow rejects a bare wildcard", async () => {
    await expect(
      createTestCore({ workspace: { root: dirs.workspace }, environment: { allow: ["*"] } }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});
