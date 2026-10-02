/**
 * CROT Native Host: stronger OS-specific implementations of the Core platform
 * interfaces. Boundary:
 *
 *   adapter (stdio / HTTP MCP, future native messaging)
 *     -> CrotCore (PermissionEngine, ExecutionGuard, audit)
 *       -> Platform interfaces  <- implemented by NativeHost.platform
 *
 * The Native Host has no request API and performs no authorization.
 */
export { NativeHost, type NativeHostOptions, type NativeHostStatus } from "./native-host.js";
export { JOB_OBJECT_PROCESS_CONTROL } from "./job-launcher.js";
