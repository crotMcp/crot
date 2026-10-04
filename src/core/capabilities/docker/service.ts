import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuthContext } from "../../auth/principal.js";
import type { Limits } from "../../config/schema.js";
import { CrotError, fromNodeError, parseInput } from "../../errors.js";
import type { ExecutionGuard } from "../../execution/guard.js";
import type { Capability } from "../../permissions/capabilities.js";
import type { ManagedProcess, Platform } from "../../platform/types.js";
import { displayPath as display, type ResolvedPath, type Workspace } from "../../workspace/workspace.js";
import { reviewComposeModel, scanComposeSource } from "./compose-policy.js";
import {
  DockerComposeDownInputSchema,
  DockerComposeUpInputSchema,
  DockerLogsInputSchema,
  DockerPsInputSchema,
  PROJECT_NAME_PATTERN,
  type DockerComposeDownInput,
  type DockerComposeDownResult,
  type DockerComposeUpInput,
  type DockerComposeUpResult,
  type DockerContainer,
  type DockerLogsInput,
  type DockerLogsResult,
  type DockerPsInput,
  type DockerPsResult,
} from "./schemas.js";

export interface DockerServiceDeps {
  readonly workspace: Workspace;
  readonly guard: ExecutionGuard;
  readonly platform: Pick<Platform, "launcher" | "environment" | "baseEnvironment">;
  readonly limits: Pick<Limits, "defaultCommandTimeoutMs" | "maxCommandTimeoutMs" | "maxOutputBytes">;
  /**
   * Paths CROT itself depends on (audit log, configuration). A container may
   * never get write access to them through a bind mount.
   */
  readonly protectedPaths?: readonly string[];
  /** Base environment for Docker (defaults to the platform base environment). */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

/** Default Compose file names, in Docker Compose's lookup order. */
export const DEFAULT_COMPOSE_FILES: readonly string[] = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
];

/** Labels Docker Compose sets on every container it creates. */
const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";
const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";

const PS_FORMAT =
  `{"id":{{json .ID}},"names":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},` +
  `"status":{{json .Status}},"createdAt":{{json .CreatedAt}},"ports":{{json .Ports}},` +
  `"project":{{json (.Label "${PROJECT_LABEL}")}},"service":{{json (.Label "${SERVICE_LABEL}")}},` +
  `"workingDir":{{json (.Label "${WORKING_DIR_LABEL}")}}}`;
const INSPECT_FORMAT =
  `{"id":{{json .Id}},"project":{{json (index .Config.Labels "${PROJECT_LABEL}")}},` +
  `"workingDir":{{json (index .Config.Labels "${WORKING_DIR_LABEL}")}}}`;
const WORKING_DIR_FORMAT = `{{json (.Label "${WORKING_DIR_LABEL}")}}`;

/**
 * Environment variables passed to the Docker CLI (compared case-insensitively).
 * Everything else, including COMPOSE_* (which select files, projects and
 * profiles), is removed.
 */
const FORWARDED_ENV: ReadonlySet<string> = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "DOCKER_TLS",
  "DOCKER_API_VERSION",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
]);

const STDERR_MAX_BYTES = 64 * 1024;
const STDERR_IN_ERROR_CHARS = 2_000;
const OUTPUT_TAIL_CHARS = 8_000;
const STDIO_CLOSE_GRACE_MS = 500;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;

interface DockerRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

interface RunOptions {
  /** Capture limit for stderr (default 64 KiB; logs use the output limit). */
  readonly stderrMaxBytes?: number;
}

/** Paths and files of a Compose project, resolved before any Docker command runs. */
interface ComposeProject {
  readonly directory: ResolvedPath;
  readonly files: ResolvedPath[];
  readonly dotenv: ResolvedPath | undefined;
}

