/**
 * The CROT service (WP-20, ARCHITECTURE.md §27 AD-17).
 *
 * One long-running process per OS user owns Core, the Native Host, the browser
 * bridge and HTTP (later the device tunnel). Local clients reach it through
 * two authenticated endpoints in the user's private state directory:
 *
 * - the shim endpoint: each `crot-mcp` stdio process (thin shim) is one MCP
 *   connection with its own McpServer and therefore its own exposure scope
 *   (AD-12, AD-15 point 8);
 * - the control endpoint: owner tools (`crot-mcp service status|stop`, later
 *   the tray and its ApprovalProvider, WP-22). It carries no MCP and no tools.
 *
 * Exclusive ownership of the shim endpoint is the singleton guarantee: a
 * second service started at the same time loses the listen, exits, and never
 * touches the browser bridge. The shim endpoint is released last on shutdown
 * so that a successor never finds the bridge still owned.
 *
 * The service makes no permission decision: every tool call goes through Core
 * (PermissionEngine, ExecutionGuard, audit) exactly as before.
 */
import type net from "node:net";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_HTTP_TOKEN_FILE_NAME, LocalTokenVerifier, loadOrCreateLocalToken } from "../adapters/http/auth.js";
import { CrotHttpServer } from "../adapters/http/server.js";
import { localContextResolver } from "../adapters/mcp/context.js";
import { createCrotMcpServer } from "../adapters/mcp/server.js";
import type { BrowserBridge } from "../browser-bridge/server.js";
import { browserProtectedPaths, startBrowserBridge } from "../cli/browser.js";
import type { ServeCommand } from "../cli/options.js";
import { REMOTE_EXPOSURE_FILE_NAME } from "../core/approvals/index.js";
import { parseConfig } from "../core/config/load.js";
import { expandHome } from "../core/config/paths.js";
import { CORE_VERSION, CrotCore } from "../core/crot-core.js";
import { CrotError } from "../core/errors.js";
import type { ServiceStatus } from "../core/service-status.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import { NativeHost } from "../native-host/native-host.js";
import { acceptChannel, MAX_CLIENT_FRAME_BYTES, type AuthenticatedChannel } from "./channel.js";
import { configDigest } from "./config-digest.js";
import {
  fileCredentialStore,
  listenExclusive,
  serviceEndpoint,
  serviceProtectedPaths,
  stateDirectoryWarning,
  type CredentialStore,
  type ServiceEndpoint,
} from "./endpoints.js";
import {
  parseControlRequest,
  parseShimMessage,
  SERVICE_PROTOCOL_VERSION,
  type ControlRequest,
  type ControlStatus,
  type ServiceToShim,
} from "./protocol.js";
import { ResumeDetector } from "./resume-detector.js";
import { ChannelServerTransport } from "./transport.js";

/** An on-demand service stops this long after its last stdio client disconnected. */
export const DEFAULT_IDLE_EXIT_MS = 1_000;
/** An on-demand service that never gets a client (its shim died) stops after this. */
export const DEFAULT_FIRST_CLIENT_TIMEOUT_MS = 30_000;
const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
const MAX_STARTUP_LOG_LINES = 200;

export interface ServiceOptions {
  readonly command: ServeCommand;
  readonly launch: ServiceStatus["launch"];
  readonly stateDir: string;
  readonly privateFiles: PrivateFileProtection;
  /** Diagnostics of the service process (its stderr). Never receives credentials. */
  readonly log: (message: string) => void;
  /** Ask the host to stop the service (graceful shutdown through the host lifecycle). */
  readonly requestStop: (reason: string) => void;
  readonly credentials?: CredentialStore;
  readonly idleExitMs?: number;
  readonly firstClientTimeoutMs?: number;
  readonly windows?: boolean;
  /** Clock and interval of the sleep/wake detector (tests). */
  readonly resume?: { readonly intervalMs?: number; readonly thresholdMs?: number; readonly now?: () => number };
}

interface ShimClient {
  readonly channel: AuthenticatedChannel;
  transport?: ChannelServerTransport;
  close?: () => Promise<void>;
}

