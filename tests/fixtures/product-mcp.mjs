import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "product-fixture", version: "1" });
server.registerTool("echo", { inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text }],
}));
server.resource("fixture", "fixture://readme", async () => ({
  contents: [{ uri: "fixture://readme", text: "test resource" }],
}));
await server.connect(new StdioServerTransport());