/**
 * docker.use capability of CROT Core (ARCHITECTURE.md §27, AD-3).
 *
 * Four fixed operations: list containers, read container logs, and start or
 * stop a Compose project. The Docker CLI is taken from PATH only, started
 * without a shell, with fixed subcommands and options; agent-supplied values
 * are validated names passed after '--'. There is no way to run another
 * Docker command, a shell, build, pull, push or `docker run`.
 *
 * Scope follows the PermissionEngine's filesystem perimeter: a container
 * belongs to the workspace when the Compose project directory recorded on it
 * is inside the workspace. Containers outside it, Compose files, env files and
 * every host path a project mounts are authorized like any other path, so in
 * sandbox mode they must be inside the workspace and in full_control mode they
 * may be anywhere. A Compose project must also pass the Compose policy
 * (compose-policy.ts) in every mode.
 */
export class DockerService {
  private readonly running = new Set<ManagedProcess>();
  private closing = false;
  private privateDir: Promise<PrivateDir> | undefined;
  private privateDirPath: string | undefined;

  constructor(private readonly deps: DockerServiceDeps) {}

  /** `docker ps`: containers of Compose projects in the workspace, or every container (scope "all"). */
  async ps(context: AuthContext, input: DockerPsInput): Promise<DockerPsResult> {
    const args = parseInput(DockerPsInputSchema, input);
    const timeout = this.timeout(args.timeoutMs);
    const capability: Capability | Capability[] =
      args.scope === "all" ? ["docker.use", "filesystem.full"] : "docker.use";
    return this.deps.guard.run(
      context,
      {
        operation: "docker.ps",
        capability,
        details: { scope: args.scope, project: args.project ?? null, timeoutMs: timeout },
      },
      async () => {
        const deadline = Date.now() + timeout;
        const dockerArgs = ["ps", "--all", "--no-trunc", "--format", PS_FORMAT];
        if (args.project) dockerArgs.push("--filter", `label=${PROJECT_LABEL}=${args.project}`);
        const run = await this.runDocker(dockerArgs, deadline);
        const containers: DockerContainer[] = [];
        for (const row of parseJsonLines(run.stdout, run.truncated)) {
          if (!isRecord(row)) continue;
          const workingDir = await this.resolveLabelPath(row.workingDir);
          if (args.scope === "workspace" && !workingDir?.insideWorkspace) continue;
          containers.push({
            id: str(row.id),
            names: str(row.names),
            image: str(row.image),
            state: str(row.state),
            status: str(row.status),
            createdAt: str(row.createdAt),
            ports: str(row.ports),
            project: str(row.project) || null,
            service: str(row.service) || null,
            projectDirectory: workingDir ? display(workingDir) : str(row.workingDir) || null,
          });
        }
        return { scope: args.scope, containers, truncated: run.truncated };
      },
    );
  }

  /**
   * `docker logs` of one container. The container is first identified
   * (docker.use); reading its logs is then authorized against its Compose
   * project directory, or needs filesystem.full when it has none.
   */
  async logs(context: AuthContext, input: DockerLogsInput): Promise<DockerLogsResult> {
    const args = parseInput(DockerLogsInputSchema, input);
    const timeout = this.timeout(args.timeoutMs);
    const deadline = Date.now() + timeout;
    const target = await this.deps.guard.run(
      context,
      { operation: "docker.inspect", capability: "docker.use", details: { container: args.container } },
      async () => {
        const run = await this.runDocker(
          ["inspect", "--type", "container", "--format", INSPECT_FORMAT, "--", args.container],
          deadline,
        ).catch((error: unknown) => {
          throw notFoundIf(error, /no such (container|object)/i, `Container not found: ${args.container}`);
        });
        const rows = parseJsonLines(run.stdout, run.truncated);
        const row = rows.length === 1 ? rows[0] : undefined;
        if (!isRecord(row) || !CONTAINER_ID_PATTERN.test(str(row.id))) {
          throw new CrotError("OPERATION_FAILED", `Docker returned an unexpected description of ${args.container}.`);
        }
        return { id: str(row.id), project: str(row.project) || null, workingDir: str(row.workingDir) };
      },
    );
    const workingDir = await this.resolveLabelPath(target.workingDir);
    return this.deps.guard.run(
      context,
      {
        operation: "docker.logs",
        capability: workingDir ? "docker.use" : ["docker.use", "filesystem.full"],
        paths: workingDir ? [workingDir] : [],
        details: {
          container: args.container,
          id: target.id,
          project: target.project,
          tail: args.tail,
          timestamps: args.timestamps,
          timeoutMs: timeout,
        },
      },
      async () => {
        const dockerArgs = ["logs", "--tail", String(args.tail)];
        if (args.timestamps) dockerArgs.push("--timestamps");
        dockerArgs.push("--", target.id);
        const run = await this.runDocker(dockerArgs, deadline, { stderrMaxBytes: this.deps.limits.maxOutputBytes });
        return { container: args.container, stdout: run.stdout, stderr: run.stderr, truncated: run.truncated };
      },
    );
  }

