/** Owner-only product configuration RPCs. Tool execution is never accepted as arbitrary RPC. */
import { ChatConfigureSchema, ChatProviderSchema, ChatStartSchema } from "./chat-protocol.js";
import { TokenIssueSchema } from "./client-tokens.js";
import { z } from "zod";
import { RuntimePolicySchema } from "../core/permissions/runtime.js";
const id = z.string().min(1).max(256);
const list = z.array(id).max(256);
const grants = { projects: list.default([]), agents: list.default([]) };
const filter = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    project: id.optional(),
    agent: id.optional(),
    type: id.optional(),
    limit: z.number().int().min(1).max(1000).default(200),
  })
  .strict();
export const PRODUCT_SCHEMAS = {
  "chat.providers": z.object({}).strict(),
  "chat.configure": ChatConfigureSchema,
  "chat.models": z.object({ provider: ChatProviderSchema }).strict(),
  "chat.start": ChatStartSchema,
  "chat.poll": z.object({ id }).strict(),
  "chat.stop": z.object({ id }).strict(),
  "tokens.list": z.object({}).strict(),
  "tokens.issue": TokenIssueSchema,
  "tokens.rotate": z.object({ id }).strict(),
  "tokens.revoke": z.object({ id }).strict(),
  "security.status": z.object({}).strict(),
  "security.kill": z.object({}).strict(),
  "security.setPolicy": RuntimePolicySchema,
  "projects.list": z.object({}).strict(),
  "projects.create": z.object({ path: z.string().min(1).max(4096), name: id.optional() }).strict(),
  "projects.open": z.object({ path: z.string().min(1).max(4096), name: id.optional() }).strict(),
  "projects.select": z.object({ id }).strict(),
  "projects.toggleFavorite": z.object({ id }).strict(),
  "projects.remove": z.object({ id }).strict(),
  "projects.updateSettings": z.object({ id, tools: list, agents: list, connectors: list }).strict(),
  "agents.list": z.object({}).strict(),
  "agents.configure": z
    .object({
      id,
      projects: list,
      browser: z.boolean(),
      requestsPerMinute: z.number().int().min(1).max(100000),
      revoked: z.boolean().default(false),
    })
    .strict(),
  "agents.disconnect": z.object({ id }).strict(),
  "connectors.list": z.object({}).strict(),
  "connectors.configure": z
    .object({
      id,
      credential: z
        .string()
        .max(8192)
        .regex(/^[^\r\n\0]*$/)
        .optional(),
      endpoint: z.string().url().max(4096).optional(),
      scopes: list.default([]),
      ...grants,
    })
    .strict(),
  "connectors.testConnection": z.object({ id }).strict(),
  "connectors.disconnect": z.object({ id }).strict(),
  "connectors.revoke": z.object({ id }).strict(),
  "mcpServers.list": z.object({}).strict(),
  "mcpServers.add": z
    .object({
      name: id,
      transport: z.enum(["stdio", "http"]),
      command: z.string().min(1).max(4096).optional(),
      args: z.array(z.string().max(4096)).max(128).default([]),
      url: z.string().url().max(4096).optional(),
      token: z
        .string()
        .max(8192)
        .regex(/^[^\r\n\0]*$/)
        .optional(),
    })
    .strict(),
  "mcpServers.connect": z.object({ id }).strict(),
  "mcpServers.disconnect": z.object({ id }).strict(),
  "mcpServers.remove": z.object({ id }).strict(),
  "mcpServers.setToolPolicy": z.object({ id, tool: id, allowed: z.boolean() }).strict(),
  "mcpServers.callTool": z.object({ id, tool: id, arguments: z.record(z.string(), z.unknown()).default({}) }).strict(),
  "tasks.list": z.object({ project: id.optional(), agent: id.optional() }).strict(),
  "tasks.cancel": z.object({ id }).strict(),
  "tasks.retry": z.object({ id }).strict(),
  "monitoring.queryAudit": filter,
  "monitoring.metrics": z.object({}).strict(),
  "monitoring.exportReport": filter,
} as const;
export type ProductMethod = keyof typeof PRODUCT_SCHEMAS;
export const PRODUCT_METHODS = Object.keys(PRODUCT_SCHEMAS) as ProductMethod[];
export function parseProduct(method: string, params: unknown): Record<string, unknown> | undefined {
  if (!Object.hasOwn(PRODUCT_SCHEMAS, method)) return undefined;
  const result = PRODUCT_SCHEMAS[method as ProductMethod].safeParse(params ?? {});
  return result.success ? (result.data as Record<string, unknown>) : undefined;
}