export class CrotService {
  private state: ServiceStatus["state"] = "starting";
  private readonly startedAt = Date.now();
  private readonly startupLogs: string[] = [];
  private readonly shims = new Set<ShimClient>();
  private readonly controls = new Set<AuthenticatedChannel>();
  private readonly pendingSockets = new Set<net.Socket>();
  private serviceServer: net.Server | undefined;
  private controlServer: net.Server | undefined;
  private serviceSocketIno: number | undefined;
  private controlSocketIno: number | undefined;
  private credentials: { service: string; control: string } | undefined;
  private endpoints: { service: ServiceEndpoint; control: ServiceEndpoint } | undefined;
  private native: NativeHost | undefined;
  private bridge: BrowserBridge | undefined;
  private coreInstance: CrotCore | undefined;
  private http: CrotHttpServer | undefined;
  private digest = "";
  private idleTimer: NodeJS.Timeout | undefined;
  private resumes = 0;
  private lastResumeAt: string | undefined;
  private readonly detector: ResumeDetector;
  private readonly ready: Promise<void>;
  private markReady!: () => void;
  private stopping: Promise<void> | undefined;
  private verifying = false;

  private constructor(private readonly options: ServiceOptions) {
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    this.detector = new ResumeDetector({
      ...options.resume,
      onResume: (gap) => this.onResume(gap),
      // Health: the endpoints are re-checked periodically as well, not only after a resume.
      onTick: () => void this.verifyEndpoints(),
    });
  }

  /**
   * Start the service. Resolves to "already_running" when another service of
   * this user owns the endpoint (nothing else was started then).
   */
  static async start(options: ServiceOptions): Promise<CrotService | "already_running"> {
    const service = new CrotService(options);
    return (await service.claimEndpoints()) ? (await service.startRuntime(), service) : "already_running";
  }

  get core(): CrotCore {
    if (!this.coreInstance) throw new Error("CROT service not started");
    return this.coreInstance;
  }

  get httpUrl(): string | undefined {
    return this.http?.url;
  }

  /** State reported in crot_status and on the control channel. */
  status(): ServiceStatus {
    return {
      state: this.state,
      pid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeMs: Date.now() - this.startedAt,
      launch: this.options.launch,
      clients: { stdio: [...this.shims].filter((s) => s.transport).length, control: this.controls.size },
      endpoints: { kind: this.endpoints?.service.kind ?? (this.windows ? "named-pipe" : "unix-socket") },
      http: this.http
        ? { enabled: true, url: this.http.url, sessionless: this.http.sessionlessLoad }
        : { enabled: false },
      power: { resumes: this.resumes, ...(this.lastResumeAt ? { lastResumeAt: this.lastResumeAt } : {}) },
    };
  }

  private get windows(): boolean {
    return this.options.windows ?? process.platform === "win32";
  }

  private log(message: string): void {
    this.options.log(message);
    if (this.state === "starting") {
      if (this.startupLogs.length < MAX_STARTUP_LOG_LINES) this.startupLogs.push(message);
      return;
    }
    // Runtime diagnostics reach every connected shim's stderr (MCP client logs).
    for (const shim of this.shims) if (shim.transport) shim.channel.send({ t: "log", line: message });
  }

  /** Credentials and both endpoints. The shim endpoint first: it is the singleton lock. */
  private async claimEndpoints(): Promise<boolean> {
    const { stateDir, privateFiles } = this.options;
    const store = this.options.credentials ?? fileCredentialStore(stateDir, privateFiles);
    await privateFiles.ensureDirectory(stateDir);
    const warning = await stateDirectoryWarning(stateDir);
    if (warning) this.log(`warning: ${warning}`);
    const service = await store.readOrCreate("service");
    const control = await store.readOrCreate("control");
    this.credentials = { service, control };
    this.endpoints = {
      service: serviceEndpoint(stateDir, "service", service, this.windows),
      control: serviceEndpoint(stateDir, "control", control, this.windows),
    };
    const shimServer = await listenExclusive(this.endpoints.service, (s) => this.onShimSocket(s));
    if (shimServer === "in_use") return false;
    this.serviceServer = shimServer;
    // A predecessor releases the control endpoint before the shim endpoint, so it is free now; retry briefly anyway.
    let controlServer: net.Server | "in_use" = "in_use";
    for (let attempt = 0; attempt < 20 && controlServer === "in_use"; attempt++) {
      controlServer = await listenExclusive(this.endpoints.control, (s) => this.onControlSocket(s));
      if (controlServer === "in_use") await new Promise((r) => setTimeout(r, 100));
    }
    if (controlServer === "in_use") {
      await closeServer(shimServer);
      throw new CrotError("OPERATION_FAILED", "The CROT control endpoint is in use by another process.");
    }
    this.controlServer = controlServer;
    this.serviceSocketIno = await this.socketIno(this.endpoints.service);
    this.controlSocketIno = await this.socketIno(this.endpoints.control);
    return true;
  }

