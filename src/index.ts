/**
 * CROT public entry point.
 *
 * CROT Core is the product layer; adapters (such as CROT MCP) depend on it,
 * never the other way around. See ARCHITECTURE.md.
 */
export * from "./core/index.js";
