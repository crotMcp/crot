import { existsSync, readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { CrotError } from "../../src/core/errors.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import type {
  CommandSpec,
  ExitStatus,
  LaunchOptions,
  ManagedProcess,
  Platform,
  ProcessLauncher,
  ResolveCommandOptions,
} from "../../src/core/platform/types.js";
import { canSymlinkFiles, createTestCore, makeTempDirs, testContext as ctx, type TempDirs } from "../helpers.js";

/**
 * docker.use is tested without Docker: the Platform's ProcessLauncher is
 * replaced by a fake `docker` that records every invocation and answers from a
 * script. The tests check what CROT would run (exact argv, environment,
 * working directory) and what it refuses before anything runs.
 */

interface Reply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  /** Never exit on its own (until terminated). */
  readonly hang?: boolean;
}

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly resolve: ResolveCommandOptions;
  launch?: LaunchOptions;
}

class FakeDocker implements ProcessLauncher {
  readonly calls: Call[] = [];
  readonly canTerminateOrphanedDescendants = true;
  readonly processControl = {
    treeTermination: "process-group",
    orphanedDescendants: true,
    gracefulTermination: true,
  } as const;
  missing = false;

  constructor(public respond: (args: readonly string[]) => Reply) {}

  /** Docker argument lists of launched commands. */
  get launched(): (readonly string[])[] {
    return this.calls.filter((c) => c.launch).map((c) => c.args);
  }

  async resolveCommand(command: string, args: readonly string[], options: ResolveCommandOptions): Promise<CommandSpec> {
    this.calls.push({ command, args: [...args], resolve: options });
    if (this.missing) throw new CrotError("NOT_FOUND", `Command not found: ${command}`);
    return { file: "/usr/bin/docker", args, display: ["docker", ...args].join(" ") };
  }

  async launch(spec: CommandSpec, options: LaunchOptions): Promise<ManagedProcess> {
    const call = [...this.calls]
      .reverse()
      .find((c) => c.args === spec.args || c.args.join("\0") === spec.args.join("\0"));
    if (call) call.launch = options;
    const reply = this.respond(spec.args);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let settle: (status: ExitStatus) => void = () => undefined;
    let exited = false;
    const exit = new Promise<ExitStatus>((resolve) => {
      settle = (status) => {
        if (exited) return;
        exited = true;
        stdout.end();
        stderr.end();
        resolve(status);
      };
    });
    const proc: ManagedProcess = {
      pid: 4242,
      stdin: null,
      stdout,
      stderr,
      exited: exit,
      get hasExited() {
        return exited;
      },
      terminate: async () => settle({ code: null, signal: "SIGKILL" }),
      terminateSync: () => settle({ code: null, signal: "SIGKILL" }),
    };
    setImmediate(() => {
      if (reply.stdout) stdout.write(reply.stdout);
      if (reply.stderr) stderr.write(reply.stderr);
      if (!reply.hang) settle({ code: reply.code ?? 0, signal: null });
    });
    return proc;
  }
}

const SANDBOX_WITH_DOCKER = { mode: "sandbox", capabilities: ["filesystem.read", "filesystem.write", "docker.use"] };
const CONTAINER_ID = "a".repeat(64);

let dirs: TempDirs;
let platform: Platform;
let fake: FakeDocker;
let audit: MemoryAuditSink;
let core: CrotCore | undefined;

beforeEach(async () => {
  dirs = await makeTempDirs();
  fake = new FakeDocker(() => ({ code: 0 }));
  audit = new MemoryAuditSink();
  const node = await createNodePlatform({ startupPath: "inherited" });
  platform = {
    ...node,
    launcher: fake,
    baseEnvironment: {
      ...node.baseEnvironment,
      COMPOSE_FILE: "/elsewhere/compose.yaml",
      COMPOSE_PROJECT_NAME: "elsewhere",
      CROT_TEST_SECRET: "do-not-forward",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    },
  };
});

afterEach(async () => {
  await core?.shutdown();
  core = undefined;
  await dirs.cleanup();
});

async function makeCore(
  permissions: unknown,
  options: { protectedPaths?: string[]; secretPaths?: string[] } = {},
): Promise<CrotCore> {
  core = await createTestCore({ workspace: { root: dirs.workspace }, permissions }, audit, { platform, ...options });
  return core;
}

const lastAudit = () => audit.events[audit.events.length - 1];