  /**
   * `docker compose up --detach --pull never --no-build`, in three audited
   * steps: (1) the Compose files are scanned and the env files they name are
   * listed, (2) Compose builds the model, which must pass the Compose policy,
   * (3) the reviewed model, with every host path replaced by the canonical
   * path CROT authorized, is written to a CROT-private file and started from
   * there, so Compose reads nothing that was not authorized and reviewed.
   */
  async composeUp(context: AuthContext, input: DockerComposeUpInput): Promise<DockerComposeUpResult> {
    const args = parseInput(DockerComposeUpInputSchema, input);
    const timeout = this.timeout(args.timeoutMs);
    const deadline = Date.now() + timeout;
    const project = await this.resolveComposeProject(args.cwd, args.files);
    const projectArgs = args.projectName ? ["-p", args.projectName] : [];
    const details = {
      cwd: display(project.directory),
      files: project.files.map(display),
      projectName: args.projectName ?? null,
      services: args.services,
      timeoutMs: timeout,
    };
    const base = [project.directory, ...project.files, ...(project.dotenv ? [project.dotenv] : [])];

    // Step 1: scan the files, list their env files (without interpolation, nothing else is read).
    const envFiles = await this.deps.guard.run(
      context,
      {
        operation: "docker.compose_config",
        capability: "docker.use",
        paths: base,
        details: { ...details, step: "files" },
      },
      async () => {
        await assertDirectory(project.directory);
        for (const file of project.files) {
          let data: Buffer;
          try {
            data = await readFile(file.absolute);
          } catch (error) {
            throw fromNodeError(error, `Cannot read Compose file ${display(file)}`);
          }
          scanComposeSource(data, display(file));
        }
        const dir = await this.dirs();
        const run = await this.runDocker(
          [
            "compose",
            ...projectArgs,
            ...this.composeFileArgs(project, dir),
            "config",
            "--format",
            "json",
            "--no-interpolate",
            "--no-normalize",
          ],
          deadline,
        );
        return this.envFilesOf(parseModel(run));
      },
    );

    // Step 2: build and review the model (reads the env files authorized here).
    const configPaths = dedupe([...base, ...envFiles]);
    const { model, review } = await this.deps.guard.run(
      context,
      {
        operation: "docker.compose_config",
        capability: "docker.use",
        paths: configPaths,
        details: { ...details, step: "model", envFiles: envFiles.map(display) },
      },
      async () => {
        const dir = await this.dirs();
        const run = await this.runDocker(
          ["compose", ...projectArgs, ...this.composeFileArgs(project, dir), "config", "--format", "json"],
          deadline,
        );
        const model = parseModel(run);
        return { model, review: reviewComposeModel(model) };
      },
    );

    const projectName = args.projectName ?? review.name;
    if (projectName === undefined || !PROJECT_NAME_PATTERN.test(projectName)) {
      throw new CrotError(
        "INVALID_INPUT",
        `Cannot use the Compose project name ${JSON.stringify(projectName ?? "")}; pass a valid projectName.`,
      );
    }
    const unknown = args.services.filter((s) => !review.services.includes(s));
    if (unknown.length > 0) {
      throw new CrotError("INVALID_INPUT", `Unknown Compose services: ${unknown.join(", ")}`);
    }
    const hostPaths: ResolvedPath[] = [];
    for (const hostPath of review.hostPaths) {
      if (!this.deps.workspace.rules.isAbsolute(hostPath.source)) {
        throw new CrotError("UNSAFE_COMPOSE", `${hostPath.where}: host path is not absolute: ${hostPath.source}`);
      }
      const resolved = await this.deps.workspace.resolve(hostPath.source);
      if (!hostPath.readOnly) this.refuseProtected(resolved, hostPath.where);
      hostPath.replace(resolved.absolute);
      hostPaths.push(resolved);
    }

    // Step 3: start the reviewed model.
    return this.deps.guard.run(
      context,
      {
        operation: "docker.compose_up",
        capability: review.external.length > 0 ? ["docker.use", "filesystem.full"] : "docker.use",
        paths: dedupe([...configPaths, ...hostPaths]),
        details: {
          ...details,
          project: projectName,
          hostPaths: hostPaths.map(display),
          ...(review.external.length > 0 ? { external: review.external } : {}),
        },
      },
      async () => {
        const dir = await this.dirs();
        const work = await mkdtemp(path.join(dir.path, "up-"));
        try {
          const file = path.join(work, "compose.json");
          await writeFile(file, JSON.stringify(model), { flag: "wx", mode: 0o600 });
          const run = await this.runDocker(
            [
              "compose",
              "-p",
              projectName,
              "--project-directory",
              project.directory.absolute,
              "--env-file",
              dir.emptyEnv,
              "-f",
              file,
              "up",
              "--detach",
              "--pull",
              "never",
              "--no-build",
              "--",
              ...args.services,
            ],
            deadline,
          );
          return {
            project: projectName,
            projectDirectory: display(project.directory),
            files: project.files.map(display),
            services: args.services.length > 0 ? args.services : review.services,
            output: tail(`${run.stderr}${run.stdout}`),
          };
        } finally {
          await rm(work, { recursive: true, force: true });
        }
      },
    );
  }

