import type { AuthContext } from "../../auth/principal.js";
import type { CrotCore } from "../../crot-core.js";
import { CrotError } from "../../errors.js";
import { observeProjectPorts } from "./ports.js";

export interface ProjectManifest {
  file: "package.json" | "pyproject.toml" | "Dockerfile";
  state: "missing" | "detected" | "invalid" | "too-large" | "not-file";
  stack: string[];
}
/** Only fixed manifest paths, through the ordinary filesystem guard. Never execute package scripts. */
export async function inspectProject(core: CrotCore, context: AuthContext) {
  const manifests: ProjectManifest[] = [];
  for (const file of ["package.json", "pyproject.toml", "Dockerfile"] as const) {
    if (context.signal?.aborted) throw new CrotError("OPERATION_FAILED", "Project inspection cancelled");
    const info = await core.filesystem.stat(context, { path: file });
    const entry: ProjectManifest = {
      file,
      state: !info.exists ? "missing" : info.type !== "file" ? "not-file" : "detected",
      stack: [],
    };
    manifests.push(entry);
    if (entry.state !== "detected") continue;
    if (file === "Dockerfile") {
      entry.stack.push("Docker");
      continue;
    }
    const content = await core.filesystem.readFile(context, { path: file, encoding: "utf8", offset: 0, length: 65536 });
    if (content.truncated) {
      entry.state = "too-large";
      continue;
    }
    if (file === "pyproject.toml") {
      // Presence is evidence of a Python manifest, not a TOML validity claim or installed environment.
      entry.stack.push("Python");
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(content.content);
    } catch {
      entry.state = "invalid";
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      entry.state = "invalid";
      continue;
    }
    entry.stack.push("Node.js");
    const pkg = value as Record<string, unknown>;
    for (const [dependency, label] of [
      ["typescript", "TypeScript"],
      ["react", "React"],
      ["next", "Next.js"],
      ["vite", "Vite"],
      ["remotion", "Remotion"],
    ]) {
      if (
        [pkg.dependencies, pkg.devDependencies].some((d) => d && typeof d === "object" && Object.hasOwn(d, dependency!))
      )
        entry.stack.push(label!);
    }
  }
  const target = await core.workspace.resolve(".");
  const ports = await core.guard.run(
    context,
    {
      operation: "process.project_ports",
      capability: "process.manage",
      paths: [target],
      details: { observation: "same-user-workspace-cwd", transport: "tcp" },
    },
    () => (core.platform.observeProjectPorts ?? observeProjectPorts)(core.workspace.root, context.signal),
  );
  return { workspace: core.workspace.root, observedAt: new Date().toISOString(), manifests, ports };
}
