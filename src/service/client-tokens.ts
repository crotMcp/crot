/** Named loopback bearer credentials. Only hashes persist; Core remains the authorizer. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Principal } from "../core/auth/principal.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import { CrotError } from "../core/errors.js";
import { writePrivateFileAtomic } from "./secrets/backends.js";

export const TokenScopeSchema = z.enum(["files", "terminal", "browser"]);
export const TokenIssueSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[^\r\n\0]*$/),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(365 * 86400),
    scopes: z
      .array(TokenScopeSchema)
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
const recordSchema = TokenIssueSchema.omit({ ttlSeconds: true })
  .extend({
    id: z.string().uuid(),
    generation: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative().optional(),
    active: z.boolean(),
  })
  .strict();
const fileSchema = z.object({ version: z.literal(1), tokens: z.array(recordSchema).max(256) }).strict();
type TokenRecord = z.infer<typeof recordSchema>;
export const clientTokenPath = (dir: string) => path.join(dir, "client-tokens.json");
const hash = (value: string) => createHash("sha256").update(value).digest();
interface Options {
  file: string;
  privateFiles: PrivateFileProtection;
  audit(action: "token_issue" | "token_rotate" | "token_revoke", id: string): Promise<void>;
  invalidate(id: string, generation: string): Promise<void>;
  failClosed(): void;
  clock?: () => number;
}
export class ClientTokenRegistry {
  private tokens: TokenRecord[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private broken = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly expired = new Set<string>();
  private readonly clock: () => number;
  private constructor(private readonly options: Options) {
    this.clock = options.clock ?? Date.now;
  }
  static async open(options: Options): Promise<ClientTokenRegistry> {
    const registry = new ClientTokenRegistry(options);
    try {
      // Missing files are handled before protectFile: Windows ACL backends may wrap ENOENT.
      const info = await lstat(options.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
        throw new CrotError("CONFIG_ERROR", "Invalid client-token registry file");
      // Protect before reading, including on Windows where mode bits alone are insufficient.
      if (options.privateFiles.protectFile) await options.privateFiles.protectFile(options.file);
      registry.tokens = fileSchema.parse(JSON.parse(await readFile(options.file, "utf8"))).tokens;
      if (new Set(registry.tokens.map((t) => t.id)).size !== registry.tokens.length)
        throw new Error("Duplicate token IDs");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    registry.timer = setInterval(() => void registry.sweep(), 250);
    registry.timer.unref();
    return registry;
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async save(): Promise<void> {
    try {
      await writePrivateFileAtomic(
        this.options.file,
        JSON.stringify({ version: 1, tokens: this.tokens }),
        this.options.privateFiles,
      );
    } catch (error) {
      this.broken = true;
      this.options.failClosed();
      throw error;
    }
  }
  list(): Record<string, unknown>[] {
    return this.tokens.map(({ digest: _digest, generation: _generation, ...t }) => ({
      ...t,
      active: !this.broken && t.active && t.expiresAt > this.clock(),
    }));
  }
  issue(input: unknown): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const { ttlSeconds, ...p } = TokenIssueSchema.parse(input);
      if (this.broken || this.tokens.length >= 256)
        throw new CrotError("LIMIT_EXCEEDED", "Token registry unavailable or full");
      const token = randomBytes(32).toString("base64url"),
        time = this.clock();
      const record: TokenRecord = {
        ...p,
        id: randomUUID(),
        generation: randomUUID(),
        digest: hash(token).toString("hex"),
        issuedAt: time,
        expiresAt: time + ttlSeconds * 1000,
        active: false,
      };
      // Pending credentials never authenticate, including after a crash before the mandatory audit.
      this.tokens.push(record);
      await this.save();
      await this.options.audit("token_issue", record.id);
      record.active = true;
      await this.save();
      return { ok: true, id: record.id, token, expiresAt: record.expiresAt };
    });
  }
  rotate(id: string): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const record = this.tokens.find((t) => t.id === id);
      if (this.broken || !record?.active || record.expiresAt <= this.clock())
        throw new CrotError("INVALID_INPUT", "Token is not active");
      await this.deactivate(record);
      const token = randomBytes(32).toString("base64url");
      record.generation = randomUUID();
      record.digest = hash(token).toString("hex");
      delete record.lastUsedAt;
      await this.save();
      await this.options.audit("token_rotate", id);
      record.active = true;
      await this.save();
      return { ok: true, id, token, expiresAt: record.expiresAt };
    });
  }
  revoke(id: string): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const record = this.tokens.find((t) => t.id === id);
      if (!record) throw new CrotError("INVALID_INPUT", "Unknown token");
      await this.deactivate(record);
      await this.options.audit("token_revoke", id);
      return { ok: true, id };
    });
  }
  private async deactivate(record: TokenRecord): Promise<void> {
    record.active = false;
    // Invalidate immediately, persist the tombstone even if resource cleanup fails.
    const results = await Promise.allSettled([this.options.invalidate(record.id, record.generation), this.save()]);
    const failure = results.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") {
      this.broken = true;
      this.options.failClosed();
      throw failure.reason;
    }
  }
  verifyAccessToken(token: string): Promise<AuthInfo | undefined> {
    return this.serial(async () => {
      if (this.broken || token.length > 512) return undefined;
      const digest = hash(token);
      const record = this.tokens.find((t) => timingSafeEqual(digest, Buffer.from(t.digest, "hex")));
      if (!record?.active || record.expiresAt <= this.clock()) return undefined;
      record.lastUsedAt = this.clock();
      await this.save();
      const subject = `client-token:${record.id}:${record.generation}`;
      return {
        token,
        clientId: subject,
        scopes: [...record.scopes],
        expiresAt: Math.floor(record.expiresAt / 1000),
        extra: { subject, authMethod: "scoped-token", tokenId: record.id, tokenGeneration: record.generation },
      };
    });
  }
  /** Called within ExecutionGuard, again after approval; never accepts client-supplied names/scopes. */
  authorize(principal: Principal): void {
    if (!principal.tokenAccess) return;
    const binding = principal.tokenAccess;
    const record = this.tokens.find((t) => t.id === binding.id && t.generation === binding.generation);
    if (
      this.broken ||
      !record?.active ||
      record.expiresAt <= this.clock() ||
      record.scopes.join() !== binding.scopes.join()
    )
      throw new CrotError("PERMISSION_DENIED", "Client token expired or revoked");
  }
  private async sweep(): Promise<void> {
    for (const record of this.tokens) {
      if (!record.active || record.expiresAt > this.clock() || this.expired.has(record.generation)) continue;
      this.expired.add(record.generation);
      try {
        await this.options.invalidate(record.id, record.generation);
      } catch {
        this.broken = true;
        this.options.failClosed();
      }
    }
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.queue;
  }
}
