/** Read-only reuse of already installed Rust toolchains. Never copy credentials
 * or point writable caches at the real HOME. Installation/selection state is
 * private; Seatbelt still denies writes through these external symlinks. */
import { mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
export async function prepareRustup(
  home: string,
  realHome: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const host = env.RUSTUP_HOME ?? path.join(realHome, ".rustup");
  let entries: string[], settings: string;
  try {
    entries = await readdir(path.join(host, "toolchains"));
    settings = await readFile(path.join(host, "settings.toml"), "utf8");
  } catch (error) {
    if (["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  const destination = path.join(home, "rustup");
  await mkdir(path.join(destination, "toolchains"), { recursive: true, mode: 0o700 });
  const installed = new Set<string>();
  for (const name of entries) {
    if (!/^[A-Za-z0-9_.+-]+$/.test(name)) continue;
    const source = await realpath(path.join(host, "toolchains", name));
    await symlink(source, path.join(destination, "toolchains", name));
    installed.add(name);
  }
  const selected = /^default_toolchain\s*=\s*"([A-Za-z0-9_.+-]+)"\s*$/m.exec(settings)?.[1];
  if (selected && installed.has(selected))
    await writeFile(path.join(destination, "settings.toml"), `version = "12"\ndefault_toolchain = "${selected}"\n`, {
      mode: 0o600,
    });
}