/** ps line in the format CROT asks Docker for. */
function psLine(name: string, workingDir: string, project = "demo"): string {
  return `${JSON.stringify({
    id: name.padEnd(64, "0"),
    names: name,
    image: "nginx:alpine",
    state: "running",
    status: "Up 1 minute",
    createdAt: "2025-01-01 00:00:00 +0000 UTC",
    ports: "",
    project,
    service: "web",
    workingDir,
  })}\n`;
}

/** A Compose project directory in the workspace with a minimal compose.yaml. */
async function makeProject(dir: string, yaml = "services:\n  web:\n    image: nginx:alpine\n"): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "compose.yaml"), yaml);
  return dir;
}

interface ComposeScript {
  /** Model of `config --no-interpolate --no-normalize`. */
  raw?: unknown;
  /** Model of `config` (normalized). */
  model: unknown;
  up?: Reply;
}

/** Answer Compose like Docker Compose would; records the model handed to `up`. */
function scriptCompose(script: ComposeScript): { upModel: () => unknown; upFile: () => string | undefined } {
  let upModel: unknown;
  let upFile: string | undefined;
  fake.respond = (args) => {
    if (args[0] !== "compose") return { code: 1, stderr: "unexpected" };
    if (args.includes("config")) {
      const model = args.includes("--no-interpolate") ? (script.raw ?? script.model) : script.model;
      return { stdout: JSON.stringify(model) };
    }
    if (args.includes("up")) {
      upFile = args[args.indexOf("-f") + 1];
      upModel = JSON.parse(readFileSync(upFile!, "utf8"));
      return script.up ?? { stderr: " Container demo-web-1  Started\n" };
    }
    return { code: 1, stderr: "unexpected" };
  };
  return { upModel: () => upModel, upFile: () => upFile };
}

/** Normalized model of a project "demo" with one service "web" (as `docker compose config` prints it). */
function webModel(_dir: string, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    name: "demo",
    services: { web: { image: "nginx:alpine", command: null, entrypoint: null, ...extra } },
    networks: { default: { name: "demo_default", ipam: {} } },
    ...top,
  };
}

describe("docker.use: capability", () => {
  it("is enforced, not granted in sandbox by default and granted in full_control", async () => {
    const sandbox = await makeCore({ mode: "sandbox" });
    expect(sandbox.status().capabilities.find((c) => c.capability === "docker.use")).toEqual({
      capability: "docker.use",
      granted: false,
      enforced: true,
    });
    await sandbox.shutdown();
    const full = await makeCore({ mode: "full_control" });
    expect(full.status().capabilities.find((c) => c.capability === "docker.use")).toMatchObject({
      granted: true,
      enforced: true,
    });
  });

  it("denies every operation without docker.use, audits the denial and starts nothing", async () => {
    const c = await makeCore({ mode: "sandbox" });
    await makeProject(path.join(dirs.workspace, "app"));
    const ops: [string, () => Promise<unknown>][] = [
      ["docker.ps", () => c.docker.ps(ctx, {})],
      ["docker.inspect", () => c.docker.logs(ctx, { container: "web" })],
      ["docker.compose_config", () => c.docker.composeUp(ctx, { cwd: "app" })],
      ["docker.compose_ps", () => c.docker.composeDown(ctx, { project: "demo" })],
    ];
    for (const [operation, op] of ops) {
      await expect(op()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(lastAudit()).toMatchObject({ operation, outcome: "denied", capabilities: ["docker.use"] });
    }
    expect(fake.calls).toEqual([]);
  });
});

describe("docker.use: input validation", () => {
  it.each([
    ["an option as container", () => core!.docker.logs(ctx, { container: "-H=tcp://evil:2375" })],
    ["a long option as container", () => core!.docker.logs(ctx, { container: "--privileged" })],
    ["a container with spaces", () => core!.docker.logs(ctx, { container: "web; rm -rf /" })],
    ["a container with a path", () => core!.docker.logs(ctx, { container: "../web" })],
    ["an option as project", () => core!.docker.composeDown(ctx, { project: "--volumes" })],
    ["an invalid project", () => core!.docker.ps(ctx, { project: "Demo$(id)" })],
    ["an option as service", () => core!.docker.composeUp(ctx, { services: ["--build"] })],
    ["an option as project name", () => core!.docker.composeUp(ctx, { projectName: "-p" })],
    ["extra Docker arguments", () => core!.docker.ps(ctx, { args: ["--format", "{{.ID}}"] } as never)],
    ["a raw command", () => core!.docker.composeUp(ctx, { command: "run --privileged" } as never)],
    ["a huge tail", () => core!.docker.logs(ctx, { container: "web", tail: 1_000_000 })],
  ])("refuses %s with INVALID_INPUT before running Docker", async (_name, op) => {
    await makeCore({ mode: "full_control" });
    await expect(op()).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fake.calls).toEqual([]);
  });

  it("refuses a timeout above the configured maximum", async () => {
    const c = await makeCore({ mode: "full_control" });
    await expect(c.docker.ps(ctx, { timeoutMs: 10 * 60 * 60 * 1000 })).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
  });
});