  /**
   * `docker compose down` of a project, identified by name. Its project
   * directories are read from its containers and authorized like any other
   * path. Compose runs with an empty model (`--remove-orphans`), so no Compose
   * file is looked up: the project's containers are stopped and removed;
   * volumes and images are kept.
   */
  async composeDown(context: AuthContext, input: DockerComposeDownInput): Promise<DockerComposeDownResult> {
    const args = parseInput(DockerComposeDownInputSchema, input);
    const timeout = this.timeout(args.timeoutMs);
    const deadline = Date.now() + timeout;
    const labels = await this.deps.guard.run(
      context,
      {
        operation: "docker.compose_ps",
        capability: "docker.use",
        details: { project: args.project, timeoutMs: timeout },
      },
      async () => {
        const run = await this.runDocker(
          [
            "ps",
            "--all",
            "--no-trunc",
            "--filter",
            `label=${PROJECT_LABEL}=${args.project}`,
            "--format",
            WORKING_DIR_FORMAT,
          ],
          deadline,
        );
        if (run.truncated) throw new CrotError("LIMIT_EXCEEDED", "Docker output exceeded the output limit.");
        return parseJsonLines(run.stdout, false).map(str);
      },
    );
    if (labels.length === 0) {
      throw new CrotError("NOT_FOUND", `No containers of Compose project '${args.project}' were found.`);
    }
    const directories: ResolvedPath[] = [];
    let unscoped = false;
    for (const label of new Set(labels)) {
      const resolved = await this.resolveLabelPath(label);
      if (resolved) directories.push(resolved);
      else unscoped = true;
    }
    return this.deps.guard.run(
      context,
      {
        operation: "docker.compose_down",
        capability: unscoped ? ["docker.use", "filesystem.full"] : "docker.use",
        paths: dedupe(directories),
        details: { project: args.project, projectDirectories: directories.map(display), timeoutMs: timeout },
      },
      async () => {
        const dir = await this.dirs();
        const run = await this.runDocker(
          [
            "compose",
            "-p",
            args.project,
            "--project-directory",
            dir.path,
            "--env-file",
            dir.emptyEnv,
            "-f",
            dir.emptyModel,
            "down",
            "--remove-orphans",
          ],
          deadline,
        );
        return {
          project: args.project,
          projectDirectories: directories.map(display),
          output: tail(`${run.stderr}${run.stdout}`),
        };
      },
    );
  }

