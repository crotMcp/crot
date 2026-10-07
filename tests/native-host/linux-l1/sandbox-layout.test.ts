/**
 * The sandbox command line and host discovery (AD-20 points 5-10): pure
 * argument construction, mountinfo parsing, agent sockets, hidden entries
 * and the L1 private storage. Unit tests on fixtures (temporary directories,
 * fake mountinfo); the real mount view is checked in l1-integration.test.ts.
 */
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bwrapArgs,
  isWithin,
  sandboxCommand,
  type SandboxLayout,
} from "../../../src/native-host/linux-l1/bwrap-args.js";
import {
  agentSockets,
  allowedDevices,
  hiddenEntries,
  homeSubmounts,
} from "../../../src/native-host/linux-l1/layout.js";
import { openStorage, storageKey, StorageError } from "../../../src/native-host/linux-l1/storage.js";

const posix = process.platform !== "win32";

const layout = (over: Partial<SandboxLayout> = {}): SandboxLayout => ({
  bwrap: "/usr/lib/crot/l1/1/crot-bwrap",
  init: "/usr/lib/crot/l1/1/crot-l1-init",
  network: "on",
  workspace: "/home/u/ws",
  home: "/home/u",
  homeLayer: { upper: "/var/tmp/crot-l1-1000/k/home/upper", work: "/var/tmp/crot-l1-1000/k/home/work" },
  homeSubmounts: [],
  temp: { tmp: "/var/tmp/crot-l1-1000/k/temp/1/tmp", varTmp: "/var/tmp/crot-l1-1000/k/temp/1/var-tmp" },
  runtimeDir: "/run/user/1000",
  agentSockets: ["/run/user/1000/gnupg/S.gpg-agent", "/tmp/ssh-x/agent.1"],
  devices: ["/dev/fuse"],
  hidden: [
    { path: "/home/u/.config/crot", kind: "dir" },
    { path: "/home/u/.local/share/keyrings", kind: "dir" },
    { path: "/var/run/docker.sock", kind: "file" },
    { path: "/run/user/1000/bus", kind: "file" },
    { path: "/tmp/.X11-unix", kind: "dir" },
    { path: "/home/u/.config/crot/config.json", kind: "file" },
  ],
  emptyFile: "/var/tmp/crot-l1-1000/k/empty/file",
  emptyDir: "/var/tmp/crot-l1-1000/k/empty/dir",
  dockerSocket: "/var/tmp/crot-l1-1000/k/run/docker-1.sock",
  ...over,
});

/** Index of the first occurrence of an option followed by its arguments. */
const at = (args: string[], ...seq: string[]) => args.findIndex((_, i) => seq.every((s, j) => args[i + j] === s));