describe("docker.use: docker_ps", () => {
  it("runs a fixed docker ps from PATH only, outside the workspace, with a filtered environment", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    fake.respond = () => ({
      stdout:
        psLine("inside", path.join(dirs.workspace, "app")) +
        psLine("outside", path.join(dirs.outside, "app"), "other") +
        psLine("plain", ""),
    });
    const result = await c.docker.ps(ctx, {});
    expect(result.containers.map((x) => x.names)).toEqual(["inside"]);
    expect(result.containers[0]).toMatchObject({ project: "demo", service: "web", projectDirectory: "app" });

    const [call] = fake.calls;
    expect(call!.command).toBe("docker");
    expect(call!.args.slice(0, 4)).toEqual(["ps", "--all", "--no-trunc", "--format"]);
    expect(call!.args).toHaveLength(5);
    expect(call!.resolve.searchCurrentDirectory).toBe(false);
    expect(call!.resolve.cwd.startsWith(dirs.workspace)).toBe(false);
    expect(call!.launch).toMatchObject({ stdin: false, cwd: call!.resolve.cwd });
    const env = call!.launch!.env;
    expect(env.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(env.COMPOSE_FILE).toBeUndefined();
    expect(env.COMPOSE_PROJECT_NAME).toBeUndefined();
    expect(env.CROT_TEST_SECRET).toBeUndefined();
    expect(lastAudit()).toMatchObject({ operation: "docker.ps", outcome: "success", capabilities: ["docker.use"] });
  });

  it("filters by project label", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    fake.respond = () => ({ stdout: "" });
    await c.docker.ps(ctx, { project: "demo" });
    expect(fake.launched[0]!.slice(-2)).toEqual(["--filter", "label=com.docker.compose.project=demo"]);
  });

  it("scope=all needs filesystem.full: denied in sandbox, allowed in full_control", async () => {
    const sandbox = await makeCore(SANDBOX_WITH_DOCKER);
    await expect(sandbox.docker.ps(ctx, { scope: "all" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(lastAudit()).toMatchObject({ outcome: "denied" });
    expect(fake.calls).toEqual([]);
    await sandbox.shutdown();

    const full = await makeCore({ mode: "full_control" });
    fake.respond = () => ({ stdout: psLine("inside", dirs.workspace) + psLine("outside", dirs.outside, "other") });
    const result = await full.docker.ps(ctx, { scope: "all" });
    expect(result.containers.map((x) => x.names)).toEqual(["inside", "outside"]);
    expect(result.containers[1]!.projectDirectory).toBe(dirs.outside);
  });
});

describe("docker.use: docker_logs", () => {
  function scriptLogs(workingDir: string) {
    fake.respond = (args) => {
      if (args[0] === "inspect") {
        return { stdout: `${JSON.stringify({ id: CONTAINER_ID, project: "demo", workingDir })}\n` };
      }
      if (args[0] === "logs") return { stdout: "hello\n", stderr: "warn\n" };
      return { code: 1 };
    };
  }

  it("reads the logs of a container whose project is in the workspace", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    scriptLogs(path.join(dirs.workspace, "app"));
    const result = await c.docker.logs(ctx, { container: "demo-web-1", tail: 50, timestamps: true });
    expect(result).toEqual({ container: "demo-web-1", stdout: "hello\n", stderr: "warn\n", truncated: false });
    expect(fake.launched[0]!.slice(0, 4)).toEqual(["inspect", "--type", "container", "--format"]);
    expect(fake.launched[0]!.slice(-2)).toEqual(["--", "demo-web-1"]);
    expect(fake.launched[1]).toEqual(["logs", "--tail", "50", "--timestamps", "--", CONTAINER_ID]);
    expect(lastAudit()).toMatchObject({
      operation: "docker.logs",
      outcome: "success",
      paths: [path.join(dirs.workspace, "app")],
    });
  });

  it("denies the logs of a container of another project in sandbox, allows them in full_control", async () => {
    const sandbox = await makeCore(SANDBOX_WITH_DOCKER);
    scriptLogs(path.join(dirs.outside, "app"));
    await expect(sandbox.docker.logs(ctx, { container: "other-web-1" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(lastAudit()).toMatchObject({ operation: "docker.logs", outcome: "denied" });
    expect(fake.launched.some((a) => a[0] === "logs")).toBe(false);
    await sandbox.shutdown();

    const full = await makeCore({ mode: "full_control" });
    expect((await full.docker.logs(ctx, { container: "other-web-1" })).stdout).toBe("hello\n");
  });

  it("requires filesystem.full for a container not created by Compose", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    scriptLogs("");
    await expect(c.docker.logs(ctx, { container: "standalone" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { missing: ["filesystem.full"] },
    });
  });

  it("reports an unknown container as NOT_FOUND", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    fake.respond = () => ({ code: 1, stderr: "Error: No such container: nope\n" });
    await expect(c.docker.logs(ctx, { container: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("docker.use: docker_compose_up", () => {
  it("starts the reviewed model with fixed options and canonical host paths", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    const app = await makeProject(path.join(dirs.workspace, "app"));
    const data = path.join(app, "data");
    const script = scriptCompose({
      model: webModel(
        app,
        {
          volumes: [
            { type: "bind", source: data, target: "/data", read_only: true, bind: { create_host_path: true } },
            { type: "volume", source: "cache", target: "/cache", volume: {} },
          ],
          environment: { MODE: "dev" },
          ports: [{ mode: "ingress", target: 80, published: "8080", protocol: "tcp" }],
        },
        { volumes: { cache: { name: "demo_cache" } } },
      ),
    });
    const result = await c.docker.composeUp(ctx, { cwd: "app", services: ["web"] });
    expect(result).toMatchObject({
      project: "demo",
      projectDirectory: "app",
      files: ["app/compose.yaml"],
      services: ["web"],
    });

    const [raw, normalized, up] = fake.launched;
    const file = path.join(app, "compose.yaml");
    expect(raw!.slice(0, 7)).toEqual([
      "compose",
      "--project-directory",
      app,
      "--env-file",
      expect.any(String),
      "-f",
      file,
    ]);
    expect(raw!.slice(7)).toEqual(["config", "--format", "json", "--no-interpolate", "--no-normalize"]);
    expect(normalized!.slice(7)).toEqual(["config", "--format", "json"]);
    const emptyEnv = raw![4]!;
    expect(emptyEnv.startsWith(dirs.workspace)).toBe(false);
    expect(readFileSync(emptyEnv, "utf8")).toBe("");
    expect(up).toEqual([
      "compose",
      "-p",
      "demo",
      "--project-directory",
      app,
      "--env-file",
      emptyEnv,
      "-f",
      script.upFile(),
      "up",
      "--detach",
      "--pull",
      "never",
      "--no-build",
      "--",
      "web",
    ]);
    expect(script.upFile()!.startsWith(dirs.workspace)).toBe(false);
    expect(existsSync(script.upFile()!)).toBe(false);
    expect(script.upModel()).toMatchObject({ services: { web: { volumes: [{ source: data }, { source: "cache" }] } } });
    expect(audit.events.map((e) => [e.operation, e.outcome])).toEqual([
      ["docker.compose_config", "success"],
      ["docker.compose_config", "success"],
      ["docker.compose_up", "success"],
    ]);
    expect(lastAudit()!.paths).toEqual(expect.arrayContaining([app, file, data]));
  });

  it("passes the project's explicitly opted-in .env and authorizes the env files the model names", async () => {
    const c = await makeCore({
      ...SANDBOX_WITH_DOCKER,
      projectSecrets: { allow: [{ workspace: dirs.workspace, path: "app/.env" }] },
    });
    const app = await makeProject(path.join(dirs.workspace, "app"));
    await writeFile(path.join(app, ".env"), "TAG=1\n");
    const envFile = path.join(app, "web.env");
    scriptCompose({
      raw: { services: { web: { image: "nginx:alpine", env_file: [{ path: envFile, required: true }] } } },
      model: webModel(app),
    });
    await c.docker.composeUp(ctx, { cwd: "app", projectName: "custom" });
    const [raw, normalized, up] = fake.launched;
    const envFileArg = (args: readonly string[]) => args[args.indexOf("--env-file") + 1];
    expect(raw!.slice(0, 3)).toEqual(["compose", "-p", "custom"]);
    expect(envFileArg(raw!)).toBe(path.join(app, ".env"));
    expect(envFileArg(normalized!)).toBe(path.join(app, ".env"));
    expect(up!.slice(0, 3)).toEqual(["compose", "-p", "custom"]);
    expect(envFileArg(up!)).not.toBe(path.join(app, ".env"));
    expect(audit.events[1]!.paths).toContain(envFile);
  });

  it.each([SANDBOX_WITH_DOCKER, { mode: "full_control" }])(
    "refuses implicit project .env before resolving or launching Docker (%j)",
    async (permissions) => {
      const c = await makeCore(permissions);
      const app = await makeProject(path.join(dirs.workspace, "app"));
      await writeFile(path.join(app, ".env"), "UNLOGGED_SECRET=private\n");
      await expect(c.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(fake.calls).toEqual([]);
      expect(audit.events.at(-1)).toMatchObject({ operation: "docker.compose_config", outcome: "denied" });
      expect(JSON.stringify(audit.events)).not.toContain("UNLOGGED_SECRET");
    },
  );

  describe("perimeter (sandbox denies, full_control allows)", () => {
    it("project directory outside the workspace", async () => {
      await makeProject(path.join(dirs.outside, "app"));
      const sandbox = await makeCore(SANDBOX_WITH_DOCKER);
      await expect(sandbox.docker.composeUp(ctx, { cwd: path.join(dirs.outside, "app") })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      expect(fake.calls).toEqual([]);
      await sandbox.shutdown();

      const full = await makeCore({ mode: "full_control" });
      scriptCompose({ model: webModel("") });
      await expect(full.docker.composeUp(ctx, { cwd: path.join(dirs.outside, "app") })).resolves.toMatchObject({
        project: "demo",
      });
    });

    it("compose file outside the workspace", async () => {
      await makeProject(path.join(dirs.workspace, "app"));
      await makeProject(path.join(dirs.outside, "evil"));
      const sandbox = await makeCore(SANDBOX_WITH_DOCKER);
      const files = [path.join(dirs.outside, "evil", "compose.yaml")];
      await expect(sandbox.docker.composeUp(ctx, { cwd: "app", files })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      expect(fake.calls).toEqual([]);
      await sandbox.shutdown();

      const full = await makeCore({ mode: "full_control" });
      scriptCompose({ model: webModel("") });
      await expect(full.docker.composeUp(ctx, { cwd: "app", files })).resolves.toMatchObject({ project: "demo" });
    });

    it("compose file that is a symlink to a file outside the workspace", async (t) => {
      if (!(await canSymlinkFiles())) t.skip();
      const app = path.join(dirs.workspace, "app");
      await mkdir(app);
      await makeProject(path.join(dirs.outside, "evil"));
      await symlink(path.join(dirs.outside, "evil", "compose.yaml"), path.join(app, "compose.yaml"), "file");
      const sandbox = await makeCore(SANDBOX_WITH_DOCKER);
      await expect(sandbox.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      expect(fake.calls).toEqual([]);
    });

    it("compose file reached with '..' segments", async () => {
      await makeProject(path.join(dirs.outside, "evil"));
      const sandbox = await makeCore(SANDBOX_WITH_DOCKER);
      await expect(sandbox.docker.composeUp(ctx, { files: ["../outside/evil/compose.yaml"] })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      expect(fake.calls).toEqual([]);
    });

    it("env file outside the workspace (denied before Compose reads it)", async () => {
      const app = await makeProject(path.join(dirs.workspace, "app"));
      const envFile = path.join(dirs.outside, "secrets.env");
      const raw = { services: { web: { image: "nginx:alpine", env_file: [{ path: envFile, required: true }] } } };
      const sandbox = await makeCore(SANDBOX_WITH_DOCKER);
      scriptCompose({ raw, model: webModel(app) });
      await expect(sandbox.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      expect(fake.launched).toHaveLength(1);
      expect(fake.launched[0]).toContain("--no-interpolate");
      await sandbox.shutdown();

      fake.calls.length = 0;
      const full = await makeCore({ mode: "full_control" });
      scriptCompose({ raw, model: webModel(app) });
      await expect(full.docker.composeUp(ctx, { cwd: "app" })).resolves.toMatchObject({ project: "demo" });
    });

    it("bind mount outside the workspace (e.g. the Docker socket or /etc)", async () => {
      const app = await makeProject(path.join(dirs.workspace, "app"));
      const model = webModel(app, {
        volumes: [{ type: "bind", source: dirs.outside, target: "/host", bind: { create_host_path: true } }],
      });
      const sandbox = await makeCore(SANDBOX_WITH_DOCKER);
      scriptCompose({ model });
      await expect(sandbox.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      expect(lastAudit()).toMatchObject({ operation: "docker.compose_up", outcome: "denied" });
      expect(fake.launched.some((a) => a.includes("up"))).toBe(false);
      await sandbox.shutdown();

      const full = await makeCore({ mode: "full_control" });
      const script = scriptCompose({ model });
      await full.docker.composeUp(ctx, { cwd: "app" });
      expect(script.upModel()).toMatchObject({ services: { web: { volumes: [{ source: dirs.outside }] } } });
    });

    it("bind mount through a symlink that leaves the workspace", async () => {
      const app = await makeProject(path.join(dirs.workspace, "app"));
      await symlink(dirs.outside, path.join(app, "link"), process.platform === "win32" ? "junction" : "dir");
      const sandbox = await makeCore(SANDBOX_WITH_DOCKER);
      scriptCompose({
        model: webModel(app, { volumes: [{ type: "bind", source: path.join(app, "link"), target: "/x" }] }),
      });
      await expect(sandbox.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      expect(fake.launched.some((a) => a.includes("up"))).toBe(false);
    });

    it("secret file outside the workspace", async () => {
      const app = await makeProject(path.join(dirs.workspace, "app"));
      const model = webModel(
        app,
        { secrets: [{ source: "token", target: "/run/secrets/token" }] },
        { secrets: { token: { name: "demo_token", file: path.join(dirs.outside, "token") } } },
      );
      const sandbox = await makeCore(SANDBOX_WITH_DOCKER);
      scriptCompose({ model });
      await expect(sandbox.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    });

    it("external volumes need filesystem.full", async () => {
      const app = await makeProject(path.join(dirs.workspace, "app"));
      const model = webModel(
        app,
        { volumes: [{ type: "volume", source: "shared", target: "/shared", volume: {} }] },
        { volumes: { shared: { name: "shared", external: true } } },
      );
      const sandbox = await makeCore(SANDBOX_WITH_DOCKER);
      scriptCompose({ model });
      await expect(sandbox.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
        details: { missing: ["filesystem.full"] },
      });
      await sandbox.shutdown();

      const full = await makeCore({ mode: "full_control" });
      scriptCompose({ model });
      await expect(full.docker.composeUp(ctx, { cwd: "app" })).resolves.toMatchObject({ project: "demo" });
    });
  });

  it("refuses a writable bind mount that exposes a CROT-protected path", async () => {
    const app = await makeProject(path.join(dirs.workspace, "app"));
    const auditFile = path.join(dirs.workspace, "audit.jsonl");
    await writeFile(auditFile, "");
    const c = await makeCore({ mode: "full_control" }, { protectedPaths: [auditFile] });
    scriptCompose({ model: webModel(app, { volumes: [{ type: "bind", source: dirs.workspace, target: "/ws" }] }) });
    await expect(c.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.launched.some((a) => a.includes("up"))).toBe(false);

    fake.calls.length = 0;
    scriptCompose({
      model: webModel(app, { volumes: [{ type: "bind", source: dirs.workspace, target: "/ws", read_only: true }] }),
    });
    await expect(c.docker.composeUp(ctx, { cwd: "app" })).resolves.toMatchObject({ project: "demo" });
  });

  it("refuses any bind mount, even read-only, that exposes CROT secrets (AD-18)", async () => {
    const app = await makeProject(path.join(dirs.workspace, "app"));
    const state = path.join(dirs.workspace, "state");
    await mkdir(state, { recursive: true });
    const token = path.join(state, "http-token");
    await writeFile(token, "secret\n");
    const missing = path.join(dirs.workspace, "other", "service-token");
    const c = await makeCore({ mode: "full_control" }, { secretPaths: [token, missing] });
    for (const source of [dirs.workspace, state, token]) {
      fake.calls.length = 0;
      scriptCompose({ model: webModel(app, { volumes: [{ type: "bind", source, target: "/x", read_only: true }] }) });
      await expect(c.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(fake.launched.some((a) => a.includes("up"))).toBe(false);
    }
    // A secret path that does not exist (OS secure storage in use) does not block mounting its parent.
    fake.calls.length = 0;
    scriptCompose({
      model: webModel(app, {
        volumes: [{ type: "bind", source: path.join(dirs.workspace, "other"), target: "/o", read_only: true }],
      }),
    });
    await expect(c.docker.composeUp(ctx, { cwd: "app" })).resolves.toMatchObject({ project: "demo" });
  });

  describe("Compose policy (refused in every mode)", () => {
    for (const mode of ["sandbox", "full_control"] as const) {
      const permissions = mode === "sandbox" ? SANDBOX_WITH_DOCKER : { mode };

      it.each([
        ["include", "include:\n  - ../other/compose.yaml\nservices:\n  web:\n    image: nginx\n"],
        ["extends", "services:\n  web:\n    extends:\n      file: /etc/compose.yaml\n      service: x\n"],
        ["an escaped key", 'services:\n  web:\n    image: nginx\n    "\\x65xtends": {file: /x, service: y}\n'],
        ["a binary tag", "services:\n  web: !!binary ZXh0ZW5kcw==\n"],
      ])(`${mode}: refuses a Compose file with %s before Compose reads it`, async (_name, yaml) => {
        const c = await makeCore(permissions);
        await makeProject(path.join(dirs.workspace, "app"), yaml);
        await expect(c.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({ code: "UNSAFE_COMPOSE" });
        expect(fake.launched).toEqual([]);
        expect(lastAudit()).toMatchObject({ operation: "docker.compose_config", outcome: "error" });
      });

      it.each([
        ["privileged", { privileged: true }],
        ["build", { build: { context: "." } }],
        ["cap_add", { cap_add: ["SYS_ADMIN"] }],
        ["devices", { devices: [{ source: "/dev/sda", target: "/dev/sda", permissions: "rwm" }] }],
        ["host network", { network_mode: "host" }],
        ["host pid", { pid: "host" }],
        ["host user namespace", { userns_mode: "host" }],
        ["seccomp unconfined", { security_opt: ["seccomp=unconfined"] }],
        ["a container's volumes", { volumes_from: ["container:other"] }],
        ["the Docker API socket", { use_api_socket: true }],
        ["a pull policy", { pull_policy: "always" }],
        ["a logging driver", { logging: { driver: "syslog" } }],
        ["a Compose label", { labels: { "com.docker.compose.project.working_dir": "/elsewhere" } }],
        ["an npipe mount", { volumes: [{ type: "npipe", source: "\\\\.\\pipe\\docker_engine", target: "/x" }] }],
        [
          "shared propagation",
          { volumes: [{ type: "bind", source: "/x", target: "/x", bind: { propagation: "rshared" } }] },
        ],
      ])(`${mode}: refuses a service with %s`, async (_name, extra) => {
        const c = await makeCore(permissions);
        const app = await makeProject(path.join(dirs.workspace, "app"));
        scriptCompose({ model: webModel(app, extra) });
        await expect(c.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({ code: "UNSAFE_COMPOSE" });
        expect(fake.launched.some((a) => a.includes("up"))).toBe(false);
      });

      it(`${mode}: refuses a volume driver that mounts host data`, async () => {
        const c = await makeCore(permissions);
        const app = await makeProject(path.join(dirs.workspace, "app"));
        scriptCompose({
          model: webModel(
            app,
            { volumes: [{ type: "volume", source: "etc", target: "/etc-host", volume: {} }] },
            {
              volumes: {
                etc: { name: "demo_etc", driver: "local", driver_opts: { type: "none", o: "bind", device: "/etc" } },
              },
            },
          ),
        });
        await expect(c.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({ code: "UNSAFE_COMPOSE" });
      });
    }

    it("refuses env_file paths built from variables", async () => {
      const c = await makeCore(SANDBOX_WITH_DOCKER);
      const app = await makeProject(path.join(dirs.workspace, "app"));
      scriptCompose({
        raw: {
          services: { web: { image: "nginx", env_file: [{ path: "${HOME}/.aws/credentials", required: true }] } },
        },
        model: webModel(app),
      });
      await expect(c.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({ code: "UNSAFE_COMPOSE" });
      expect(fake.launched).toHaveLength(1);
    });
  });

  it("refuses unknown services and a missing compose file", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    const app = await makeProject(path.join(dirs.workspace, "app"));
    scriptCompose({ model: webModel(app) });
    await expect(c.docker.composeUp(ctx, { cwd: "app", services: ["db"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await mkdir(path.join(dirs.workspace, "empty"));
    await expect(c.docker.composeUp(ctx, { cwd: "empty" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("docker.use: docker_compose_down", () => {
  it("stops a workspace project by name without loading any Compose file", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    const app = path.join(dirs.workspace, "app");
    await mkdir(app);
    fake.respond = (args) => (args[0] === "ps" ? { stdout: `${JSON.stringify(app)}\n${JSON.stringify(app)}\n` } : {});
    const result = await c.docker.composeDown(ctx, { project: "demo" });
    expect(result).toMatchObject({ project: "demo", projectDirectories: ["app"] });
    const [ps, down] = fake.launched;
    expect(ps!.slice(0, 5)).toEqual(["ps", "--all", "--no-trunc", "--filter", "label=com.docker.compose.project=demo"]);
    expect(down).toEqual([
      "compose",
      "-p",
      "demo",
      "--project-directory",
      expect.any(String),
      "--env-file",
      expect.any(String),
      "-f",
      expect.any(String),
      "down",
      "--remove-orphans",
    ]);
    expect(down![4]!.startsWith(dirs.workspace)).toBe(false);
    expect(JSON.parse(readFileSync(down![8]!, "utf8"))).toEqual({ services: {} });
    expect(down).not.toContain("--volumes");
    expect(down).not.toContain("--rmi");
    expect(lastAudit()).toMatchObject({ operation: "docker.compose_down", outcome: "success", paths: [app] });
  });

  it("denies a project outside the workspace in sandbox and allows it in full_control", async () => {
    const outsideApp = path.join(dirs.outside, "app");
    const sandbox = await makeCore(SANDBOX_WITH_DOCKER);
    fake.respond = (args) => (args[0] === "ps" ? { stdout: `${JSON.stringify(outsideApp)}\n` } : {});
    await expect(sandbox.docker.composeDown(ctx, { project: "other" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(fake.launched.some((a) => a[0] === "compose")).toBe(false);
    await sandbox.shutdown();

    const full = await makeCore({ mode: "full_control" });
    await expect(full.docker.composeDown(ctx, { project: "other" })).resolves.toMatchObject({ project: "other" });
  });

  it("reports a project without containers as NOT_FOUND", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    fake.respond = () => ({ stdout: "" });
    await expect(c.docker.composeDown(ctx, { project: "ghost" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.launched).toHaveLength(1);
  });
});

describe("docker.use: Docker errors", () => {
  it("reports a missing Docker CLI as NOT_FOUND and audits the error", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    fake.missing = true;
    await expect(c.docker.ps(ctx, {})).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("Docker CLI"),
    });
    expect(lastAudit()).toMatchObject({ operation: "docker.ps", outcome: "error", error: { code: "NOT_FOUND" } });
  });

  it("reports an unreachable daemon as OPERATION_FAILED with Docker's message", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    fake.respond = () => ({
      code: 1,
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
    });
    await expect(c.docker.ps(ctx, {})).rejects.toMatchObject({
      code: "OPERATION_FAILED",
      message: expect.stringContaining("Cannot connect to the Docker daemon"),
      details: { exitCode: 1 },
    });
    expect(lastAudit()).toMatchObject({ outcome: "error" });
  });

  it("reports a failing compose up (e.g. a missing image) as OPERATION_FAILED and removes the model file", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    const app = await makeProject(path.join(dirs.workspace, "app"));
    const script = scriptCompose({
      model: webModel(app),
      up: { code: 18, stderr: "Error response from daemon: No such image: nginx:alpine\n" },
    });
    await expect(c.docker.composeUp(ctx, { cwd: "app" })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
      message: expect.stringContaining("No such image"),
    });
    expect(existsSync(script.upFile()!)).toBe(false);
  });

  it("times out a hanging Docker command and terminates it", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    fake.respond = () => ({ hang: true });
    await expect(c.docker.ps(ctx, { timeoutMs: 200 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("reports unparseable Docker output as OPERATION_FAILED", async () => {
    const c = await makeCore(SANDBOX_WITH_DOCKER);
    fake.respond = () => ({ stdout: "not json\n" });
    await expect(c.docker.ps(ctx, {})).rejects.toMatchObject({ code: "OPERATION_FAILED" });
  });
});