  /** Stop accepting operations and terminate running Docker commands. */
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.running].map((p) => p.terminate("force")));
    const dir = await this.privateDir?.catch(() => undefined);
    if (dir) await rm(dir.path, { recursive: true, force: true });
  }

  /** Forced, synchronous termination of running Docker commands (host process exit). */
  terminateAllSync(): void {
    this.closing = true;
    for (const p of this.running) p.terminateSync();
    if (this.privateDirPath) {
      try {
        rmSync(this.privateDirPath, { recursive: true, force: true });
      } catch {
        // Best effort while the host process exits.
      }
    }
  }

  // -------------------------------------------------------------------------

  private async resolveComposeProject(cwd: string, files: readonly string[] | undefined): Promise<ComposeProject> {
    const { workspace } = this.deps;
    const directory = await workspace.resolve(cwd);
    const resolved: ResolvedPath[] = [];
    if (files) {
      for (const file of files) resolved.push(await workspace.resolve(file));
    } else {
      // Like Docker Compose's own lookup, but in the project directory only (never its parents).
      for (const name of DEFAULT_COMPOSE_FILES) {
        const candidate = await workspace.resolve(path.join(directory.absolute, name));
        if (await isFile(candidate.absolute)) {
          resolved.push(candidate);
          break;
        }
      }
      if (resolved.length === 0) {
        throw new CrotError(
          "NOT_FOUND",
          `No Compose file (${DEFAULT_COMPOSE_FILES.join(", ")}) in ${display(directory)}; pass 'files'.`,
        );
      }
    }
    const dotenvPath = await workspace.resolve(path.join(directory.absolute, ".env"));
    const dotenv = (await isFile(dotenvPath.absolute)) ? dotenvPath : undefined;
    return { directory, files: dedupe(resolved), dotenv };
  }

  /** Global Compose options naming exactly the files CROT authorized. */
  private composeFileArgs(project: ComposeProject, dir: PrivateDir): string[] {
    const args = [
      "--project-directory",
      project.directory.absolute,
      "--env-file",
      project.dotenv ? project.dotenv.absolute : dir.emptyEnv,
    ];
    for (const file of project.files) args.push("-f", file.absolute);
    return args;
  }

  /** env_file entries of a model built without interpolation. */
  private async envFilesOf(model: Record<string, unknown>): Promise<ResolvedPath[]> {
    const files: ResolvedPath[] = [];
    const services = isRecord(model.services) ? model.services : {};
    for (const [name, service] of Object.entries(services)) {
      if (!isRecord(service)) continue;
      if ("label_file" in service) {
        throw new CrotError("UNSAFE_COMPOSE", `services.${name}.label_file is not supported by docker.use.`);
      }
      const entries = service.env_file;
      if (entries === undefined || entries === null) continue;
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        const file = isRecord(entry) ? entry.path : entry;
        if (typeof file !== "string" || file.length === 0 || file.includes("$")) {
          throw new CrotError(
            "UNSAFE_COMPOSE",
            `services.${name}.env_file must be a literal path (no variables): ${JSON.stringify(file)}`,
          );
        }
        if (!this.deps.workspace.rules.isAbsolute(file)) {
          throw new CrotError(
            "UNSAFE_COMPOSE",
            `services.${name}.env_file did not resolve to an absolute path: ${file}`,
          );
        }
        files.push(await this.deps.workspace.resolve(file));
      }
    }
    return dedupe(files);
  }

  /** A Compose project directory label as a resolved path, or undefined when it is missing or not a valid absolute path. */
  private async resolveLabelPath(label: unknown): Promise<ResolvedPath | undefined> {
    if (typeof label !== "string" || label.length === 0) return undefined;
    try {
      if (!this.deps.workspace.rules.isAbsolute(label)) return undefined;
      return await this.deps.workspace.resolve(label);
    } catch {
      return undefined;
    }
  }

  /** A writable bind mount may not expose CROT's protected paths (audit log, configuration). */
  private refuseProtected(p: ResolvedPath, where: string): void {
    for (const guarded of this.deps.protectedPaths ?? []) {
      if (this.deps.workspace.contains(p.absolute, guarded)) {
        throw new CrotError(
          "PERMISSION_DENIED",
          `${where}: a writable mount would expose a path protected by CROT: ${guarded}. Mount it read-only or choose another path.`,
        );
      }
    }
  }

  private dirs(): Promise<PrivateDir> {
    this.privateDir ??= this.createPrivateDir().catch((error: unknown) => {
      this.privateDir = undefined;
      throw new CrotError("OPERATION_FAILED", `Failed to prepare the Docker environment: ${(error as Error).message}`);
    });
    return this.privateDir;
  }

  private async createPrivateDir(): Promise<PrivateDir> {
    // Working directory of every Docker command and home of the files CROT hands to Compose.
    // Private to the CROT user and removed on shutdown.
    const dir = await mkdtemp(path.join(os.tmpdir(), "crot-docker-"));
    this.privateDirPath = dir;
    const emptyEnv = path.join(dir, "empty.env");
    const emptyModel = path.join(dir, "empty.json");
    await writeFile(emptyEnv, "", { flag: "wx", mode: 0o600 });
    await writeFile(emptyModel, '{"services":{}}', { flag: "wx", mode: 0o600 });
    const { environment } = this.deps.platform;
    const base = this.deps.baseEnv ?? this.deps.platform.baseEnvironment;
    const forwarded: Record<string, string> = {};
    for (const [name, value] of Object.entries(base)) {
      if (value !== undefined && FORWARDED_ENV.has(name.toUpperCase())) forwarded[name] = value;
    }
    const env = environment.merge(forwarded, { DOCKER_CLI_HINTS: "false", COMPOSE_ANSI: "never", NO_COLOR: "1" });
    return { path: dir, emptyEnv, emptyModel, env };
  }

  private async runDocker(
    dockerArgs: readonly string[],
    deadline: number,
    options: RunOptions = {},
  ): Promise<DockerRun> {
    this.assertOpen();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CrotError("TIMEOUT", "Docker operation timed out.");
    const dir = await this.dirs();
    const { launcher } = this.deps.platform;
    let spec;
    try {
      // Never take docker from the workspace or the working directory.
      spec = await launcher.resolveCommand("docker", dockerArgs, {
        cwd: dir.path,
        env: dir.env,
        searchCurrentDirectory: false,
      });
    } catch (error) {
      if (error instanceof CrotError && error.code === "NOT_FOUND") {
        throw new CrotError(
          "NOT_FOUND",
          "The Docker CLI ('docker') was not found on PATH; docker.use needs it (and the Compose plugin for Compose operations).",
        );
      }
      throw error;
    }
    const proc = await launcher.launch(spec, { cwd: dir.path, env: dir.env, stdin: false });
    this.running.add(proc);
    try {
      if (this.closing) void proc.terminate("force");
      const max = this.deps.limits.maxOutputBytes;
      const stderrMax = options.stderrMaxBytes ?? STDERR_MAX_BYTES;
      const out: Buffer[] = [];
      let outBytes = 0;
      const err: Buffer[] = [];
      let errBytes = 0;
      let truncated = false;
      proc.stdout.on("data", (chunk: Buffer) => {
        if (truncated) return;
        const room = max - outBytes;
        if (chunk.length > room) {
          out.push(chunk.subarray(0, room));
          outBytes = max;
          truncated = true;
          void proc.terminate("force");
          return;
        }
        out.push(chunk);
        outBytes += chunk.length;
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        const room = stderrMax - errBytes;
        if (room <= 0) {
          if (options.stderrMaxBytes !== undefined && !truncated) {
            truncated = true;
            void proc.terminate("force");
          }
          return;
        }
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        err.push(part);
        errBytes += part.length;
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void proc.terminate("force");
      }, remaining);
      const status = await proc.exited;
      clearTimeout(timer);
      await Promise.race([Promise.all([ended(proc.stdout), ended(proc.stderr)]), delay(STDIO_CLOSE_GRACE_MS)]);
      await proc.terminate("force");
      proc.stdout.destroy();
      proc.stderr.destroy();
      const command = describe(dockerArgs);
      if (timedOut) throw new CrotError("TIMEOUT", `Docker operation timed out (${command}).`);
      if (this.closing && !truncated && status.code === null) throw shuttingDown();
      const stdout = new TextDecoder("utf-8").decode(Buffer.concat(out));
      const stderr = new TextDecoder("utf-8").decode(Buffer.concat(err));
      if (!truncated && status.code !== 0) {
        const message = stderr.trim();
        throw new CrotError(
          "OPERATION_FAILED",
          `${command} failed${status.code === null ? ` (${status.signal ?? "terminated"})` : ` with exit code ${status.code}`}${message ? `: ${message.slice(-STDERR_IN_ERROR_CHARS)}` : ""}`,
          { exitCode: status.code },
        );
      }
      return { stdout, stderr, truncated };
    } finally {
      this.running.delete(proc);
    }
  }

  private timeout(requested: number | undefined): number {
    const max = this.deps.limits.maxCommandTimeoutMs;
    if (requested !== undefined && requested > max) {
      throw new CrotError(
        "LIMIT_EXCEEDED",
        `Requested timeout ${requested}ms exceeds the configured maximum of ${max}ms.`,
      );
    }
    return requested ?? Math.min(this.deps.limits.defaultCommandTimeoutMs, max);
  }

  private assertOpen(): void {
    if (this.closing) throw shuttingDown();
  }
}

