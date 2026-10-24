import { isProjectSecretName } from "../../core/permissions/project-secrets.js";
/** Seatbelt is pathname based: a pre-existing hardlink inside workspace is
 * otherwise writable even when its other name is outside. Never mutate ACLs. */
import type { BigIntStats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
const LIMIT = 100_000;
async function walk(
  roots: readonly string[],
  follow: boolean,
  visit: (name: string, st: BigIntStats) => void,
): Promise<string[]> {
  const pending = [...roots],
    seen = new Set<string>(),
    targets: string[] = [];
  let count = 0;
  while (pending.length) {
    const name = pending.pop()!;
    if (++count > LIMIT) throw Error("filesystem identity preflight limit exceeded");
    let st: BigIntStats;
    try {
      st = await lstat(name, { bigint: true });
    } catch (e) {
      if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) continue;
      throw e;
    }
    if (st.isSymbolicLink()) {
      if (follow) {
        const target = await realpath(name);
        if (!seen.has(target)) {
          targets.push(target);
          pending.push(target);
        }
      }
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    visit(name, st);
    if (st.isDirectory()) for (const child of await readdir(name)) pending.push(path.join(name, child));
  }
  return targets;
}
export async function inspectProtected(roots: readonly string[]): Promise<string[]> {
  return walk(roots, true, (_name, st) => {
    // A second name anywhere on the host could disclose a secret through the
    // broad read allowance. Refuse readiness rather than guess all aliases.
    if (st.isFile() && st.nlink > 1n) throw Error("protected file has multiple names");
  });
}
export async function writableHardlinks(roots: readonly string[]): Promise<string[]> {
  const groups = new Map<string, { links: bigint; names: string[] }>();
  await walk(roots, false, (name, st) => {
    if (!st.isFile() || st.nlink <= 1n) return;
    const id = `${st.dev}:${st.ino}`,
      group = groups.get(id) ?? { links: st.nlink, names: [] };
    if (st.nlink > group.links) group.links = st.nlink;
    group.names.push(name);
    groups.set(id, group);
  });
  // Internal-only hardlinks (e.g. Cargo build artifacts) remain ordinary
  // writable files. Unknown/external names make every known alias read-only.
  return [...groups.values()].flatMap((g) => (BigInt(g.names.length) < g.links ? g.names : []));
}
export function workspaceHardlinks(workspace: string): Promise<string[]> {
  return writableHardlinks([workspace]);
}

/** Existing sensitive symlink targets become protected too; ambiguous hardlinks refuse readiness. */
export async function projectSecretTargets(workspace: string, allowedPaths: readonly string[]): Promise<string[]> {
  const targets: string[] = [];
  await walk([workspace], false, (name) => {
    if (name !== workspace && isProjectSecretName(path.posix.basename(name)) && !allowedPaths.includes(name))
      targets.push(name);
  });
  // walk does not visit a symlink's metadata callback; explicitly enumerate them
  // with follow=true below, through inspectProtected, when their name is found.
  const pending = [workspace];
  let count = 0;
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++count > LIMIT) throw Error("project secret preflight limit exceeded");
      const name = path.join(dir, entry.name);
      if (entry.isSymbolicLink() && isProjectSecretName(entry.name) && !allowedPaths.includes(name)) targets.push(name);
      if (entry.isDirectory()) pending.push(name);
    }
  }
  return [...new Set([...targets, ...(await inspectProtected(targets))])];
}