  private async socketIno(endpoint: ServiceEndpoint): Promise<number | undefined> {
    if (endpoint.kind !== "unix-socket") return undefined;
    return (await lstat(endpoint.path).catch(() => undefined))?.ino;
  }

  /** Native Host, browser bridge, Core and HTTP, as `crot-mcp` did before WP-20. */
  private async startRuntime(): Promise<void> {
    const { command, stateDir } = this.options;
    const log = (m: string) => this.log(m);
    try {
      const parsed = parseConfig(command.config);
      this.digest = configDigest(command.configFile ?? "", command.config);
      const http = parsed.http;
      const tokenFile = http.enabled
        ? path.resolve(expandHome(http.auth.tokenFile ?? path.join(stateDir, DEFAULT_HTTP_TOKEN_FILE_NAME)))
        : undefined;
      // Persisted exposure of remote principals (AD-15): only HTTP (later the tunnel) carries remote principals.
      const remoteExposureFile = http.enabled ? path.join(stateDir, REMOTE_EXPOSURE_FILE_NAME) : undefined;
      // Configuration, HTTP token, bridge token, service credentials and the service log are never modifiable through CROT tools.
      const protectedPaths = [
        command.configFile,
        tokenFile,
        ...browserProtectedPaths(parsed.browser.enabled, stateDir),
        ...serviceProtectedPaths(stateDir),
      ].filter((p): p is string => p !== undefined);

      // Native resources first; Core is built on the Native Host platform.
      this.native = await NativeHost.start({ startupPath: parsed.environment.path });
      for (const note of this.native.status().notes) log(`note: native host: ${note}`);
      // The browser bridge never stops CROT: when it cannot start, CROT runs without it.
      this.bridge = await startBrowserBridge({
        enabled: parsed.browser.enabled,
        stateDir,
        privateFiles: this.native.platform.privateFiles,
        log,
      });
      this.coreInstance = await CrotCore.create(command.config, {
        protectedPaths,
        ...(remoteExposureFile ? { remoteExposureFile } : {}),
        platform: this.native.platform,
        ...(this.bridge ? { browser: this.bridge } : {}),
        serviceStatus: () => this.status(),
      });
      this.banner();
      if (tokenFile !== undefined) await this.startHttp(http, tokenFile);
      log(
        `service: ${this.options.launch}, pid ${process.pid}, local endpoints: ${this.endpoints!.service.kind} (owner only, authenticated)`,
      );
    } catch (error) {
      await this.releaseRuntime();
      throw error;
    }
    this.state = "running";
    this.detector.start();
    this.markReady();
    if (this.options.launch === "on-demand" && !this.http) {
      this.armIdleTimer(this.options.firstClientTimeoutMs ?? DEFAULT_FIRST_CLIENT_TIMEOUT_MS, "no client connected");
    }
  }

