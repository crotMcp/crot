/**
 * The CROT service (WP-20, ARCHITECTURE.md §27 AD-17).
 *
 * One long-running process per OS user owns Core, the Native Host, the browser
 * bridge, HTTP and the device tunnel (WP-30). Local clients reach it through
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
import { RuntimePermissionState } from "../core/permissions/runtime.js";
import { newAuditEventId } from "../core/audit/audit.js";
import { newLocalExposureScope } from "../core/auth/principal.js";
import { ProductRuntime, productPaths } from "./product-runtime.js";
import type net from "node:net";
import { launchControlCenter } from "../tray/launch.js";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_HTTP_TOKEN_FILE_NAME, LocalTokenVerifier, loadOrCreateLocalToken } from "../adapters/http/auth.js";
import { CrotHttpServer } from "../adapters/http/server.js";
import { localContextResolver } from "../adapters/mcp/context.js";
import { createCrotMcpServer } from "../adapters/mcp/server.js";
import type { BrowserBridge } from "../browser-bridge/server.js";
import { browserProtectedPaths, startBrowserBridge } from "../cli/browser.js";
import type { ServeCommand } from "../cli/options.js";
import type { UntrustedContentSetting } from "../core/approvals/exposure.js";
import { REMOTE_EXPOSURE_FILE_NAME, RemoteExposureStore } from "../core/approvals/index.js";
import { parseConfig } from "../core/config/load.js";
import { expandHome } from "../core/config/paths.js";
import { CORE_VERSION, CrotCore, type CoreCompositionHandle, type CrotCoreOptions } from "../core/crot-core.js";
import type { RemoteProfileOptions } from "../core/permissions/engine.js";
import { CrotError } from "../core/errors.js";
import type { ServiceStatus } from "../core/service-status.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import { NativeHost } from "../native-host/native-host.js";
import type { RemoteAdmission } from "../adapters/http/server.js";
import { acceptChannel, MAX_CLIENT_FRAME_BYTES, type AuthenticatedChannel } from "./channel.js";
import { ControlCenter, type ControlConnection, type RemoteEntry } from "./control-center.js";
import { CoreHolder } from "./core-holder.js";
import { DeviceSettingsStore, SERVICE_SETTINGS_FILE_NAME } from "./device-settings.js";
import { REMOTE_CLIENTS_FILE_NAME, RemoteClientRegistry } from "./remote-clients.js";
import { DEVICE_BINDING_FILE_NAME, DeviceBindingStore, type TunnelCredentialResult } from "./device-binding.js";
import { DeviceIdentity, type DeviceIdentityOptions } from "./identity.js";
import { RemoteTunnel, TunnelControlCenter, type RemoteTunnelSeams } from "./remote-tunnel.js";
import { resolveIdentityEnvironment, type IdentityEnvironment } from "../identity/environment.js";
import type { IdentityHttp } from "../identity/http.js";
import type { AccessTokenVerifier } from "../adapters/http/auth.js";
import { configDigest } from "./config-digest.js";
import { environmentDifferences, environmentFingerprint } from "./environment.js";
import {
  secretCredentialStore,
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
  type ControlEvent,
  type ControlRequest,
  type ControlStatus,
  type ServiceToShim,
} from "./protocol.js";
import { ResumeDetector } from "./resume-detector.js";
import {
  prepareSecretStore,
  secretStoreProtectedPaths,
  stateSecretPaths,
  type HttpTokenSource,
  type PreparedSecretStore,
  type SecretStoreHost,
} from "./secrets/store.js";
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
  /** Platform inputs and seams of the secret store (tests). */
  readonly secretsHost?: SecretStoreHost;
  readonly idleExitMs?: number;
  readonly firstClientTimeoutMs?: number;
  readonly windows?: boolean;
  /** Clock and interval of the sleep/wake detector (tests). */
  readonly resume?: { readonly intervalMs?: number; readonly thresholdMs?: number; readonly now?: () => number };
  /**
   * Identity seams (tests): the environment instead of the pinned release /
   * CROT_IDENTITY_DEV_ENVIRONMENT one, the HTTPS client of the issuer, JWKS
   * cache tuning and the pairing timeout.
   */
  readonly identity?: {
    readonly environment?: IdentityEnvironment | { readonly unavailable: string };
    readonly http?: IdentityHttp;
    readonly keys?: DeviceIdentityOptions["keys"];
    readonly pairingTimeoutMs?: number;
  };
  /** Device tunnel seams (tests): relay URL, timings, backoff (WP-30). */
  readonly tunnel?: RemoteTunnelSeams;
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
  private secrets: PreparedSecretStore | undefined;
  private httpTokenStorage: "secret-store" | "token-file" | undefined;
  private endpoints: { service: ServiceEndpoint; control: ServiceEndpoint } | undefined;
  private native: NativeHost | undefined;
  private bridge: BrowserBridge | undefined;
  private product: ProductRuntime | undefined;
  private readonly runtimePermissions = new RuntimePermissionState();
  private killing: Promise<Record<string, unknown>> | undefined;
  private holder: CoreHolder | undefined;
  private control: ControlCenter | undefined;
  private deviceIdentity: DeviceIdentity | undefined;
  private readonly controlConnections = new Map<AuthenticatedChannel, ControlConnection>();
  private http: CrotHttpServer | undefined;
  private tunnel: RemoteTunnel | undefined;
  private digest = "";
  private idleTimer: NodeJS.Timeout | undefined;
  private resumes = 0;
  private lastResumeAt: string | undefined;
  private readonly detector: ResumeDetector;
  private readonly ready: Promise<void>;
  private markReady!: () => void;
  private stopping: Promise<void> | undefined;
  private verifying = false;
  /** Platform-relevant environment of this service process (environment.ts). */
  private readonly environment = environmentFingerprint();

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

  /**
   * The Core the adapters use: a delegating object that always forwards to
   * the current Core, which a preset change replaces (AD-19 point 5).
   */
  get core(): CrotCore {
    if (!this.holder) throw new Error("CROT service not started");
    return this.holder.core;
  }

  /** Admission of remote requests on this device (remote mode, revocation; AD-19 points 6 and 8). */
  get remoteAdmission(): RemoteAdmission {
    if (!this.control) throw new Error("CROT service not started");
    return this.control;
  }

  /** Register a relay entry point (WP-30) so that revocation and remote mode off end its requests. */
  addRemoteEntry(entry: RemoteEntry): () => void {
    if (!this.control) throw new Error("CROT service not started");
    return this.control.addRemoteEntry(entry);
  }

  /** Device identity (WP-28): environment, pairing, canonical URI, PRM URL. */
  get identity(): DeviceIdentity {
    if (!this.deviceIdentity) throw new Error("CROT service not started");
    return this.deviceIdentity;
  }

  /** Verifier of OAuth access tokens at the relay entry point (AD-21 point 3; the tunnel mounts it). */
  get remoteVerifier(): AccessTokenVerifier {
    return this.identity.verifier;
  }

  /** The PRM URL for the relay entry point's 401 challenges (AD-21 point 6). */
  resourceMetadataUrl(): string | undefined {
    return this.deviceIdentity?.resourceMetadataUrl();
  }

  /** The device credential for the tunnel (WP-29/WP-30); refused while not paired here. */
  tunnelCredential(): TunnelCredentialResult {
    return this.deviceIdentity ? this.deviceIdentity.tunnelCredential() : { ok: false, reason: "no_environment" };
  }

  /** The device tunnel (WP-30); undefined without an identity environment. */
  get remoteTunnel(): RemoteTunnel | undefined {
    return this.tunnel;
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
      secrets: this.secrets
        ? {
            store: this.secrets.info.backend,
            location: this.secrets.info.description,
            ...(this.secrets.info.fallbackReason ? { fallbackReason: this.secrets.info.fallbackReason } : {}),
            ...(this.httpTokenStorage ? { httpToken: this.httpTokenStorage } : {}),
          }
        : { store: "unknown", location: "not prepared" },
      ...(this.control ? { controls: this.control.statusSummary() } : {}),
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
    await privateFiles.ensureDirectory(stateDir);
    if (this.windows && privateFiles.protectFile) {
      // Fixed service-owned state root, not an arbitrary workspace/audit parent.
      // Protect legacy directories too, before secret-store/bootstrap activity.
      await privateFiles.protectFile(stateDir);
      const { existingPrivateStateFiles } = await import("./private-files.js");
      for (const file of await existingPrivateStateFiles(stateDir)) await privateFiles.protectFile(file);
    }
    const warning = await stateDirectoryWarning(stateDir);
    if (warning) this.log(`warning: ${warning}`);
    // The secret store first (WP-21): it may migrate the credentials the endpoints are derived from.
    const parsed = parseConfig(this.options.command.config);
    this.secrets = await prepareSecretStore({
      stateDir,
      privateFiles,
      preference: parsed.secrets.store,
      httpToken: httpTokenSource(parsed.http.auth),
      log: (m) => this.log(m),
      ...(this.options.secretsHost ? { host: this.options.secretsHost } : {}),
    });
    const store =
      this.options.credentials ?? secretCredentialStore(stateDir, privateFiles, { store: this.secrets.store });
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
      const secrets = this.secrets!;
      const legacyTokenFile =
        http.auth.storage === "token-file"
          ? path.resolve(expandHome(http.auth.tokenFile ?? path.join(stateDir, DEFAULT_HTTP_TOKEN_FILE_NAME)))
          : undefined;
      const configuredTokenFile =
        http.auth.tokenFile !== undefined ? path.resolve(expandHome(http.auth.tokenFile)) : undefined;
      // Persisted exposure of remote principals (AD-15): only HTTP (later the tunnel) carries remote principals.
      const remoteExposureFile = http.enabled ? path.join(stateDir, REMOTE_EXPOSURE_FILE_NAME) : undefined;
      // Device state of the tray controls (AD-19): protected private state, fail closed.
      const privateFiles = this.options.privateFiles;
      const settings = await DeviceSettingsStore.open(path.join(stateDir, SERVICE_SETTINGS_FILE_NAME), privateFiles);
      if (settings.error) log(`warning: device settings: ${settings.error}; using the most restrictive settings`);
      const clients = await RemoteClientRegistry.open(path.join(stateDir, REMOTE_CLIENTS_FILE_NAME), privateFiles, {
        onError: (e) => log(`warning: remote clients: ${e instanceof Error ? e.message : String(e)}`),
      });
      if (clients.error) log(`warning: remote clients: ${clients.error}; every remote request is refused`);
      // Identity and device binding (AD-21, WP-28): fail closed on unreadable state or an environment mismatch.
      const binding = await DeviceBindingStore.open(
        path.join(stateDir, DEVICE_BINDING_FILE_NAME),
        privateFiles,
        secrets.store,
      );
      if (binding.error) log(`warning: device binding: ${binding.error}; every remote request is refused`);
      const identity = new DeviceIdentity({
        environment: await this.identityEnvironment(),
        binding,
        log,
        ...(this.options.identity?.http ? { http: this.options.identity.http } : {}),
        ...(this.options.identity?.keys ? { keys: this.options.identity.keys } : {}),
        ...(this.options.identity?.pairingTimeoutMs !== undefined
          ? { pairingTimeoutMs: this.options.identity.pairingTimeoutMs }
          : {}),
      });
      this.deviceIdentity = identity;
      const paired = binding.paired;
      if (paired && identity.environment && paired.issuer !== identity.environment.issuer)
        log(
          `warning: device binding: paired in environment ${paired.environment}, this process uses ${identity.environment.id}; every remote request is refused until the device is paired again`,
        );
      // Secret material (AD-18): neither readable nor modifiable through CROT tools, in any mode.
      const secretPaths = [
        ...stateSecretPaths(stateDir),
        ...secrets.store.backend.paths,
        ...(configuredTokenFile ? [configuredTokenFile] : []),
        ...(legacyTokenFile ? [legacyTokenFile] : []),
      ];
      // Configuration, secret store, bridge token, service credentials and the service log are never modifiable through CROT tools.
      const protectedPaths = [
        command.configFile,
        ...secretPaths,
        ...secretStoreProtectedPaths(stateDir),
        ...browserProtectedPaths(parsed.browser.enabled, stateDir),
        ...serviceProtectedPaths(stateDir),
        ...productPaths(stateDir),
      ].filter((p): p is string => p !== undefined);

      // Native resources first; Core is built on the Native Host platform.
      // Command confinement L1 (AD-20): its private storage is per state directory; availability changes go to the log.
      this.native = await NativeHost.start({ startupPath: parsed.environment.path, stateDir, log });
      for (const note of this.native.status().notes) log(`note: native host: ${note}`);
      // The browser bridge never stops CROT: when it cannot start, CROT runs without it.
      const servicePlatform =
        this.windows && this.options.privateFiles.enforced
          ? {
              ...this.native.platform,
              privateFiles: this.options.privateFiles,
              info: {
                ...this.native.platform.info,
                privateFiles: { mechanism: this.options.privateFiles.mechanism, enforced: true },
              },
            }
          : this.native.platform;
      this.bridge = await startBrowserBridge({
        openControlCenter: () => launchControlCenter(stateDir),
        enabled: parsed.browser.enabled,
        stateDir,
        privateFiles: servicePlatform.privateFiles,
        token: () => secrets.store.readOrCreate("browser-token"),
        log,
      });
      const remoteExposure = remoteExposureFile
        ? await RemoteExposureStore.open(remoteExposureFile, servicePlatform.privateFiles, {
            onError: (e) => log(`remote exposure state: ${e instanceof Error ? e.message : String(e)}`),
          })
        : undefined;
      const coreOptions: CrotCoreOptions = {
        runtimePermissions: this.runtimePermissions,
        protectedPaths,
        secretPaths,
        ...(remoteExposureFile ? { remoteExposureFile } : {}),
        ...(remoteExposure ? { remoteExposure } : {}),
        platform: servicePlatform,
        ...(this.bridge ? { browser: this.bridge } : {}),
        additionalAuthorization: (context, operation) => this.product?.authorize(context, operation),
        serviceStatus: () => this.status(),
      };
      const configuredPreset = parsed.permissions.approvals.untrustedContent;
      // Every Core gets the preset and the remote profile (WP-31) of the device state; none widens by default.
      let activeWorkspace = parsed.workspace.root;
      let activeAuditPath = command.config.audit?.path;
      const build = async (
        preset: UntrustedContentSetting,
        exposure?: CoreCompositionHandle["exposure"],
        remote?: RemoteProfileOptions,
        workspace = activeWorkspace,
      ) => {
        let handle: CoreCompositionHandle | undefined;
        const core = await CrotCore.create(
          withPreset(
            {
              ...command.config,
              workspace: { ...command.config.workspace, root: workspace },
              ...(activeAuditPath ? { audit: { ...command.config.audit, path: activeAuditPath } } : {}),
            },
            preset,
            configuredPreset,
          ),
          {
            ...coreOptions,
            ...(exposure ? { exposure } : {}),
            ...(remote ? { remoteProfile: remote } : {}),
            composition: (h) => (handle = h),
          },
        );
        return { core, handle: handle! };
      };
      const initial = await build(
        ControlCenter.effectivePreset(settings, configuredPreset).effective,
        undefined,
        ControlCenter.remoteProfile(settings, binding),
      );
      activeAuditPath = initial.core.status().audit.path;
      const holder = new CoreHolder(initial.core, initial.handle);
      this.holder = holder;
      const mcpArgs: string[] = [];
      if (command.configFile) mcpArgs.push("--config", command.configFile);
      mcpArgs.push("--workspace", initial.core.status().workspace.root, "--mode", parsed.permissions.mode);
      if (command.config.audit?.sink === "none") mcpArgs.push("--no-audit");
      else if (command.config.audit?.path)
        mcpArgs.push("--audit-log", initial.core.status().audit.path ?? command.config.audit.path);
      const control = new TunnelControlCenter({
        mcpArgs,
        providerRevocation: (client) => identity.revokeProvider(client),
        holder,
        settings,
        clients,
        binding,
        identity,
        remoteExposure,
        configuredPreset,
        buildCore: (preset, remote, workspace) => build(preset, holder.composition.exposure, remote, workspace),
        serviceStatus: () => this.status(),
        browserState: () => this.bridge?.state(),
        agents: () => ({
          stdio: this.activeShims(),
          httpSessions: this.http?.sessionCount ?? 0,
          httpSessionlessInFlight: this.http?.sessionlessLoad.inFlight ?? 0,
        }),
        log,
      });
      this.control = control;
      this.product = await ProductRuntime.open({
        stateDir,
        secrets: secrets.store,
        privateFiles: servicePlatform.privateFiles,
        core: () => holder.instance,
        disconnectAgent: (id) => control.disconnectProductAgent(id),
        emergencyStop: () => this.killAgents(),
        recordControlEvent: (event) => holder.composition.recordControlEvent(event),
        selectWorkspace: async (root) => {
          await control.selectWorkspace(root);
          activeWorkspace = root;
        },
      });
      control.product = this.product;
      holder.operation = (member, method, args, run) => this.product!.execute(member, method, args, run);
      this.banner();
      if (http.enabled) await this.startHttp(http, legacyTokenFile);
      if (identity.environment) {
        // The device tunnel (WP-30): open while remote mode is on and the device is paired here.
        const tunnel = new RemoteTunnel({
          core: holder.core,
          http,
          verifier: identity.verifier,
          admission: control,
          resourceMetadataUrl: () => this.resourceMetadataUrl(),
          addRemoteEntry: (entry) => control.addRemoteEntry(entry),
          credential: () => this.tunnelCredential(),
          remoteMode: () => control.statusSummary().remoteMode === true,
          software: `crot/${CORE_VERSION}`,
          log,
          onStatus: () => control.stateChanged(),
          ...this.options.tunnel,
        });
        this.tunnel = tunnel;
        control.tunnelView = () => tunnel.view();
        control.onRemoteChange = () => tunnel.sync();
        await tunnel.sync();
        tunnel.watch();
      }
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

  private async identityEnvironment(): Promise<IdentityEnvironment | { unavailable: string }> {
    const seam = this.options.identity?.environment;
    if (seam) return seam;
    const resolved = await resolveIdentityEnvironment();
    for (const note of resolved.notes) this.log(`note: identity: ${note}`);
    if (!resolved.ok) {
      this.log(`identity: ${resolved.reason}`);
      return { unavailable: resolved.reason };
    }
    const env = resolved.environment;
    this.log(`identity: environment ${env.id} (${env.kind}), issuer ${env.issuer}, relay ${env.relayHost}`);
    return env;
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

  /**
   * HTTP with the local token from the secret store, or (http.auth.storage
   * "token-file", compatibility mode) from the plaintext token file.
   */
  private async startHttp(
    http: ReturnType<typeof parseConfig>["http"],
    legacyTokenFile: string | undefined,
  ): Promise<void> {
    const core = this.core;
    const log = (m: string) => this.log(m);
    let verifier: LocalTokenVerifier;
    if (legacyTokenFile !== undefined) {
      this.httpTokenStorage = "token-file";
      const { token, created } = await loadOrCreateLocalToken(legacyTokenFile, core.platform.privateFiles);
      verifier = new LocalTokenVerifier(token);
      log(
        `warning: http: the access token is kept in the plaintext file ${legacyTokenFile} (http.auth.storage "token-file", compatibility mode); ` +
          `remove that setting to move it into the secret store (fingerprint ${verifier.fingerprint}, ${created ? "created" : "read"})`,
      );
      const tokenProtection = await core.platform.privateFiles.inspect(legacyTokenFile);
      if (tokenProtection.ownerOnly === false) log(`warning: HTTP token file ${tokenProtection.detail}`);
      if (tokenProtection.ownerOnly === null) log(`note: HTTP token file ${tokenProtection.detail}`);
    } else {
      this.httpTokenStorage = "secret-store";
      const store = this.secrets!.store;
      const existing = await store.read("http-token");
      verifier = new LocalTokenVerifier(existing ?? (await store.readOrCreate("http-token")));
      log(
        `http: access token ${existing ? "read from" : "created in"} ${store.backend.description} (fingerprint ${verifier.fingerprint}); show it with 'crot-mcp secrets show http-token'`,
      );
    }
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
    hello: {
      readonly version: number;
      readonly configDigest: string;
      readonly environment?: Readonly<Record<string, string>>;
    },
  ): Promise<void> {
    if (this.runtimePermissions.halted)
      return this.refuse(shim, "shutting_down", "Emergency stop is active; restart the service to resume.");
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
    const resolver = localContextResolver("stdio"),
      scope = newLocalExposureScope();
    const server = createCrotMcpServer(this.core, {
      resolveContext: (request) => ({ ...resolver(request), exposureScope: scope }),
    });
    const agentId = `local:${scope.id}`;
    this.product?.attachAgent(agentId, async () => {
      await server.close();
      shim.channel.close();
    });
    const transport = new ChannelServerTransport(shim.channel);
    await server.connect(transport);
    shim.transport = transport;
    shim.close = async () => {
      this.product?.detachAgent(agentId);
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
      logs: [...this.startupLogs, ...this.environmentNote(hello.environment)],
    } satisfies ServiceToShim);
  }

  /**
   * A client whose PATH, shell or home differs from the service's is told so
   * (AD-17 point 5): commands run with the service's environment, which comes
   * from the supervisor or the client that started the service.
   */
  private environmentNote(client: Readonly<Record<string, string>> | undefined): string[] {
    const differing = environmentDifferences(this.environment, client);
    if (differing.length === 0) return [];
    return [
      `note: this client's ${differing.join(", ")} differ${differing.length === 1 ? "s" : ""} from the running CROT service ` +
        `(pid ${process.pid}, ${this.options.launch}); commands run with the service's environment. ` +
        "Give every MCP client the same environment, or run the service managed (docs/SERVICE.md).",
    ];
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
        const connection: ControlConnection = { send: (message: ControlEvent) => void channel.send(message) };
        this.controlConnections.set(channel, connection);
        channel.onmessage = (value) => void this.onControlMessage(channel, value);
        channel.onclose = () => {
          this.controls.delete(channel);
          this.controlConnections.delete(channel);
          this.control?.connectionClosed(connection);
        };
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
    const connection = this.controlConnections.get(channel);
    const handled = connection && this.state === "running" ? this.control?.handle(connection, request) : undefined;
    if (handled) {
      let result: unknown;
      try {
        result = await handled;
      } catch (error) {
        channel.send({
          t: "response",
          id: request.id,
          error: { code: "failed", message: error instanceof Error ? error.message : String(error) },
        });
        return;
      }
      channel.send({ t: "response", id: request.id, result });
      return;
    }
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
      default:
        // WP-22 requests while the service is not running (starting or stopping).
        return { ok: false, reason: "unavailable", message: `The CROT service is ${this.state}.` };
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
    // A resumed device reconnects its tunnel at once instead of waiting for the backoff (AD-22 point 9).
    this.tunnel?.nudge();
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
   * requests, MCP connections closed, the tunnel and HTTP closed, then Core
   * (terminates process trees and records them, drains the guard, closes the
   * audit log), the browser bridge and the Native Host. The shim endpoint goes last.
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
    this.deviceIdentity?.cancelPairing();
    await this.tunnel?.close();
    if (this.http) await this.http.close();
    await this.product?.close();
    if (this.holder) await this.holder.instance.shutdown();
    await this.control?.flush();
    await this.bridge?.close();
    await this.native?.close();
    if (this.state !== "stopping" && this.serviceServer) {
      // Startup failed: release the endpoints too.
      this.state = "stopping";
      if (this.controlServer) await closeServer(this.controlServer);
      await closeServer(this.serviceServer);
    }
  }

  /** Emergency owner RPC: never queued behind approvals or long-running product operations. */
  killAgents(): Promise<Record<string, unknown>> {
    this.runtimePermissions.stop();
    return (this.killing ??= this.doKillAgents());
  }

  private async doKillAgents(): Promise<Record<string, unknown>> {
    const core = this.holder?.instance;
    if (!core) return { ok: false, halted: true, message: "Core is unavailable" };
    // Start all cleanup concurrently. One broken transport must not keep other processes alive.
    const results = await Promise.allSettled([
      core.emergencyStop(),
      this.product?.abortAll(),
      this.tunnel?.close(),
      this.http?.close(),
      ...[...this.shims].map(async (shim) => {
        try {
          await shim.close?.();
        } finally {
          shim.channel.close();
        }
      }),
    ]);
    const failed = results.some((r) => r.status === "rejected");
    if (failed) {
      try {
        core.terminateProcessesSync();
      } catch {
        this.log("Emergency stop: forced cleanup also failed; service restart required");
      }
    }
    let audited = true;
    try {
      await this.holder!.composition.recordControlEvent({
        kind: "control",
        id: newAuditEventId(),
        timestamp: new Date().toISOString(),
        action: "emergency_stop",
        actor: { channel: "control" },
        outcome: "applied",
        value: true,
        ...(failed ? { reason: "cleanup_incomplete" } : {}),
      });
    } catch {
      audited = false;
    }
    this.control?.stateChanged();
    return {
      ok: !failed && audited,
      halted: true,
      audited,
      cleanupComplete: !failed,
      message: failed
        ? "Emergency stop latched; some cleanup failed. Restart the service."
        : !audited
          ? "Emergency stop latched; audit write failed. Restart the service."
          : "All agent work stopped. Restart the service to resume.",
    };
  }

  /** Last resort when the graceful shutdown hangs: kill process trees synchronously. */
  emergency(): void {
    this.holder?.instance.terminateProcessesSync();
    this.native?.closeSync();
  }
}

/**
 * The configuration input with the preset chosen in the tray (AD-19 point 5).
 * The configuration file itself and its digest (AD-17 point 5) are unchanged.
 */
function withPreset(input: unknown, preset: UntrustedContentSetting, configured: UntrustedContentSetting): unknown {
  if (preset === configured) return input;
  const record = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const base = record(input);
  const permissions = record(base.permissions);
  const approvals = record(permissions.approvals);
  return { ...base, permissions: { ...permissions, approvals: { ...approvals, untrustedContent: preset } } };
}

/** How http.auth keeps the local token (WP-21). */
function httpTokenSource(auth: ReturnType<typeof parseConfig>["http"]["auth"]): HttpTokenSource {
  return {
    storage: auth.storage,
    ...(auth.tokenFile !== undefined ? { file: path.resolve(expandHome(auth.tokenFile)) } : {}),
  };
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
