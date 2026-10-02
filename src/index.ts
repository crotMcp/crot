/**
 * CROT public entry point.
 *
 * CROT Core is the product layer; adapters (such as CROT MCP over stdio or
 * HTTP) depend on it, never the other way around. The Native Host provides
 * OS-specific implementations of Core's platform interfaces. See ARCHITECTURE.md.
 */
export * from "./core/index.js";
export * as mcp from "./adapters/mcp/index.js";
export * as http from "./adapters/http/index.js";
export * as nativeHost from "./native-host/index.js";