interface PrivateDir {
  readonly path: string;
  readonly emptyEnv: string;
  readonly emptyModel: string;
  readonly env: Record<string, string>;
}

/** "docker compose up", "docker ps", ... for messages (never agent-supplied values). */
function describe(args: readonly string[]): string {
  if (args[0] !== "compose") return `docker ${args[0] ?? ""}`;
  return `docker compose ${args.find((a) => COMPOSE_COMMANDS.has(a)) ?? ""}`.trim();
}

const COMPOSE_COMMANDS: ReadonlySet<string> = new Set(["config", "up", "down"]);

function parseModel(run: DockerRun): Record<string, unknown> {
  if (run.truncated) throw new CrotError("LIMIT_EXCEEDED", "The Compose model exceeds the output limit.");
  let model: unknown;
  try {
    model = JSON.parse(run.stdout);
  } catch {
    throw new CrotError("OPERATION_FAILED", "Docker Compose returned a model that is not valid JSON.");
  }
  if (!isRecord(model)) throw new CrotError("OPERATION_FAILED", "Docker Compose returned an unexpected model.");
  return model;
}

/** One JSON value per line; a line cut off by truncation is dropped. */
function parseJsonLines(output: string, truncated: boolean): unknown[] {
  const lines = output.split(/\r?\n/);
  if (truncated) lines.pop();
  const values: unknown[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      throw new CrotError("OPERATION_FAILED", "Docker returned output CROT cannot parse.");
    }
  }
  return values;
}

