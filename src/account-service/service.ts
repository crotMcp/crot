/** Cloud-only commercial metadata. Never imported by Core or PermissionEngine (AD-34). */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { isDeviceId } from "../identity/device-id.js";
import type { BillingProvider, SubscriptionUpdate } from "./billing.js";

export type Plan = "free" | "trial" | "pro" | "team";
export type SubscriptionStatus = "active" | "past_due" | "canceled" | "expired";
export interface CommercialView {
  plan: Plan;
  status: SubscriptionStatus;
  entitled: boolean;
  remoteEnabled: boolean;
  deviceCount: number;
  maxDevices: number;
  expiresAt?: number;
}
export interface ClientMetadata {
  clientId: string;
  lastSeen: number;
  sessionIds?: string[];
}
export interface Device {
  deviceId: string;
  registeredAt: number;
  revoked: boolean;
  clients: ClientMetadata[];
}
export interface Account {
  accountId: string;
  plan: Plan;
  status: SubscriptionStatus;
  expiresAt?: number;
  trialUsed: boolean;
  subscriptionId?: string;
  retiredSubscriptions?: string[];
  devices: Device[];
}
export interface State {
  version: 1;
  accounts: Account[];
  events: string[];
}
export type RegistrationDecision =
  "created" | "unchanged" | "conflict" | "entitlement_required" | "device_limit_reached" | "device_revoked";
export interface AuthorizationRevoker {
  revokeSession(sessionId: string): Promise<void>;
}
const only = (v: object, keys: string[]) => Object.keys(v).every((k) => keys.includes(k));
const LIMITS: Record<Plan, number> = { free: 0, trial: 2, pro: 5, team: 20 };
const validId = (v: unknown): v is string => typeof v === "string" && /^[\x21-\x7e]{1,512}$/.test(v);

/** Cloud boundary for replacing the single-host durable adapter with transactional shared storage. */
export interface CommercialService {
  snapshot(accountId: string): CommercialView;
  devices(
    accountId: string,
  ): ReadonlyArray<{ deviceId: string; registeredAt: number; revoked: boolean; clients: ClientMetadata[] }>;
  deviceState(accountId: string, deviceId: string): "entitled" | "not_entitled" | "device_revoked";
  isRevoked(deviceId: string): boolean;
  onChange(fn: () => void): () => void;
  trialAvailable(accountId: string): boolean;
  billingPortal(accountId: string, provider: BillingProvider): Promise<string>;
  register(
    accountId: string,
    deviceId: string,
    commit: () => Promise<"created" | "unchanged" | "conflict">,
  ): Promise<RegistrationDecision>;
  revoke(accountId: string, deviceId: string): Promise<boolean>;
  noteClient(accountId: string, deviceId: string, clientId: string, sessionId?: string): Promise<void>;
  revokeProvider(
    accountId: string,
    deviceId: string,
    clientId?: string,
  ): Promise<"requested" | "failed" | "not_available">;
  billing(provider: BillingProvider, raw: Buffer, signature: string): Promise<boolean>;
}