  private banner(): void {
    const log = (m: string) => this.log(m);
    const core = this.core;
    const status = core.status();
    log(`CROT ${status.version} — mode: ${status.mode}, workspace: ${status.workspace.root}`);
    log(
      `platform: ${status.platform.os} ${status.platform.arch}, shells: ${status.platform.shells.map((s) => s.id).join(", ")}`,
    );
    const control = core.platform.info.processControl;
    log(
      `native host: process trees ${control.treeTermination}, private files ${core.platform.info.privateFiles.mechanism}`,
    );
    const startupPath = status.platform.startupPath;
    if (startupPath.source === "login-shell" || startupPath.added.length > 0) {
      log(
        `PATH: ${startupPath.source === "login-shell" ? `from login shell ${startupPath.shell}` : "inherited"}, ${startupPath.added.length} entries added`,
      );
    }
    if (startupPath.note) log(`warning: PATH: ${startupPath.note}; using the inherited PATH`);
    if (status.mode === "full_control") {
      log("WARNING: FULL CONTROL mode — the connected agent can access everything this process can.");
    }
    log(`audit: ${status.audit.sink}${status.audit.path ? ` (${status.audit.path})` : ""}`);
    const protection = status.audit.protection;
    if (protection && protection.ownerOnly === false) log(`warning: audit log ${protection.detail}`);
    if (protection && protection.ownerOnly === null) log(`note: audit log ${protection.detail}`);
    log(`browser: ${status.browser.state}`);
  }

  private async startHttp(http: ReturnType<typeof parseConfig>["http"], tokenFile: string): Promise<void> {
    const core = this.core;
    const log = (m: string) => this.log(m);
    const { token, created } = await loadOrCreateLocalToken(tokenFile, core.platform.privateFiles);
    const verifier = new LocalTokenVerifier(token);
    log(
      `http: access token ${created ? "created in" : "read from"} ${tokenFile} (fingerprint ${verifier.fingerprint})`,
    );
    const tokenProtection = await core.platform.privateFiles.inspect(tokenFile);
    if (tokenProtection.ownerOnly === false) log(`warning: HTTP token file ${tokenProtection.detail}`);
    if (tokenProtection.ownerOnly === null) log(`note: HTTP token file ${tokenProtection.detail}`);
    this.http = await CrotHttpServer.start(core, { config: http, verifier, log });
    log(`http: listening on ${this.http.url} (loopback only; bearer token required)`);
  }

  // ---- shim connections -------------------------------------------------------------------------

  private onShimSocket(socket: net.Socket): void {
    if (this.state === "stopping") {
      socket.destroy();
      return;
    }
    this.pendingSockets.add(socket);
    acceptChannel(socket, {
      channel: "service",
      credential: this.credentials!.service,
      maxFrameBytes: MAX_CLIENT_FRAME_BYTES,
    }).then(
      (channel) => {
        this.pendingSockets.delete(socket);
        this.attachShim(channel);
      },
      (error: unknown) => {
        this.pendingSockets.delete(socket);
        this.log(`service: rejected a local connection (${error instanceof Error ? error.message : String(error)})`);
      },
    );
  }

  private attachShim(channel: AuthenticatedChannel): void {
    if (this.state === "stopping") {
      channel.destroy();
      return;
    }
    const shim: ShimClient = { channel };
    this.shims.add(shim);
    // Messages are handled strictly in order; MCP lines wait until the hello is accepted.
    let queue = Promise.resolve();
    channel.onmessage = (value) => {
      queue = queue.then(() => this.onShimMessage(shim, value)).catch(() => channel.destroy());
    };
    channel.onclose = () => {
      queue = queue.then(() => this.detachShim(shim));
    };
    channel.start();
  }

  private async onShimMessage(shim: ShimClient, value: unknown): Promise<void> {
    const message = parseShimMessage(value);
    if (!message) {
      shim.channel.destroy();
      return;
    }
    if (!shim.transport) {
      if (message.t !== "hello") return shim.channel.destroy();
      await this.ready;
      return this.welcome(shim, message);
    }
    if (message.t === "mcp") shim.transport.receiveLine(message.line);
    else if (message.t === "bye") shim.channel.close();
    else shim.channel.destroy();
  }

  private refuse(shim: ShimClient, reason: Extract<ServiceToShim, { t: "refused" }>["reason"], message: string): void {
    shim.channel.send({ t: "refused", reason, message } satisfies ServiceToShim);
    shim.channel.close();
  }