describe("bwrapArgs", () => {
  it("builds the namespaces, no nested user namespaces and the process model", () => {
    const a = bwrapArgs(layout());
    for (const o of [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--disable-userns",
      "--die-with-parent",
      "--new-session",
      "--as-pid-1",
      "--clearenv",
    ])
      expect(a).toContain(o);
    expect(a).not.toContain("--unshare-net"); // network on: the host network namespace
    expect(bwrapArgs(layout({ network: "off" }))).toContain("--unshare-net");
    expect(a).not.toContain("--cap-add");
    const cmd = sandboxCommand(layout());
    expect(cmd.file).toBe("/usr/lib/crot/l1/1/crot-bwrap");
    expect(cmd.args.slice(-2)).toEqual(["--", "/usr/lib/crot/l1/1/crot-l1-init"]);
  });

  it("mounts in the documented order: host ro, /dev,/proc, temp, home layer, workspace, runtime dir, agents, hidden, endpoint", () => {
    const a = bwrapArgs(layout());
    const order = [
      at(a, "--ro-bind", "/", "/"),
      at(a, "--dev", "/dev"),
      at(a, "--proc", "/proc"),
      at(a, "--bind", layout().temp.tmp, "/tmp"),
      at(a, "--overlay-src", "/home/u"),
      at(a, "--bind", "/home/u/ws", "/home/u/ws"),
      at(a, "--perms", "0700", "--tmpfs", "/run/user/1000"),
      at(a, "--bind-try", "/run/user/1000/gnupg/S.gpg-agent"),
      at(a, "--ro-bind", layout().emptyDir, "/home/u/.config/crot"),
      at(a, "--bind", layout().dockerSocket!, layout().dockerSocket!),
    ];
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("replaces only $XDG_RUNTIME_DIR and binds back exactly the agent sockets (point 6)", () => {
    const a = bwrapArgs(layout());
    const binds = a.flatMap((v, i) => (v === "--bind-try" ? [a[i + 1]] : []));
    expect(binds).toEqual(["/run/user/1000/gnupg/S.gpg-agent", "/tmp/ssh-x/agent.1"]);
  });

  it("hides entries once, skips those below replaced roots or below another hidden directory", () => {
    const a = bwrapArgs(layout());
    const hidden = a.flatMap((v, i) =>
      v === "--ro-bind" && (a[i + 1] === layout().emptyDir || a[i + 1] === layout().emptyFile) ? [a[i + 2]] : [],
    );
    expect(hidden).toEqual(["/home/u/.config/crot", "/home/u/.local/share/keyrings", "/var/run/docker.sock"]);
  });

  it("still hides a protected path inside a workspace that lies below /tmp", () => {
    const a = bwrapArgs(
      layout({
        workspace: "/tmp/t/ws",
        hidden: [{ path: "/tmp/t/ws/crot.json", kind: "file" }],
        runtimeDir: undefined,
      }),
    );
    expect(at(a, "--ro-bind", layout().emptyFile, "/tmp/t/ws/crot.json")).toBeGreaterThan(
      at(a, "--bind", "/tmp/t/ws", "/tmp/t/ws"),
    );
  });

  it("layers every file system mounted below the home like the home", () => {
    const a = bwrapArgs(
      layout({ homeSubmounts: [{ path: "/home/u/data", upper: "/s/l/0/upper", work: "/s/l/0/work" }] }),
    );
    expect(
      at(a, "--overlay-src", "/home/u/data", "--overlay", "/s/l/0/upper", "/s/l/0/work", "/home/u/data"),
    ).toBeGreaterThan(0);
  });

  it("isWithin compares path components", () => {
    expect(isWithin("/a", "/a/b")).toBe(true);
    expect(isWithin("/a", "/ab")).toBe(false);
    expect(isWithin("/", "/x")).toBe(true);
  });
});

describe("host discovery", () => {
  it("finds file systems mounted below the home in mountinfo (escaped paths, parents first)", () => {
    const mountinfo = [
      "22 1 8:1 / / rw - ext4 /dev/sda1 rw",
      "30 22 8:2 / /home/u rw - ext4 /dev/sda2 rw",
      "31 30 8:3 / /home/u/data/deep rw - ext4 /dev/sda3 rw",
      "32 30 8:4 / /home/u/my\\040disk rw - ext4 /dev/sda4 rw",
      "33 30 8:5 / /home/u/data rw - ext4 /dev/sda5 rw",
      "34 22 8:6 / /home/user2 rw - ext4 /dev/sda6 rw",
    ].join("\n");
    expect(homeSubmounts(mountinfo, "/home/u")).toEqual(["/home/u/data", "/home/u/my disk", "/home/u/data/deep"]);
  });

  it("allows only GPU compute, FUSE and TUN device nodes beyond the minimal /dev", async () => {
    const listing: Record<string, string[]> = {
      "/dev": ["sda", "mem", "fuse", "nvidia0", "nvidiactl", "kfd", "input", "uinput", "tty0", "kmsg"],
      "/dev/dri": ["card0", "renderD128"],
      "/dev/net": ["tun"],
    };
    expect(await allowedDevices(async (d) => listing[d] ?? [])).toEqual([
      "/dev/dri/renderD128",
      "/dev/fuse",
      "/dev/kfd",
      "/dev/net/tun",
      "/dev/nvidia0",
      "/dev/nvidiactl",
    ]);
  });
});

let dir: string;
beforeEach(async () => {
  if (posix) dir = await mkdtemp(path.join(os.tmpdir(), "crot-l1u-"));
});
afterEach(async () => {
  if (!posix) return;
  const { chmod } = await import("node:fs/promises");
  // Storage entries are mode 0000; make them removable.
  const walk = async (p: string): Promise<void> => {
    const st = await lstat(p).catch(() => null);
    if (!st || st.isSymbolicLink()) return;
    await chmod(p, st.isDirectory() ? 0o700 : 0o600).catch(() => undefined);
    if (st.isDirectory()) for (const e of await readdir(p).catch(() => [])) await walk(path.join(p, e));
  };
  await walk(dir);
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)("host discovery on fixtures", () => {
  it("binds back SSH_AUTH_SOCK and the GnuPG agent sockets that exist as sockets", async () => {
    const runtime = path.join(dir, "run");
    await mkdir(path.join(runtime, "gnupg"), { recursive: true });
    const servers: net.Server[] = [];
    const listen = (p: string) =>
      new Promise<void>((r) => {
        const s = net.createServer();
        servers.push(s);
        s.listen(p, () => r());
      });
    await listen(path.join(runtime, "gnupg", "S.gpg-agent"));
    await listen(path.join(runtime, "gnupg", "S.gpg-agent.ssh"));
    await listen(path.join(dir, "ssh.sock"));
    await writeFile(path.join(runtime, "gnupg", "S.gpg-agent.extra"), "not a socket");
    try {
      expect(
        await agentSockets(
          { SSH_AUTH_SOCK: path.join(dir, "ssh.sock"), XDG_RUNTIME_DIR: runtime },
          path.join(dir, "home"),
        ),
      ).toEqual([
        path.join(dir, "ssh.sock"),
        path.join(runtime, "gnupg", "S.gpg-agent"),
        path.join(runtime, "gnupg", "S.gpg-agent.ssh"),
      ]);
    } finally {
      for (const s of servers) s.close();
    }
  });

  it("hides a path and its real path when reached through a symbolic link, skips absent paths", async () => {
    // The canonical fixture directory: the temporary directory itself may be reached through a
    // symbolic link (macOS: /var -> /private/var), which is the case of the next test.
    const base = await realpath(dir);
    await mkdir(path.join(base, "real"));
    await symlink(path.join(base, "real"), path.join(base, "link"));
    await writeFile(path.join(base, "f"), "");
    expect(await hiddenEntries([path.join(base, "link"), path.join(base, "f"), path.join(base, "absent")])).toEqual([
      { path: path.join(base, "real"), kind: "dir" },
      { path: path.join(base, "f"), kind: "file" },
    ]);
  });

  it("hides both names of a path whose parent is a symbolic link (an alias such as macOS /var)", async () => {
    const base = await realpath(dir);
    await mkdir(path.join(base, "target"));
    await writeFile(path.join(base, "target", "f"), "");
    await symlink(path.join(base, "target"), path.join(base, "alias"));
    expect(await hiddenEntries([path.join(base, "alias", "f")])).toEqual([
      { path: path.join(base, "target", "f"), kind: "file" },
      { path: path.join(base, "alias", "f"), kind: "file" },
    ]);
  });
});

describe.skipIf(!posix)("L1 private storage (point 7)", () => {
  it("creates /<parent>/crot-l1-<uid>/<key>/ owner-only, one per state directory, reusable", async () => {
    const s = await openStorage("/state/a", { parent: dir });
    const uid = process.getuid!();
    expect(s.root).toBe(path.join(dir, `crot-l1-${uid}`, storageKey("/state/a")));
    expect(storageKey("/state/a")).not.toBe(storageKey("/state/b"));
    for (const d of [path.dirname(s.root), s.root, s.homeUpper, s.homeWork, s.run])
      expect((await stat(d)).mode & 0o777).toBe(0o700);
    expect((await stat(s.emptyFile)).mode & 0o777).toBe(0);
    expect((await stat(s.emptyDir)).mode & 0o777).toBe(0);
    // A second open (another Core, a refresh) verifies the same storage.
    const again = await openStorage("/state/a", { parent: dir });
    expect(again.root).toBe(s.root);
  });

  it("gives each sandbox a fresh sticky temp and keeps the temps of live processes", async () => {
    const s = await openStorage("/state/a", { parent: dir });
    const t = await s.newTemp();
    expect((await stat(t.tmp)).mode & 0o7777).toBe(0o1777);
    await writeFile(path.join(t.tmp, "x"), "");
    // A stale temp of a process that is gone.
    const stale = path.join(s.root, "temp", "999999999-dead");
    await mkdir(stale);
    await openStorage("/state/a", { parent: dir });
    await expect(stat(path.join(t.tmp, "x"))).resolves.toBeDefined();
    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await t.remove();
  });

  it("refuses symbolic links, wrong modes and non-directories (private_storage_unavailable)", async () => {
    const uid = process.getuid!();
    await mkdir(path.join(dir, "elsewhere"), { mode: 0o700 });
    await symlink(path.join(dir, "elsewhere"), path.join(dir, `crot-l1-${uid}`));
    await expect(openStorage("/s", { parent: dir })).rejects.toThrow(StorageError);
    await rm(path.join(dir, `crot-l1-${uid}`));
    await mkdir(path.join(dir, `crot-l1-${uid}`), { mode: 0o755 });
    const { chmod } = await import("node:fs/promises");
    await chmod(path.join(dir, `crot-l1-${uid}`), 0o755);
    await expect(openStorage("/s", { parent: dir })).rejects.toThrow(/not mode 0700/);
    await expect(openStorage("/s", { parent: path.join(dir, "absent") })).rejects.toThrow(StorageError);
    // The message names no path.
    await expect(openStorage("/s", { parent: dir })).rejects.not.toThrow(
      new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });
});
