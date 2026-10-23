/** AD-40: service-owned product state. Metadata and encrypted request/credential vault are separate. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, realpath, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { executeExternalMcp } from "../core/capabilities/mcp/external.js";
import { CrotError } from "../core/errors.js";
import { localPrincipal, type AuthContext } from "../core/auth/principal.js";
import type { CrotCore } from "../core/crot-core.js";
import type { PrivateFileProtection, ManagedProcess } from "../core/platform/types.js";
import type { SecretStore } from "./secrets/store.js";
import { writePrivateFileAtomic } from "./secrets/backends.js";
import { parseProduct, type ProductMethod } from "./product-protocol.js";

export const CONNECTOR_IDS = [
  "GitHub",
  "GitLab",
  "ElevenLabs",
  "YouTube",
  "TikTok",
  "Notion",
  "Google Drive",
  "Slack",
  "Custom HTTP API",
  "FFmpeg Media Pipeline",
] as const;
interface Project {
  id: string;
  name: string;
  path: string;
  favorite: boolean;
  lastOpened: string;
  tools: string[];
  agents: string[];
  connectors: string[];
}
interface Agent {
  id: string;
  name: string;
  kind: string;
  connected: boolean;
  projects: string[];
  browser: boolean;
  requestsPerMinute: number;
  revoked: boolean;
  calls: number;
  lastSeen: string;
}
interface Connector {
  id: string;
  configured: boolean;
  enabled: boolean;
  endpoint?: string;
  scopes: string[];
  projects: string[];
  agents: string[];
  checkedAt?: string;
  latencyMs?: number;
  status: string;
  httpStatus?: number;
}
interface McpServer {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args: string[];
  url?: string;
  status: string;
  tools: { name: string; inputSchema: Record<string, unknown>; description?: string }[];
  resources: unknown[];
  policy: Record<string, boolean>;
  logs: { time: string; event: string }[];
}
interface Task {
  id: string;
  operation: string;
  project: string;
  agent: string;
  connector?: string;
  state: string;
  progress: number;
  startedAt: string;
  endedAt?: string;
  processId?: string;
  artifacts: string[];
  retryable: boolean;
  errorCode?: string;
}
interface State {
  version: 1;
  active: string;
  launchWorkspace?: string;
  projects: Project[];
  agents: Agent[];
  connectors: Connector[];
  servers: McpServer[];
  tasks: Task[];
}
interface Vault {
  credentials: Record<string, string>;
  replays: Record<
    string,
    {
      member: string;
      method: string;
      input: unknown[];
      context?: { principal: AuthContext["principal"]; scopeId?: string };
    }
  >;
}
export interface ProductHost {
  stateDir: string;
  secrets: SecretStore;
  privateFiles: PrivateFileProtection;
  core(): CrotCore;
  selectWorkspace(root: string): Promise<void>;
  disconnectAgent?(id: string): Promise<void>;
}
const fail = (message: string): never => {
  throw new CrotError("INVALID_INPUT", message);
};
const now = () => new Date().toISOString();
const strings = (v: unknown) => v as string[];
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const limited = <T>(values: T[], limit = 500): T[] => values.slice(-limit);
export const productPaths = (dir: string) => [
  path.join(dir, "product-state.json"),
  path.join(dir, "product-vault.enc"),
];

class PipeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private buffer = new ReadBuffer();
  private pendingBytes = 0;
  constructor(private proc: ManagedProcess) {}
  async start(): Promise<void> {
    this.proc.stdout.on("data", (chunk: Buffer) => {
      try {
        this.pendingBytes += chunk.length;
        if (this.pendingBytes > 2 * 1024 * 1024) throw new Error("MCP frame too large");
        this.buffer.append(chunk);
        let msg;
        while ((msg = this.buffer.readMessage()) !== null) {
          this.onmessage?.(msg);
          this.pendingBytes = 0;
        }
      } catch {
        this.onerror?.(new Error("Invalid MCP transport frame"));
        void this.close();
      }
    });
    this.proc.stderr.resume(); // Never persist untrusted stderr: it can contain credentials.
    void this.proc.exited.then(() => this.onclose?.());
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.proc.stdin || this.proc.hasExited) throw new Error("MCP process closed");
    const line = serializeMessage(message);
    await new Promise<void>((resolve, reject) => this.proc.stdin!.write(line, (e) => (e ? reject(e) : resolve())));
  }
  async close(): Promise<void> {
    await this.proc.terminate("force");
  }
}

export class ProductRuntime {
  private state!: State;
  private vault: Vault = { credentials: {}, replays: {} };
  private key!: Buffer;
  private writes: Promise<void> = Promise.resolve();
  private mutations: Promise<unknown> = Promise.resolve();
  private operationContext = new AsyncLocalStorage<AuthContext>();
  private clients = new Map<string, Client>();
  private connecting = new Map<string, Promise<Record<string, unknown>>>();
  private serverControllers = new Map<string, AbortController>();
  private agentClosers = new Map<string, () => Promise<void>>();
  attachAgent(id: string, close: () => Promise<void>): void {
    this.agentClosers.set(id, close);
  }
  detachAgent(id: string): void {
    this.agentClosers.delete(id);
    const a = this.state.agents.find((a) => a.id === id);
    if (a) a.connected = false;
    void this.persist().catch(() => undefined);
  }
  private cancellations = new Map<string, AbortController>();
  private contexts = new Map<string, AuthContext>();
  private rate = new Map<string, number[]>();
  private poller: NodeJS.Timeout | undefined;
  private schemaValidator = new AjvJsonSchemaValidator();
  private constructor(private host: ProductHost) {}
  static async open(host: ProductHost): Promise<ProductRuntime> {
    const r = new ProductRuntime(host);
    r.key = Buffer.from(await host.secrets.readOrCreate("product-key"), "base64url");
    const file = productPaths(host.stateDir)[0]!;
    const meta = await readFile(file, "utf8").catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    });
    if (meta && meta.length > 8 * 1024 * 1024) fail("Product state is too large");
    r.state = meta
      ? (JSON.parse(meta) as State)
      : { version: 1, active: "", projects: [], agents: [], connectors: [], servers: [], tasks: [] };
    if (r.state.version !== 1 || !Array.isArray(r.state.projects) || !Array.isArray(r.state.tasks))
      fail("Invalid product state; restore service state");
    const encrypted = await readFile(productPaths(host.stateDir)[1]!, "utf8").catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    });
    if (encrypted) {
      const value = JSON.parse(encrypted) as { iv: string; tag: string; data: string };
      const decipher = createDecipheriv("aes-256-gcm", r.key, Buffer.from(value.iv, "base64"));
      decipher.setAuthTag(Buffer.from(value.tag, "base64"));
      r.vault = JSON.parse(
        Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString(),
      ) as Vault;
    }
    for (const t of r.state.tasks)
      if (t.state === "Running") {
        t.state = "Interrupted";
        t.endedAt = now();
      }
    for (const a of r.state.agents) a.connected = false;
    for (const s of r.state.servers) s.status = "Disconnected";
    const root = await realpath(host.core().workspace.root);
    if (!r.state.projects.some((p) => p.path === root)) r.state.projects.push(r.newProject(root));
    // An explicit CLI/config workspace change wins over the last UI selection.
    // Restarts with the same launch root restore the selected project.
    if (!r.state.active || (r.state.launchWorkspace && r.state.launchWorkspace !== root))
      r.state.active = r.state.projects.find((p) => p.path === root)!.id;
    r.state.launchWorkspace = root;
    const active = r.state.projects.find((p) => p.id === r.state.active);
    if (!active) fail("Active project is missing from the registry");
    if (active && active.path !== root) await host.selectWorkspace(active.path);
    await r.persist();
    r.poller = setInterval(() => void r.pollProcesses().catch(() => undefined), 1200);
    r.poller.unref();
    return r;
  }
  get activeProject(): Project {
    return this.state.projects.find((p) => p.id === this.state.active)!;
  }
  private newProject(root: string, name?: string): Project {
    return {
      id: randomUUID(),
      path: root,
      name: name ?? path.basename(root),
      favorite: false,
      lastOpened: now(),
      tools: [],
      agents: [],
      connectors: [],
    };
  }
  private context(signal?: AbortSignal): AuthContext {
    return (
      this.operationContext.getStore() ?? { principal: localPrincipal("owner-product"), ...(signal ? { signal } : {}) }
    );
  }
  private persist(): Promise<void> {
    const live = new Set(this.state.tasks.map((t) => t.id));
    for (const id of Object.keys(this.vault.replays))
      if (!live.has(id)) {
        delete this.vault.replays[id];
        this.contexts.delete(id);
      }
    let replayBytes = 0;
    for (const task of this.state.tasks.slice().reverse()) {
      const replay = this.vault.replays[task.id];
      if (!replay) continue;
      replayBytes += Buffer.byteLength(JSON.stringify(replay));
      if (replayBytes > 8 * 1024 * 1024) {
        delete this.vault.replays[task.id];
        task.retryable = false;
      }
    }
    const metadata = JSON.stringify(this.state);
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.vault)), cipher.final()]);
    const vault = JSON.stringify({
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: ciphertext.toString("base64"),
    });
    const work = async () => {
      await writePrivateFileAtomic(productPaths(this.host.stateDir)[1]!, vault, this.host.privateFiles);
      await writePrivateFileAtomic(productPaths(this.host.stateDir)[0]!, metadata, this.host.privateFiles);
    };
    this.writes = this.writes.then(work, work);
    return this.writes;
  }
  private async event(type: string, project = this.state.active, agent = "owner"): Promise<void> {
    const audit = this.host.core().status().audit;
    if (!audit.path) return;
    // Audit writer belongs to Core. Administrative event includes only bounded identifiers.
    await this.host
      .core()
      .guard.run(
        this.context(),
        { operation: type, capability: [], details: { project, agent } },
        async () => undefined,
      );
  }
  async request(method: ProductMethod, input: unknown): Promise<Record<string, unknown>> {
    const params = parseProduct(method, input);
    if (!params) fail("Invalid product request");
    const run = () =>
      ["connectors.testConnection", "mcpServers.connect", "mcpServers.callTool"].includes(method)
        ? (this.execute("$product", method, [this.context(), params], (a) =>
            this.operationContext.run(a[0] as AuthContext, () => this.dispatch(method, params!)),
          ) as Promise<Record<string, unknown>>)
        : this.dispatch(method, params!);
    // Reads and long operations must not hold up cancellations/approval traffic.
    if (
      method.endsWith(".list") ||
      method.startsWith("monitoring.") ||
      method === "connectors.testConnection" ||
      method === "mcpServers.connect" ||
      method === "mcpServers.callTool" ||
      method.startsWith("tasks.")
    )
      return run();
    const next = this.mutations.then(run, run);
    this.mutations = next.catch(() => undefined);
    return next;
  }
  private async dispatch(method: ProductMethod, p: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(p.id ?? "");
    switch (method) {
      case "projects.list":
        return { ok: true, projects: this.state.projects, active: this.state.active };
      case "projects.create":
      case "projects.open": {
        const input = String(p.path);
        if (!path.isAbsolute(input)) fail("Project path must be absolute");
        // Owner explicitly registers directories. No tool or agent can invoke this configuration RPC.
        if (method === "projects.create") await mkdir(input, { recursive: false, mode: 0o700 });
        const root = await realpath(input);
        if (!(await stat(root)).isDirectory()) fail("Choose a directory");
        if (
          root === path.parse(root).root ||
          (productPaths(this.host.stateDir).some((f) => f.startsWith(root + path.sep)) && root === this.host.stateDir)
        )
          fail("Service state cannot be a project");
        const project =
          this.state.projects.find((v) => v.path === root) ?? this.newProject(root, p.name as string | undefined);
        if (!this.state.projects.includes(project)) this.state.projects.push(project);
        await this.persist();
        await this.event(method, project.id);
        return { ok: true, project };
      }
      case "projects.select": {
        const project = this.state.projects.find((v) => v.id === id) ?? fail("Unknown project");
        await this.host.selectWorkspace(await realpath(project.path));
        this.state.active = id;
        project.lastOpened = now();
        await this.persist();
        await this.event(method);
        return { ok: true, project };
      }
      case "projects.toggleFavorite":
      case "projects.updateSettings":
      case "projects.remove": {
        const project = this.state.projects.find((v) => v.id === id) ?? fail("Unknown project");
        if (method === "projects.toggleFavorite") project.favorite = !project.favorite;
        else if (method === "projects.remove") {
          if (this.state.active === id) fail("Select another project before removing the active project");
          this.state.projects = this.state.projects.filter((v) => v.id !== id);
        } else {
          project.tools = strings(p.tools);
          project.agents = strings(p.agents);
          project.connectors = strings(p.connectors);
        }
        await this.persist();
        await this.event(method, id);
        return { ok: true };
      }
      case "agents.list":
        return {
          ok: true,
          agents: this.state.agents.filter((a) => a.id !== "local:owner-product"),
          calls: this.state.tasks.map((t) => ({
            id: t.id,
            agent: t.agent,
            operation: t.operation,
            project: t.project,
            state: t.state,
            startedAt: t.startedAt,
          })),
        };
      case "agents.configure":
      case "agents.disconnect": {
        const a = this.state.agents.find((v) => v.id === id) ?? fail("Unknown agent");
        if (method === "agents.configure")
          Object.assign(a, {
            projects: p.projects,
            browser: p.browser,
            requestsPerMinute: p.requestsPerMinute,
            revoked: p.revoked,
          });
        else {
          a.revoked = true;
          a.connected = false;
          await this.agentClosers.get(id)?.();
          await this.host.disconnectAgent?.(id);
        }
        if (a.revoked)
          for (const task of this.state.tasks.filter((t) => t.agent === id && t.state === "Running"))
            await this.cancel(task);
        await this.persist();
        await this.event(method, undefined, id);
        return { ok: true };
      }
      case "connectors.list":
        return {
          ok: true,
          connectors: CONNECTOR_IDS.map(
            (id) =>
              this.state.connectors.find((c) => c.id === id) ?? {
                id,
                configured: false,
                enabled: false,
                scopes: [],
                projects: [],
                agents: [],
                status: "Available",
              },
          ),
        };
      case "connectors.configure": {
        if (!(CONNECTOR_IDS as readonly string[]).includes(id)) fail("Unknown connector");
        if (p.endpoint && id !== "Custom HTTP API") fail("Only Custom HTTP API accepts an endpoint");
        if (p.endpoint) {
          const u = new URL(String(p.endpoint));
          if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
            fail("Endpoint must be HTTP(S) without credentials, query or fragment");
        }
        if (p.credential) this.vault.credentials[id] = String(p.credential);
        const c: Connector = {
          id,
          configured: id === "FFmpeg Media Pipeline" || !!this.vault.credentials[id],
          enabled: true,
          scopes: strings(p.scopes),
          projects: strings(p.projects),
          agents: strings(p.agents),
          status: "Configured",
          ...(p.endpoint ? { endpoint: String(p.endpoint) } : {}),
        };
        if (!c.configured) fail("A credential is required");
        this.state.connectors = [...this.state.connectors.filter((v) => v.id !== id), c];
        await this.persist();
        await this.event(method);
        return { ok: true, connector: { ...c, mask: c.configured ? "••••••••" : "" } };
      }
      case "connectors.disconnect":
      case "connectors.revoke": {
        const c = this.state.connectors.find((v) => v.id === id) ?? fail("Unknown connector");
        c.enabled = false;
        c.status = "Disconnected";
        if (method === "connectors.revoke") {
          delete this.vault.credentials[id];
          c.configured = false;
          c.status = "Revoked";
        }
        await this.persist();
        await this.event(method);
        return { ok: true, connector: c };
      }
      case "connectors.testConnection":
        return this.testConnector(id);
      case "mcpServers.list":
        return { ok: true, servers: this.state.servers };
      case "mcpServers.add": {
        if ((p.transport === "stdio" && !p.command) || (p.transport === "http" && !p.url))
          fail("Transport address is required");
        if (p.url) {
          const u = new URL(String(p.url));
          if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
            fail("Invalid server URL");
        }
        const server: McpServer = {
          id: randomUUID(),
          name: String(p.name),
          transport: p.transport as McpServer["transport"],
          args: strings(p.args),
          status: "Disconnected",
          tools: [],
          resources: [],
          policy: {},
          logs: [],
          ...(p.command ? { command: String(p.command) } : {}),
          ...(p.url ? { url: String(p.url) } : {}),
        };
        if (p.token) this.vault.credentials[server.id] = String(p.token);
        this.state.servers.push(server);
        await this.persist();
        await this.event(method);
        return { ok: true, server };
      }
      case "mcpServers.connect":
        return this.connectServer(id);
      case "mcpServers.disconnect":
      case "mcpServers.remove": {
        const s = this.state.servers.find((v) => v.id === id) ?? fail("Unknown MCP server");
        this.serverControllers.get(id)?.abort();
        await this.connecting.get(id)?.catch(() => undefined);
        await this.clients.get(id)?.close();
        this.clients.delete(id);
        s.status = "Disconnected";
        if (method === "mcpServers.remove") {
          this.state.servers = this.state.servers.filter((v) => v.id !== id);
          delete this.vault.credentials[id];
        }
        await this.persist();
        await this.event(method);
        return { ok: true };
      }
      case "mcpServers.setToolPolicy": {
        const s = this.state.servers.find((v) => v.id === id) ?? fail("Unknown MCP server");
        if (!s.tools.some((t) => t.name === p.tool)) fail("Unknown discovered tool");
        s.policy[String(p.tool)] = p.allowed === true;
        await this.persist();
        await this.event(method);
        return { ok: true };
      }
      case "mcpServers.callTool": {
        const s = this.state.servers.find((v) => v.id === id) ?? fail("Unknown MCP server"),
          client = this.clients.get(id) ?? fail("Connect the server first");
        const t = s.tools.find((t) => t.name === p.tool) ?? fail("Unknown tool");
        if (!s.policy[t.name]) fail("Tool is not allowed");
        const validator = this.schemaValidator.getValidator(t.inputSchema);
        const valid = validator(p.arguments);
        if (!valid.valid) fail("Input does not match discovered tool schema");
        const result = await executeExternalMcp(
          this.host.core().guard,
          this.context(),
          [s.transport === "stdio" ? "shell.execute" : "network.access"],
          { server: id, tool: t.name },
          () =>
            client.callTool({ name: t.name, arguments: object(p.arguments) }, undefined, {
              timeout: 30000,
              signal: this.context().signal,
            }),
        );
        return { ok: true, result };
      }
      case "tasks.list":
        return {
          ok: true,
          tasks: this.state.tasks
            .filter((t) => (!p.project || t.project === p.project) && (!p.agent || t.agent === p.agent))
            .slice()
            .reverse(),
        };
      case "tasks.cancel": {
        const t = this.state.tasks.find((t) => t.id === id) ?? fail("Unknown task");
        await this.cancel(t);
        await this.persist();
        await this.event(method, t.project, t.agent);
        return { ok: true };
      }
      case "tasks.retry": {
        const t = this.state.tasks.find((t) => t.id === id) ?? fail("Unknown task");
        if (t.state === "Running") fail("Task is running");
        if (t.project !== this.state.active) fail("Select the task project before retrying");
        const replay = this.vault.replays[id] ?? fail("This task has no replay");
        const context =
          this.contexts.get(id) ??
          (replay.context
            ? {
                principal: replay.context.principal,
                ...(replay.context.scopeId ? { exposureScope: { id: replay.context.scopeId } } : {}),
              }
            : undefined);
        if (!context || context.principal.kind !== "local") fail("Retry requires a local agent context");
        if (replay.member === "$product") {
          void this.request(replay.method as ProductMethod, replay.input[0]).catch(() => undefined);
          return { ok: true };
        }
        const service = object(Reflect.get(this.host.core(), replay.member));
        const fn = service[replay.method];
        if (typeof fn !== "function") fail("Replay unavailable");
        void this.execute(replay.member, replay.method, [context, ...replay.input], (a) =>
          Reflect.apply(fn as (...args: unknown[]) => unknown, service, a),
        ).catch(() => undefined);
        return { ok: true };
      }
      case "monitoring.queryAudit":
        return { ok: true, events: await this.queryAudit(p) };
      case "monitoring.metrics":
        return {
          ok: true,
          workspace: this.activeProject.id,
          core: this.host.core().status(),
          tasks: {
            running: this.state.tasks.filter((t) => t.state === "Running").length,
            total: this.state.tasks.length,
          },
          connectedServers: this.clients.size,
        };
      case "monitoring.exportReport":
        return {
          ok: true,
          report: {
            generatedAt: now(),
            project: this.state.active,
            events: await this.queryAudit(p),
            tasks: this.state.tasks.map((t) => ({ ...t })),
            secrets: "redacted; request/response bodies omitted",
          },
        };
    }
  }
  private async testConnector(id: string): Promise<Record<string, unknown>> {
    const c = this.state.connectors.find((c) => c.id === id) ?? fail("Configure the connector first");
    if (!c.enabled || !c.configured) fail("Connector is disconnected");
    if (this.activeProject.connectors.length && !this.activeProject.connectors.includes(id))
      fail("Connector is not enabled in project settings");
    if (c.projects.length && !c.projects.includes(this.state.active)) fail("Connector is not allowed for this project");
    const started = Date.now();
    const endpoints: Record<string, [string, string]> = {
      GitHub: ["https://api.github.com/user", "Bearer"],
      GitLab: ["https://gitlab.com/api/v4/user", "Bearer"],
      ElevenLabs: ["https://api.elevenlabs.io/v1/user", "xi-api-key"],
      YouTube: ["https://www.googleapis.com/youtube/v3/channels?part=id&mine=true", "Bearer"],
      TikTok: ["https://open.tiktokapis.com/v2/user/info/?fields=open_id", "Bearer"],
      Notion: ["https://api.notion.com/v1/users/me", "Bearer"],
      "Google Drive": ["https://www.googleapis.com/drive/v3/about?fields=user", "Bearer"],
      Slack: ["https://slack.com/api/auth.test", "Bearer"],
      "Custom HTTP API": [c.endpoint ?? "", "Bearer"],
    };
    try {
      if (id === "FFmpeg Media Pipeline") {
        const result = await this.host
          .core()
          .processes.exec(this.context(), { command: "ffmpeg", args: ["-version"], cwd: this.activeProject.path });
        c.status = result.exitCode === 0 ? "Connected" : "Failed";
      } else {
        const [url, auth] = endpoints[id] ?? fail("Unknown connector");
        if (!url) fail("Endpoint required");
        const credential = this.vault.credentials[id] ?? fail("Credential unavailable");
        const headers: Record<string, string> =
          auth === "xi-api-key" ? { "xi-api-key": credential } : { Authorization: `Bearer ${credential}` };
        const r = await this.host.core().network.request(this.context(), {
          url,
          method: "GET",
          headers: { ...headers, ...(id === "Notion" ? { "Notion-Version": "2022-06-28" } : {}) },
          followRedirects: false,
          timeoutMs: 8000,
          maxResponseBytes: 65536,
        });
        c.httpStatus = r.status;
        let providerOk = true;
        if (id === "Slack" || id === "TikTok") {
          const data = JSON.parse(r.body) as Record<string, unknown>;
          providerOk = id === "Slack" ? data.ok === true : object(data.error).code === "ok";
        }
        c.status =
          r.status === 401 || r.status === 403
            ? "Token rejected"
            : r.status >= 200 && r.status < 300 && providerOk
              ? "Connected"
              : "Failed";
      }
    } catch {
      c.status = "Failed — network/permission/provider unavailable";
    }
    c.checkedAt = now();
    c.latencyMs = Date.now() - started;
    await this.persist();
    await this.event("connectors.testConnection");
    return { ok: true, connector: c };
  }
  private async connectServer(id: string): Promise<Record<string, unknown>> {
    const pending = this.connecting.get(id);
    if (pending) return pending;
    const controller = new AbortController(),
      current = this.context();
    this.serverControllers.set(id, controller);
    const signal = current.signal ? AbortSignal.any([current.signal, controller.signal]) : controller.signal;
    const work = this.operationContext.run({ ...current, signal }, () => this.connectServerImpl(id));
    this.connecting.set(id, work);
    try {
      return await work;
    } finally {
      this.connecting.delete(id);
      this.serverControllers.delete(id);
    }
  }
  private async connectServerImpl(id: string): Promise<Record<string, unknown>> {
    const s = this.state.servers.find((v) => v.id === id) ?? fail("Unknown MCP server");
    if (this.clients.has(id)) return { ok: true, server: s };
    s.status = "Connecting";
    this.serverLog(s, "connecting");
    const client = new Client({ name: "crot-outbound", version: "0.1.0" });
    try {
      let transport: Transport;
      if (s.transport === "stdio") {
        const proc = await this.host
          .core()
          .processes.openTransport(this.context(), { command: s.command!, args: s.args, cwd: this.activeProject.path });
        transport = new PipeTransport(proc);
      } else {
        const token = this.vault.credentials[s.id];
        transport = new StreamableHTTPClientTransport(new URL(s.url!), {
          fetch: async (url, init) => {
            const target = new URL(String(url));
            if (target.origin !== new URL(s.url!).origin) throw new Error("Cross-origin MCP transport refused");
            const headers = Object.fromEntries(new Headers(init?.headers).entries());
            if (token) headers.authorization = `Bearer ${token}`;
            const context = this.context();
            const signals = [context.signal, init?.signal].filter((s): s is AbortSignal => !!s);
            const requestContext = signals.length ? { ...context, signal: AbortSignal.any(signals) } : context;
            const r = await this.host.core().network.request(requestContext, {
              url: target.href,
              method: (init?.method ?? "GET") as "GET" | "POST" | "DELETE",
              headers,
              ...(typeof init?.body === "string" ? { body: init.body } : {}),
              followRedirects: false,
              maxResponseBytes: 1024 * 1024,
              timeoutMs: 10000,
            });
            return new Response(r.body || null, {
              status: r.status,
              headers: Object.fromEntries(
                Object.entries(r.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]),
              ),
            });
          },
        });
      }
      client.onclose = () => {
        this.clients.delete(id);
        s.status = "Disconnected";
        this.serverLog(s, "disconnected");
        void this.persist().catch(() => undefined);
      };
      await client.connect(transport, { timeout: 10000, signal: this.context().signal });
      const tools = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await executeExternalMcp(
          this.host.core().guard,
          this.context(),
          [],
          { server: id, discovery: "tools" },
          () => client.listTools(cursor ? { cursor } : undefined),
        );
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (++pages > 100 || tools.length > 500) fail("Too many MCP tools");
      } while (cursor);
      s.tools = tools.map((t) => {
        this.schemaValidator.getValidator(t.inputSchema);
        return {
          name: t.name,
          inputSchema: t.inputSchema,
          ...(t.description ? { description: t.description.slice(0, 2000) } : {}),
        };
      });
      s.resources = [];
      if (client.getServerCapabilities()?.resources) {
        do {
          const page = await executeExternalMcp(
            this.host.core().guard,
            this.context(),
            [],
            { server: id, discovery: "resources" },
            () => client.listResources(cursor ? { cursor } : undefined),
          );
          s.resources.push(...page.resources);
          cursor = page.nextCursor;
          if (++pages > 100 || s.resources.length > 500) fail("Too many MCP resources");
        } while (cursor);
      }
      this.clients.set(id, client);
      s.status = "Connected";
      this.serverLog(s, "discovered");
    } catch (error) {
      await client.close().catch(() => undefined);
      s.status = "Failed";
      this.serverLog(s, error instanceof CrotError ? `connection_failed:${error.code}` : "connection_failed:protocol");
    }
    await this.persist();
    await this.event("mcpServers.connect");
    return { ok: true, server: s };
  }
  private serverLog(s: McpServer, event: string): void {
    s.logs = limited([...s.logs, { time: now(), event }], 100);
  }
  private agentId(context: AuthContext): string {
    const p = context.principal;
    return p.kind === "remote"
      ? `remote:${JSON.stringify([p.accountId, p.deviceId, p.clientId])}`
      : `local:${context.exposureScope?.id ?? context.session?.id ?? p.transport}`;
  }
  /** Narrowing authorization hook inside ExecutionGuard; never grants a Core capability. */
  authorize(context: AuthContext, operation: string): void {
    if (context.principal.transport === "owner-product") return;
    const id = this.agentId(context),
      a = this.state.agents.find((a) => a.id === id),
      project = this.activeProject;
    if (
      a &&
      (a.revoked ||
        (a.projects.length > 0 && !a.projects.includes(project.id)) ||
        (!a.browser && operation.startsWith("browser.")))
    )
      throw new CrotError("PERMISSION_DENIED", "Agent policy refuses this operation");
    if (project.agents.length && !project.agents.includes(id))
      throw new CrotError("PERMISSION_DENIED", "Agent is not allowed for the active project");
    if (project.tools.length && !project.tools.includes(operation))
      throw new CrotError("PERMISSION_DENIED", "Operation is not allowed for this project");
  }
  /** Called by CoreHolder for every adapter capability operation, using adapter-created identity only. */
  async execute(member: string, method: string, args: unknown[], run: (args: unknown[]) => unknown): Promise<unknown> {
    const context = args[0] as AuthContext;
    if (!context?.principal || !this.state) return run(args);
    const id = this.agentId(context);
    let a = this.state.agents.find((a) => a.id === id);
    if (!a) {
      a = {
        id,
        name: context.principal.client?.name ?? context.principal.transport,
        kind: context.principal.kind,
        connected: true,
        projects: [],
        browser: true,
        requestsPerMinute: 600,
        revoked: false,
        calls: 0,
        lastSeen: now(),
      };
      this.state.agents.push(a);
    }
    a.connected = true;
    a.calls++;
    a.lastSeen = now();
    const timestamps = (this.rate.get(id) ?? []).filter((t) => t > Date.now() - 60000);
    timestamps.push(Date.now());
    this.rate.set(id, timestamps);
    if (timestamps.length > a.requestsPerMinute) throw new CrotError("LIMIT_EXCEEDED", "Agent request limit exceeded");
    if (member === "processes" && ["list", "readOutput"].includes(method)) return run(args);
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) controller.abort();
    const correlated = {
      ...context,
      signal: controller.signal,
      requestId: randomUUID(),
      productContext: { project: this.state.active, agent: id },
    };
    const task: Task = {
      id: correlated.requestId,
      operation: `${member}.${method}`,
      project: this.state.active,
      agent: id,
      state: "Running",
      progress: 0,
      startedAt: now(),
      artifacts: [],
      retryable: context.principal.kind === "local",
    };
    this.state.tasks = limited([...this.state.tasks, task]);
    this.cancellations.set(task.id, controller);
    this.contexts.set(task.id, context);
    if (task.retryable)
      this.vault.replays[task.id] = {
        member,
        method,
        input: args.slice(1),
        context: { principal: context.principal, scopeId: context.exposureScope?.id ?? context.session?.id },
      };
    await this.persist();
    try {
      const result = await run([correlated, ...args.slice(1)]);
      const data = object(result);
      if (member === "processes" && method === "start" && typeof data.id === "string") {
        task.processId = data.id;
        // Cancellation may arrive before process.start returns its managed ID (including during audit).
        // Do not orphan a process whose task has already been marked Cancelled.
        if (controller.signal.aborted) {
          await this.stopTaskProcess(task);
          task.state = "Cancelled";
          task.endedAt = now();
          this.cancellations.delete(task.id);
        }
      } else {
        task.state = controller.signal.aborted ? "Cancelled" : "Completed";
        task.progress = 100;
        task.endedAt = now();
      }
      if (member === "filesystem" && ["writeFile", "createDirectory"].includes(method) && typeof data.path === "string")
        task.artifacts.push(data.path);
      return result;
    } catch (e) {
      task.state = controller.signal.aborted ? "Cancelled" : "Failed";
      task.endedAt = now();
      task.errorCode = e instanceof CrotError ? e.code : "OPERATION_FAILED";
      throw e;
    } finally {
      context.signal?.removeEventListener("abort", abort);
      if (!task.processId) this.cancellations.delete(task.id);
      await this.persist();
    }
  }
  private async cancel(t: Task): Promise<void> {
    if (t.state !== "Running") fail("Task is not running");
    this.cancellations.get(t.id)?.abort();
    await this.stopTaskProcess(t);
    t.state = "Cancelled";
    t.endedAt = now();
    this.cancellations.delete(t.id);
  }
  private async stopTaskProcess(t: Task): Promise<void> {
    if (!t.processId) return;
    await this.host
      .core()
      .processes.stop(
        { principal: localPrincipal("owner-product"), productContext: { project: t.project, agent: t.agent } },
        { id: t.processId, force: true },
      );
  }
  private async pollProcesses(): Promise<void> {
    const pending = this.state.tasks.filter((t) => t.state === "Running" && t.processId);
    if (!pending.length) return;
    const processes = await this.host.core().processes.list(this.context());
    let changed = false;
    for (const t of pending) {
      const proc = processes.find((p) => p.id === t.processId);
      if (proc && proc.endedAt) {
        t.state = proc.exitCode === 0 ? "Completed" : "Failed";
        t.progress = 100;
        t.endedAt = now();
        changed = true;
        this.cancellations.delete(t.id);
      }
    }
    if (changed) await this.persist();
  }
  private async queryAudit(p: Record<string, unknown>): Promise<unknown[]> {
    const audit = this.host.core().status().audit;
    if (!audit.path) return [];
    const lines = createInterface({ input: createReadStream(audit.path, { encoding: "utf8" }), crlfDelay: Infinity });
    const tasks = new Map(this.state.tasks.map((t) => [t.id, t]));
    const result: unknown[] = [];
    for await (const line of lines) {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const task = tasks.get(String(e.requestId));
      const details = object(e.details);
      const project = task?.project ?? details.project;
      const agent = task?.agent ?? details.agent;
      const type = e.operation ?? e.action ?? e.event ?? e.kind;
      if (
        (p.from && String(e.timestamp) < String(p.from)) ||
        (p.to && String(e.timestamp) > String(p.to)) ||
        (p.project && project !== p.project) ||
        (p.agent && agent !== p.agent) ||
        (p.type && type !== p.type)
      )
        continue;
      // Allowlist, not blacklist: paths, command lines, headers, bodies, error messages and principal client metadata are omitted.
      if (result.length >= Number(p.limit ?? 200)) result.shift();
      result.push({
        id: e.id,
        timestamp: e.timestamp,
        type,
        outcome: e.outcome,
        durationMs: e.durationMs,
        project: project ?? null,
        agent: agent ?? null,
        errorCode: object(e.error).code ?? null,
      });
    }
    return result.slice(-Number(p.limit ?? 200)).reverse();
  }
  async close(): Promise<void> {
    clearInterval(this.poller);
    for (const controller of this.serverControllers.values()) controller.abort();
    await Promise.all([...this.connecting.values()].map((p) => p.catch(() => undefined)));
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => undefined)));
    await this.persist();
    await this.writes;
  }
}