  private async welcome(
    shim: ShimClient,
    hello: { readonly version: number; readonly configDigest: string },
  ): Promise<void> {
    if (hello.version !== SERVICE_PROTOCOL_VERSION) {
      return this.refuse(
        shim,
        "version_mismatch",
        `The running CROT service (version ${CORE_VERSION}, pid ${process.pid}) speaks another shim protocol; stop it with 'crot-mcp service stop' and retry.`,
      );
    }
    if (this.state !== "running") return this.refuse(shim, "shutting_down", "The CROT service is shutting down.");
    if (hello.configDigest !== this.digest) {
      if (this.options.launch === "on-demand" && !this.http && this.activeShims() === 0) {
        // Nobody uses this on-demand service: make room for one with the client's configuration.
        this.refuse(shim, "restarting", "The CROT service restarts with the new configuration.");
        this.options.requestStop("configuration changed");
        return;
      }
      return this.refuse(
        shim,
        "config_mismatch",
        `A CROT service with a different configuration or version is already running (pid ${process.pid}, ${this.options.launch}, workspace ${this.core.workspace.root}). ` +
          "All stdio clients of a user share one service: use the same configuration (config file and flags) in every MCP client, or stop the service with 'crot-mcp service stop'.",
      );
    }
    const server = createCrotMcpServer(this.core, { resolveContext: localContextResolver("stdio") });
    const transport = new ChannelServerTransport(shim.channel);
    await server.connect(transport);
    shim.transport = transport;
    shim.close = async () => {
      try {
        await server.close();
      } catch {
        // Already closed.
      }
    };
    this.disarmIdleTimer();
    shim.channel.send({
      t: "welcome",
      service: { pid: process.pid, version: CORE_VERSION, launch: this.options.launch },
      logs: [...this.startupLogs],
    } satisfies ServiceToShim);
  }

  private activeShims(): number {
    let n = 0;
    for (const s of this.shims) if (s.transport) n++;
    return n;
  }

  private async detachShim(shim: ShimClient): Promise<void> {
    if (!this.shims.delete(shim)) return;
    await shim.close?.();
    if (shim.transport && this.activeShims() === 0 && this.options.launch === "on-demand" && !this.http) {
      this.armIdleTimer(this.options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS, "last client disconnected");
    }
  }

  private armIdleTimer(ms: number, reason: string): void {
    this.disarmIdleTimer();
    if (this.state !== "running") return;
    this.idleTimer = setTimeout(() => {
      if (this.activeShims() === 0 && this.pendingSockets.size === 0) this.options.requestStop(reason);
    }, ms);
  }

  private disarmIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  // ---- control channel --------------------------------------------------------------------------

  private onControlSocket(socket: net.Socket): void {
    if (this.state === "stopping") {
      socket.destroy();
      return;
    }
    acceptChannel(socket, {
      channel: "control",
      credential: this.credentials!.control,
      maxFrameBytes: MAX_CONTROL_FRAME_BYTES,
    }).then(
      (channel) => {
        this.controls.add(channel);
        channel.onmessage = (value) => void this.onControlMessage(channel, value);
        channel.onclose = () => this.controls.delete(channel);
        channel.start();
      },
      (error: unknown) =>
        this.log(`control: rejected a connection (${error instanceof Error ? error.message : String(error)})`),
    );
  }

  private async onControlMessage(channel: AuthenticatedChannel, value: unknown): Promise<void> {
    const request = parseControlRequest(value);
    if (!request) {
      channel.destroy();
      return;
    }
    await this.ready;
    channel.send({ t: "response", id: request.id, result: this.controlResult(request) });
    if (request.method === "shutdown") {
      await channel.drained();
      this.options.requestStop("control: shutdown requested");
    }
  }

  private controlResult(request: ControlRequest): unknown {
    switch (request.method) {
      case "ping":
        return { pid: process.pid, state: this.state };
      case "status": {
        const core = this.core.status();
        return {
          service: this.status(),
          version: core.version,
          mode: core.mode,
          workspace: core.workspace.root,
          browser: core.browser.state,
        } satisfies ControlStatus;
      }
      case "shutdown":
        return { stopping: true, pid: process.pid };
    }
  }

