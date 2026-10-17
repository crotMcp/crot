/** Runtime code used by the unsandboxed owner/guardian must never be writable
 * by an actor, including when somebody chooses the CROT checkout as workspace. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
export function runtimeProtectedPaths(): string[] {
  const entry = createRequire(import.meta.url).resolve("koffi");
  const roots = [process.execPath, fileURLToPath(new URL("../../", import.meta.url)), path.dirname(entry)];
  // Protect the dependency tree and package manifest used by subsequent Core
  // imports as well as the FFI package itself. Account for nested node_modules.
  for (let p = path.dirname(entry); p !== path.dirname(p); p = path.dirname(p)) {
    if (path.basename(p) === "node_modules") {
      roots.push(p, path.join(path.dirname(p), "package.json"));
    }
  }
  return roots;
}