/** One serial transaction domain for quota, subscription and revocation, with durable-before-visible writes. */
export class AccountService implements CommercialService {
  private state: State = { version: 1, accounts: [], events: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly options: { file?: string; now?: () => number; revoker?: AuthorizationRevoker } = {}) {}
  static async open(
    file: string,
    options: { now?: () => number; revoker?: AuthorizationRevoker } = {},
  ): Promise<AccountService> {
    const service = new AccountService({ ...options, file });
    try {
      const bytes = await readFile(file);
      if (bytes.length > 32 * 1024 * 1024) throw new Error("account metadata too large");
      const state = JSON.parse(bytes.toString("utf8")) as State;
      AccountService.validateState(state);
      service.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return service;
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  static validateState(state: State): void {
    if (
      !state ||
      !only(state, ["version", "accounts", "events"]) ||
      state.version !== 1 ||
      !Array.isArray(state.accounts) ||
      !Array.isArray(state.events) ||
      state.accounts.length > 100_000 ||
      state.events.length > 10_000 ||
      state.events.some((e) => !validId(e))
    )
      throw new Error("invalid commercial metadata");
    const accounts = new Set<string>(),
      devices = new Set<string>();
    for (const a of state.accounts) {
      if (
        !only(a, [
          "accountId",
          "plan",
          "status",
          "expiresAt",
          "trialUsed",
          "subscriptionId",
          "retiredSubscriptions",
          "devices",
        ]) ||
        !validId(a.accountId) ||
        accounts.has(a.accountId) ||
        !["free", "trial", "pro", "team"].includes(a.plan) ||
        !["active", "past_due", "canceled", "expired"].includes(a.status) ||
        typeof a.trialUsed !== "boolean" ||
        (a.expiresAt !== undefined && (!Number.isSafeInteger(a.expiresAt) || a.expiresAt < 0)) ||
        (a.plan !== "free" && a.expiresAt === undefined) ||
        (a.retiredSubscriptions !== undefined &&
          (!Array.isArray(a.retiredSubscriptions) || a.retiredSubscriptions.some((id) => !validId(id)))) ||
        (a.subscriptionId !== undefined && !validId(a.subscriptionId)) ||
        !Array.isArray(a.devices)
      )
        throw new Error("invalid commercial account");
      accounts.add(a.accountId);
      for (const d of a.devices) {
        if (
          !only(d, ["deviceId", "registeredAt", "revoked", "clients"]) ||
          !isDeviceId(d.deviceId) ||
          devices.has(d.deviceId) ||
          !Number.isSafeInteger(d.registeredAt) ||
          typeof d.revoked !== "boolean" ||
          !Array.isArray(d.clients) ||
          d.clients.length > 1000
        )
          throw new Error("invalid commercial device");
        devices.add(d.deviceId);
        for (const c of d.clients)
          if (
            !only(c, ["clientId", "lastSeen", "sessionIds"]) ||
            !validId(c.clientId) ||
            !Number.isSafeInteger(c.lastSeen) ||
            (c.sessionIds !== undefined &&
              (!Array.isArray(c.sessionIds) ||
                c.sessionIds.length > 32 ||
                c.sessionIds.some((id) => !/^session_[A-Za-z0-9]+$/.test(id))))
          )
            throw new Error("invalid commercial client");
      }
    }
  }
  private async mutate<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const result = await fn(next);
      AccountService.validateState(next);
      if (this.options.file) {
        await mkdir(path.dirname(this.options.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.options.file}.${randomUUID()}.tmp`;
        try {
          const handle = await open(tmp, "wx", 0o600);
          try {
            await handle.writeFile(JSON.stringify(next) + "\n");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(tmp, this.options.file);
        } finally {
          await unlink(tmp).catch(() => undefined);
        }
      }
      this.state = next;
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          /* observers cannot undo a commit */
        }
      }
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  private account(state: State, id: string): Account {
    if (!validId(id)) throw new Error("invalid account id");
    let a = state.accounts.find((a) => a.accountId === id);
    if (!a) {
      a = { accountId: id, plan: "free", status: "active", trialUsed: false, devices: [] };
      state.accounts.push(a);
    }
    return a;
  }
  private view(a?: Account): CommercialView {
    const plan = a?.plan ?? "free";
    const status = a?.expiresAt !== undefined && a.expiresAt <= this.now() ? "expired" : (a?.status ?? "active");
    const enabled = plan !== "free" && status === "active";
    return {
      plan,
      status,
      entitled: enabled,
      remoteEnabled: enabled,
      maxDevices: LIMITS[plan],
      deviceCount: a?.devices.filter((d) => !d.revoked).length ?? 0,
      ...(a?.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {}),
    };
  }
  snapshot(accountId: string): CommercialView {
    return this.view(this.state.accounts.find((a) => a.accountId === accountId));
  }
  devices(
    accountId: string,
  ): ReadonlyArray<{ deviceId: string; registeredAt: number; revoked: boolean; clients: ClientMetadata[] }> {
    return structuredClone(this.state.accounts.find((a) => a.accountId === accountId)?.devices ?? []);
  }
  deviceState(accountId: string, deviceId: string): "entitled" | "not_entitled" | "device_revoked" {
    const a = this.state.accounts.find((a) => a.accountId === accountId),
      d = a?.devices.find((d) => d.deviceId === deviceId);
    if (d?.revoked) return "device_revoked";
    // Device ranks make a downgrade to a smaller plan deterministic and enforce the new limit immediately.
    const admitted = a?.devices
      .filter((d) => !d.revoked)
      .slice(0, this.view(a).maxDevices)
      .some((d) => d.deviceId === deviceId);
    return d && admitted && this.view(a).entitled ? "entitled" : "not_entitled";
  }
  isRevoked(deviceId: string): boolean {
    return this.state.accounts.some((a) => a.devices.some((d) => d.deviceId === deviceId && d.revoked));
  }
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  trialAvailable(accountId: string): boolean {
    const account = this.state.accounts.find((a) => a.accountId === accountId);
    return !account || (!account.trialUsed && account.plan === "free");
  }
  async billingPortal(accountId: string, provider: BillingProvider): Promise<string> {
    const account = this.state.accounts.find((a) => a.accountId === accountId);
    if (!account?.subscriptionId || !provider.portal) throw new Error("billing portal unavailable");
    return provider.portal(accountId, account.subscriptionId);
  }
  /** Legacy trusted provisioning helper for existing fixtures. Never routed from owner HTTP.
   * Remove after fixture migration; hosted trial activation uses verified Stripe billing only. */
  async startTrial(accountId: string): Promise<boolean> {
    return this.mutate((state) => {
      const a = this.account(state, accountId);
      if (a.trialUsed || a.plan !== "free") return false;
      a.trialUsed = true;
      a.plan = "trial";
      a.status = "active";
      a.expiresAt = this.now() + 7 * 86400_000;
      return true;
    });
  }
  /** Persist a reservation first. A crash before registry commit is harmless: retry fills the same reserved slot.
   * Registry writes never create entitlement by themselves; failure may retain a recoverable reservation. */
  async register(
    accountId: string,
    deviceId: string,
    commit: () => Promise<"created" | "unchanged" | "conflict">,
  ): Promise<RegistrationDecision> {
    if (!isDeviceId(deviceId)) throw new Error("invalid device id");
    const decision = await this.mutate((state) => {
      const owner = state.accounts.find((a) => a.devices.some((d) => d.deviceId === deviceId));
      if (owner && owner.accountId !== accountId) return "conflict" as const;
      const a = this.account(state, accountId),
        d = a.devices.find((d) => d.deviceId === deviceId);
      if (d?.revoked) return "device_revoked" as const;
      if (!this.view(a).entitled) return "entitlement_required" as const;
      if (d) return "unchanged" as const;
      if (this.view(a).deviceCount >= LIMITS[a.plan]) return "device_limit_reached" as const;
      a.devices.push({ deviceId, registeredAt: this.now(), revoked: false, clients: [] });
      return "created" as const;
    });
    if (decision !== "created" && decision !== "unchanged") return decision;
    // A concurrent downgrade/revocation cannot grant access: every later admission repeats deviceState.
    return commit();
  }
  async revoke(accountId: string, deviceId: string): Promise<boolean> {
    return this.mutate((state) => {
      const d = state.accounts.find((a) => a.accountId === accountId)?.devices.find((d) => d.deviceId === deviceId);
      if (!d) return false;
      d.revoked = true;
      return true;
    });
  }
  async noteClient(accountId: string, deviceId: string, clientId: string, sessionId?: string): Promise<void> {
    if (!validId(clientId) || (sessionId !== undefined && !validId(sessionId))) return;
    // Persist at most once per minute per client, bounded metadata, never tokens or request content.
    const old = this.state.accounts
      .find((a) => a.accountId === accountId)
      ?.devices.find((d) => d.deviceId === deviceId)
      ?.clients.find((c) => c.clientId === clientId);
    if (old && (!sessionId || old.sessionIds?.includes(sessionId)) && this.now() - old.lastSeen < 60_000) return;
    await this.mutate((state) => {
      const d = state.accounts.find((a) => a.accountId === accountId)?.devices.find((d) => d.deviceId === deviceId);
      if (!d || d.revoked) return;
      const c = d.clients.find((c) => c.clientId === clientId);
      if (c) {
        c.lastSeen = this.now();
        if (sessionId && !c.sessionIds?.includes(sessionId)) {
          c.sessionIds ??= [];
          if (c.sessionIds.length < 32) c.sessionIds.push(sessionId);
        }
      } else if (d.clients.length < 1000)
        d.clients.push({ clientId, lastSeen: this.now(), ...(sessionId ? { sessionIds: [sessionId] } : {}) });
    });
  }
  async revokeProvider(
    accountId: string,
    deviceId: string,
    clientId?: string,
  ): Promise<"requested" | "failed" | "not_available"> {
    if (!this.options.revoker) return "not_available";
    const clients =
      this.devices(accountId)
        .find((d) => d.deviceId === deviceId)
        ?.clients.filter((c) => !clientId || c.clientId === clientId) ?? [];
    const sessions = [...new Set(clients.flatMap((c) => c.sessionIds ?? []))];
    if (!sessions.length) return "not_available"; // Never guess or revoke unrelated account sessions.
    try {
      await Promise.all(sessions.map((id) => this.options.revoker!.revokeSession(id)));
      return "requested";
    } catch {
      return "failed";
    }
  }
  async billing(provider: BillingProvider, raw: Buffer, signature: string): Promise<boolean> {
    return this.mutate(async (state) => {
      // Verification + authoritative provider read are inside the transaction, avoiding reordered reads.
      const update = await provider.verifyAndResolve(raw, signature);
      if (!update || state.events.includes(update.eventId)) return false;
      if (
        state.accounts.some(
          (a) =>
            a.accountId !== update.accountId &&
            (a.subscriptionId === update.subscriptionId || a.retiredSubscriptions?.includes(update.subscriptionId)),
        )
      )
        throw new Error("subscription ownership conflict");
      this.apply(this.account(state, update.accountId), update);
      state.events.push(update.eventId);
      if (state.events.length > 10_000) state.events.shift();
      return true;
    });
  }
  private apply(a: Account, u: SubscriptionUpdate): void {
    if (
      !validId(u.eventId) ||
      !validId(u.accountId) ||
      !validId(u.subscriptionId) ||
      !["trial", "pro", "team"].includes(u.plan) ||
      !["active", "past_due", "canceled", "expired"].includes(u.status) ||
      !Number.isSafeInteger(u.expiresAt) ||
      u.expiresAt < 0
    )
      throw new Error("invalid subscription update");
    if (a.retiredSubscriptions?.includes(u.subscriptionId)) return;
    if (a.subscriptionId && a.subscriptionId !== u.subscriptionId) {
      if (this.view(a).entitled) return;
      a.retiredSubscriptions = [...(a.retiredSubscriptions ?? []), a.subscriptionId];
    }
    if (u.plan === "trial") {
      if (a.trialUsed && a.subscriptionId !== u.subscriptionId) throw new Error("trial already used");
      a.trialUsed = true;
    }
    a.subscriptionId = u.subscriptionId;
    a.plan = u.plan;
    a.status = u.status;
    a.expiresAt = u.expiresAt;
  }
}