  // ---- sleep / wake ----------------------------------------------------------------------------

  private onResume(gapMs: number): void {
    this.resumes++;
    this.lastResumeAt = new Date().toISOString();
    this.log(
      `service: resumed after about ${Math.round(gapMs / 1000)} s (system sleep or clock change); checking endpoints`,
    );
    void this.verifyEndpoints();
  }

  /**
   * After a resume: a POSIX socket file can be gone (cleaned /tmp-like state,
   * removed by hand). Re-create it; if another process owns it now, stop so
   * that only one service remains.
   */
  async verifyEndpoints(): Promise<void> {
    if (this.state !== "running" || !this.endpoints || this.verifying) return;
    this.verifying = true;
    try {
      await this.verifyEndpointsOnce();
    } finally {
      this.verifying = false;
    }
  }

  private async verifyEndpointsOnce(): Promise<void> {
    if (!this.endpoints) return;
    for (const channel of ["service", "control"] as const) {
      const endpoint = this.endpoints[channel];
      if (endpoint.kind !== "unix-socket") continue;
      const expected = channel === "service" ? this.serviceSocketIno : this.controlSocketIno;
      const ino = await this.socketIno(endpoint);
      if (ino === expected) continue;
      if (ino !== undefined) {
        this.log(`service: the ${channel} endpoint was taken over by another process; stopping`);
        this.options.requestStop(`${channel} endpoint lost`);
        return;
      }
      const old = channel === "service" ? this.serviceServer : this.controlServer;
      old?.close();
      const server = await listenExclusive(endpoint, (s) =>
        channel === "service" ? this.onShimSocket(s) : this.onControlSocket(s),
      ).catch(() => "in_use" as const);
      if (server === "in_use") {
        this.log(`service: cannot re-create the ${channel} endpoint; stopping`);
        this.options.requestStop(`${channel} endpoint lost`);
        return;
      }
      if (channel === "service") this.serviceServer = server;
      else this.controlServer = server;
      const newIno = await this.socketIno(endpoint);
      if (channel === "service") this.serviceSocketIno = newIno;
      else this.controlSocketIno = newIno;
      this.log(`service: re-created the ${channel} endpoint`);
    }
  }

  // ---- shutdown -------------------------------------------------------------------------------

  /**
   * Graceful shutdown, in an order that keeps AD-7: no new connections or
   * requests, MCP connections closed, HTTP closed, then Core (terminates
   * process trees and records them, drains the guard, closes the audit log),
   * the browser bridge and the Native Host. The shim endpoint goes last.
   */
  shutdown(reason: string): Promise<void> {
    this.stopping ??= this.doShutdown(reason);
    return this.stopping;
  }

  private async doShutdown(reason: string): Promise<void> {
    this.state = "stopping";
    this.disarmIdleTimer();
    this.detector.stop();
    for (const socket of this.pendingSockets) socket.destroy();
    for (const control of this.controls) control.close();
    if (this.controlServer) await closeServer(this.controlServer);
    for (const shim of this.shims) {
      if (shim.transport) shim.channel.send({ t: "bye", reason } satisfies ServiceToShim);
    }
    await Promise.all(
      [...this.shims].map(async (shim) => {
        await shim.close?.();
        shim.channel.close();
      }),
    );
    await this.releaseRuntime();
    if (this.serviceServer) await closeServer(this.serviceServer);
  }

  private async releaseRuntime(): Promise<void> {
    if (this.http) await this.http.close();
    if (this.coreInstance) await this.coreInstance.shutdown();
    await this.bridge?.close();
    await this.native?.close();
    if (this.state !== "stopping" && this.serviceServer) {
      // Startup failed: release the endpoints too.
      this.state = "stopping";
      if (this.controlServer) await closeServer(this.controlServer);
      await closeServer(this.serviceServer);
    }
  }

  /** Last resort when the graceful shutdown hangs: kill process trees synchronously. */
  emergency(): void {
    this.coreInstance?.terminateProcessesSync();
    this.native?.closeSync();
  }
}

/** Stop accepting and close; connections still open are destroyed by their owners. */
function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