function notFoundIf(error: unknown, pattern: RegExp, message: string): unknown {
  if (error instanceof CrotError && error.code === "OPERATION_FAILED" && pattern.test(error.message)) {
    return new CrotError("NOT_FOUND", message);
  }
  return error;
}

async function assertDirectory(p: ResolvedPath): Promise<void> {
  let info;
  try {
    info = await stat(p.absolute);
  } catch (error) {
    throw fromNodeError(error, `Cannot access project directory ${display(p)}`);
  }
  if (!info.isDirectory()) throw new CrotError("INVALID_INPUT", `Not a directory: ${display(p)}`);
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw fromNodeError(error, `Cannot access ${file}`);
  }
}

function dedupe(paths: readonly ResolvedPath[]): ResolvedPath[] {
  const seen = new Set<string>();
  return paths.filter((p) => (seen.has(p.absolute) ? false : (seen.add(p.absolute), true)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL_CHARS ? trimmed.slice(-OUTPUT_TAIL_CHARS) : trimmed;
}

function shuttingDown(): CrotError {
  return new CrotError("OPERATION_FAILED", "CROT is shutting down; no new Docker commands are started.");
}

function ended(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    if ((stream as { readableEnded?: boolean }).readableEnded) return resolve();
    stream.once("end", () => resolve());
    stream.once("close", () => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
