/**
 * L1 availability checks and reason codes (AD-20 point 12) on FIXTURES: fake
 * /proc and /sys readers, a fake component file system and temporary
 * directories. Each check is driven to fail on its own, in the documented
 * order (the first failing check is the reason). The same codes on a real
 * host are produced by l1-integration.test.ts.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessLauncher } from "../../../src/core/platform/types.js";
import {
  BUBBLEWRAP_RELEASE,
  L1_VERSION,
  parseManifest,
  profileNames,
  verifyComponents,
  type ComponentFs,
} from "../../../src/native-host/linux-l1/components.js";
import { classifySandboxFailure, LinuxConfinement } from "../../../src/native-host/linux-l1/confinement.js";
import { apparmorRequired, readHostFacts, type HostReader } from "../../../src/native-host/linux-l1/host.js";

const posix = process.platform !== "win32";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const AA = "/sys/kernel/security/apparmor";
/** An Ubuntu 24.04-like host with the L1 policy loaded. */
const ubuntu2404: Record<string, string> = {
  "/proc/sys/kernel/unprivileged_userns_clone": "1\n",
  "/proc/sys/user/max_user_namespaces": "63000\n",
  "/sys/module/apparmor/parameters/enabled": "Y\n",
  "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n",
  [`${AA}/profiles`]:
    "crot-l1-1 (enforce)\ncrot-l1-payload-1 (enforce)\ncrot-l1-container-1 (enforce)\ndocker-default (enforce)\n",
};
const reader =
  (facts: Record<string, string | null>): HostReader =>
  async (file) =>
    facts[file] ?? null;
const unixFeature = async (f: string) => f === `${AA}/features/network/af_unix`;

describe("host facts", () => {
  it("reads user namespaces, AppArmor, the userns restriction, Unix mediation and loaded profiles", async () => {
    expect(await readHostFacts("1", reader(ubuntu2404), unixFeature)).toEqual({
      userns: true,
      apparmorEnabled: true,
      usernsRestricted: true,
      unixMediation: true,
      profilesLoaded: true,
    });
    const facts = await readHostFacts("2", reader(ubuntu2404), unixFeature);
    expect(facts.profilesLoaded).toBe(false); // another <v>
    expect(
      (await readHostFacts("1", reader({ ...ubuntu2404, [`${AA}/profiles`]: null }), unixFeature)).profilesLoaded,
    ).toBeNull();
    expect(
      (await readHostFacts("1", reader({ ...ubuntu2404, "/proc/sys/user/max_user_namespaces": "0" }), unixFeature))
        .userns,
    ).toBe(false);
    expect(
      (
        await readHostFacts(
          "1",
          reader({ ...ubuntu2404, "/proc/sys/kernel/unprivileged_userns_clone": "0" }),
          unixFeature,
        )
      ).userns,
    ).toBe(false);
  });

  it("needs AppArmor where the user-namespace restriction is active or with network on", () => {
    const base = { userns: true, apparmorEnabled: false, unixMediation: false, profilesLoaded: null };
    expect(apparmorRequired({ ...base, usernsRestricted: false }, "off")).toBe(false);
    expect(apparmorRequired({ ...base, usernsRestricted: false }, "on")).toBe(true);
    expect(apparmorRequired({ ...base, usernsRestricted: true }, "off")).toBe(true);
  });
});

/** A fake installed component tree under /usr/lib/crot/l1/1. */
function componentFs(
  over: {
    uid?: Record<string, number>;
    mode?: Record<string, number>;
    manifest?: string;
    digest?: Record<string, string>;
    missing?: string[];
    symlink?: string[];
  } = {},
): ComponentFs {
  const dirs = ["/", "/usr", "/usr/lib", "/usr/lib/crot", "/usr/lib/crot/l1", "/usr/lib/crot/l1/1"];
  const files = ["manifest.json", "crot-bwrap", "crot-l1-init", "crot-l1.apparmor"].map(
    (f) => `/usr/lib/crot/l1/1/${f}`,
  );
  const digest = (p: string) =>
    over.digest?.[p] ??
    path
      .basename(p)
      .replace(/[^a-z]/g, "")
      .padEnd(64, "a")
      .slice(0, 64)
      .replace(/[^0-9a-f]/g, "a");
  const manifest =
    over.manifest ??
    JSON.stringify({
      version: "1",
      bubblewrap: { version: BUBBLEWRAP_RELEASE.version, sha256: BUBBLEWRAP_RELEASE.sha256 },
      files: Object.fromEntries(files.slice(1).map((f) => [path.basename(f), digest(f).replace(/./g, "a")])),
    });
  return {
    lstat: async (p) => {
      if (over.missing?.includes(p)) return null;
      const isDir = dirs.includes(p);
      if (!isDir && !files.includes(p)) return null;
      const link = over.symlink?.includes(p) ?? false;
      return {
        uid: over.uid?.[p] ?? 0,
        mode: over.mode?.[p] ?? (isDir ? 0o40755 : 0o100755),
        isFile: () => !isDir && !link,
        isDirectory: () => isDir && !link,
        isSymbolicLink: () => link,
      };
    },
    readFile: async () => manifest,
    sha256: async (p) => over.digest?.[p] ?? "a".repeat(64),
  };
}

describe("components (components_missing, components_mismatch)", () => {
  it("accepts root-owned, non-writable components whose digests match the manifest of <v>", async () => {
    expect(await verifyComponents("1", "/usr/lib/crot/l1", componentFs())).toMatchObject({
      ok: true,
      components: { bwrap: "/usr/lib/crot/l1/1/crot-bwrap", init: "/usr/lib/crot/l1/1/crot-l1-init" },
    });
  });

  it.each([
    ["not installed", componentFs({ missing: ["/usr/lib/crot/l1/1"] }), "components_missing", /not installed/],
    [
      "manifest missing",
      componentFs({ missing: ["/usr/lib/crot/l1/1/manifest.json"] }),
      "components_missing",
      /manifest is missing/,
    ],
    [
      "component missing",
      componentFs({ missing: ["/usr/lib/crot/l1/1/crot-l1-init"] }),
      "components_missing",
      /crot-l1-init is missing/,
    ],
    [
      "user-owned component",
      componentFs({ uid: { "/usr/lib/crot/l1/1/crot-bwrap": 1000 } }),
      "components_mismatch",
      /crot-bwrap is not owned by root/,
    ],
    [
      "group-writable directory",
      componentFs({ mode: { "/usr/lib/crot": 0o40775 } }),
      "components_mismatch",
      /directory/,
    ],
    [
      "symbolic link",
      componentFs({ symlink: ["/usr/lib/crot/l1/1/crot-l1-init"] }),
      "components_mismatch",
      /crot-l1-init/,
    ],
    [
      "digest mismatch",
      componentFs({ digest: { "/usr/lib/crot/l1/1/crot-bwrap": "b".repeat(64) } }),
      "components_mismatch",
      /digest/,
    ],
    [
      "manifest of another <v>",
      componentFs({
        manifest: JSON.stringify({
          version: "2",
          bubblewrap: { version: "x", sha256: "y" },
          files: { "crot-bwrap": "a".repeat(64), "crot-l1-init": "a".repeat(64), "crot-l1.apparmor": "a".repeat(64) },
        }),
      }),
      "components_mismatch",
      /version 2/,
    ],
    ["invalid manifest", componentFs({ manifest: "{" }), "components_mismatch", /invalid/],
  ])("%s", async (_name, fs, reason, detail) => {
    const r = await verifyComponents("1", "/usr/lib/crot/l1", fs);
    expect(r).toMatchObject({ ok: false, reason });
    if (!r.ok) expect(r.detail).toMatch(detail);
  });

  it("parses manifests strictly", () => {
    expect(parseManifest('{"version":"1"}')).toBeNull();
    expect(parseManifest("[]")).toBeNull();
  });
});

describe("classifySandboxFailure", () => {
  it("maps crot-bwrap diagnostics to reason codes", () => {
    expect(classifySandboxFailure("bwrap: Can't mount overlay on /home/u: Operation not permitted", true).reason).toBe(
      "overlay_unavailable",
    );
    expect(classifySandboxFailure("bwrap: setting up uid map: Permission denied", true).reason).toBe(
      "apparmor_profile_not_loaded",
    );
    expect(classifySandboxFailure("bwrap: No permissions to creating new namespace", false).reason).toBe(
      "userns_unavailable",
    );
    expect(classifySandboxFailure("something else", true).reason).toBe("self_test_failed");
  });
});

let dir: string;
beforeEach(async () => {
  if (posix) dir = await mkdtemp(path.join(os.tmpdir(), "crot-l1a-"));
});
afterEach(async () => {
  if (posix) await rm(dir, { recursive: true, force: true });
});

const base = {} as ProcessLauncher;

describe.skipIf(!posix)("LinuxConfinement: the first failing check is the reason", () => {
  const make = (
    facts: Record<string, string | null>,
    extra: Partial<ConstructorParameters<typeof LinuxConfinement>[0]> = {},
  ) => {
    const log: string[] = [];
    const c = new LinuxConfinement({
      stateDir: "/state",
      base,
      env: { HOME: dir },
      log: (l) => log.push(l),
      read: reader(facts),
      exists: unixFeature,
      componentFs: componentFs(),
      storageParent: dir,
      ...extra,
    });
    return { c, log };
  };

  it("userns_unavailable before everything else", async () => {
    const { c } = make(
      { ...ubuntu2404, "/proc/sys/user/max_user_namespaces": "0" },
      { componentFs: componentFs({ missing: ["/usr/lib/crot/l1/1"] }) },
    );
    expect(await c.probe("on")).toMatchObject({
      available: false,
      reason: "userns_unavailable",
      mechanism: "linux-bubblewrap",
    });
  });

  it("components_missing / components_mismatch before AppArmor", async () => {
    expect(
      await make({}, { componentFs: componentFs({ missing: ["/usr/lib/crot/l1/1"] }) }).c.probe("on"),
    ).toMatchObject({
      reason: "components_missing",
    });
    expect(
      await make({}, { componentFs: componentFs({ uid: { "/usr/lib/crot/l1/1/crot-bwrap": 1000 } }) }).c.probe("on"),
    ).toMatchObject({
      reason: "components_mismatch",
    });
  });

  it("apparmor_unavailable where AppArmor is needed (network on, or the userns restriction); off would not need it", async () => {
    const noAA = {
      ...ubuntu2404,
      "/sys/module/apparmor/parameters/enabled": "N",
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0",
    };
    const on = await make(noAA).c.probe("on");
    expect(on).toMatchObject({ reason: "apparmor_unavailable", network: "on" });
    expect(on.detail).toMatch(/network off would not need it/);
    const restricted = { ...noAA, "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1" };
    expect(await make(restricted).c.probe("off")).toMatchObject({ reason: "apparmor_unavailable", network: "off" });
  });

  it("apparmor_profile_not_loaded when the policy of <v> is not in the kernel's list", async () => {
    expect(await make({ ...ubuntu2404, [`${AA}/profiles`]: "docker-default (enforce)\n" }).c.probe("on")).toMatchObject(
      {
        reason: "apparmor_profile_not_loaded",
      },
    );
  });

  it("apparmor_unix_mediation_unavailable for network on only; detail says off would be available", async () => {
    const { c } = make(ubuntu2404, { exists: async () => false });
    const on = await c.probe("on");
    expect(on).toMatchObject({ reason: "apparmor_unix_mediation_unavailable" });
    expect(on.detail).toMatch(/network off would be available/);
    const off = await c.probe("off");
    expect(off.reason).not.toBe("apparmor_unix_mediation_unavailable");
  });

  it("private_storage_unavailable when the storage cannot be created", async () => {
    expect(await make(ubuntu2404, { storageParent: path.join(dir, "absent") }).c.probe("on")).toMatchObject({
      reason: "private_storage_unavailable",
    });
  });

  it("a sandbox that cannot start fails the self-test; status never contains CROT-protected paths or diagnostics", async () => {
    const { c, log } = make(ubuntu2404, {
      components: {
        version: "1",
        directory: dir,
        bwrap: path.join(dir, "no-bwrap"),
        init: path.join(dir, "no-init"),
        policy: "",
      },
    });
    const s = await c.probe("on");
    expect(s.available).toBe(false);
    expect(["self_test_failed", "userns_unavailable", "apparmor_profile_not_loaded"]).toContain(s.reason);
    expect(s.detail).not.toContain(dir);
    // One log line per change of availability, with the reason code.
    await c.probe("on");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(new RegExp(`L1 unavailable \\(network on\\): ${s.reason}`));
  });
});

describe.skipIf(!posix)("the policy and the install helper", () => {
  // A host without AppArmor profiles of its own unless a test gives one.
  const render = (abi: string, host: Record<string, string> = {}) => {
    const out = path.join(dir, `policy-${abi}`);
    execFileSync("bash", [path.join(repo, "scripts/l1-install.sh"), "render-policy", abi, out], {
      env: {
        ...process.env,
        CROT_L1_APPARMOR_DIR: path.join(dir, "no-apparmor.d"),
        CROT_L1_APPARMOR_PROFILES: path.join(dir, "no-profiles"),
        ...host,
      },
    });
    return readFile(out, "utf8");
  };
  const profileBody = (policy: string, name: string) =>
    policy.slice(policy.indexOf(`profile ${name} `)).split("\n}\n")[0] ?? "";

  it("renders three profiles of <v>, attached to the CROT path only, per ABI", async () => {
    const { bwrap, payload, container, label } = profileNames(L1_VERSION);
    for (const abi of ["4.0", "3.0"]) {
      const p = await render(abi);
      expect(p).toContain(`abi <abi/${abi}>,`);
      expect(p).not.toMatch(/@ABI[34]@|@V@/);
      expect(p).toContain(`profile ${bwrap} /usr/lib/crot/l1/${L1_VERSION}/crot-bwrap flags=`);
      expect(p).toContain(`profile ${payload} flags=`);
      expect(p).toContain(`profile ${container} flags=`);
      expect(p).not.toMatch(/^profile .*\/usr\/bin\/bwrap/m);
      expect(profileBody(p, bwrap)).toContain(`allow pix /** -> &${label},`);
      // The payload profile inherits on exec: no profile lookup by path, the label never changes.
      const payloadBody = profileBody(p, payload);
      expect(payloadBody).toContain("allow file rwlkmix /{**,},");
      expect(payloadBody).not.toMatch(/\bp?c?ix?\b[^\n]*->/);
      expect(p).not.toMatch(/^\s*allow ix "/m);
      // Unix peers: each profile of the stack on its own (the kernel matches a stacked
      // peer label profile by profile), never the compound label; the payload and container
      // profiles have no bare network rule, which would grant every Unix socket operation.
      expect(p).toContain(`allow unix (connect, send, receive) peer=(label=${bwrap}),`);
      expect(p).toContain(`allow unix (connect, send, receive) peer=(label=${payload}),`);
      expect(p).not.toContain(`peer=(label=${label})`);
      for (const name of [payload, container]) {
        const body = p.slice(p.indexOf(`profile ${name} flags=`)).split("\n}\n")[0];
        expect(body).not.toMatch(/^\s*(allow\s+)?network\s*,/m);
      }
    }
    const v4 = await render("4.0");
    const v3 = await render("3.0");
    expect(v4).toContain("deny userns,");
    expect(v4).toContain("allow userns,");
    // Rules only (comments explain the 22.04 control): ABI 3.0 has no userns, mqueue or io_uring rules.
    const rules3 = v3
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(rules3).not.toMatch(/userns|mqueue|io_uring/);
  });

  it("keeps the L1 label for the exact paths of the host's loaded unconfined profiles that grant user namespaces", async () => {
    const { bwrap, payload, container } = profileNames(L1_VERSION);
    const etc = path.join(dir, "apparmor.d");
    await mkdir(path.join(etc, "abstractions"), { recursive: true });
    const profile = (header: string, body = "  userns,") =>
      `abi <abi/4.0>,\ninclude <tunables/global>\n${header} {\n${body}\n  include if exists <local/x>\n}\n`;
    const files: Record<string, string> = {
      // As Ubuntu 24.04 ships them: included.
      chrome: profile("profile chrome /opt/google/chrome/chrome flags=(unconfined)"),
      msedge: profile("profile msedge /opt/microsoft/msedge/msedge flags=(unconfined)"),
      opera: profile("profile opera /usr/lib/@{multiarch}/opera/opera flags=(unconfined)"),
      chromium:
        "@{chromium} = chromium{,-browser}\n" +
        profile("profile chromium /usr/lib/@{chromium}/@{chromium} flags=(unconfined)"),
      compass: profile('profile "Some App" "/opt/Some App/some app" flags=(unconfined)'),
      // Not included: confining (enforce), no userns rule, not loaded, not unconfined when loaded,
      // a pattern that stays a glob, an unknown variable, CROT's own path, an abstraction.
      tcpdump: profile("profile tcpdump /usr/bin/tcpdump flags=(attach_disconnected)"),
      nouserns: profile("profile nouserns /usr/bin/nouserns flags=(unconfined)", "  # userns,"),
      notloaded: profile("profile notloaded /usr/bin/notloaded flags=(unconfined)"),
      complain: profile("profile complain /usr/bin/complain flags=(unconfined)"),
      glob: profile("profile glob /usr/bin/glob* flags=(unconfined)"),
      unknown: profile("profile unknown /usr/lib/@{nowhere}/unknown flags=(unconfined)"),
      [`crot-l1-${L1_VERSION}`]: profile(`profile crot-l1-x /usr/lib/crot/l1/x/crot-bwrap flags=(unconfined)`),
      "abstractions/base": profile("profile abstraction /usr/bin/abstraction flags=(unconfined)"),
    };
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(etc, name), text);
    const loaded = path.join(dir, "profiles");
    await writeFile(
      loaded,
      [
        "chrome (unconfined)",
        "msedge (unconfined)",
        "opera (unconfined)",
        "chromium (unconfined)",
        "Some App (unconfined)",
        "tcpdump (enforce)",
        "nouserns (unconfined)",
        "complain (complain)",
        "glob (unconfined)",
        "unknown (unconfined)",
        "crot-l1-x (unconfined)",
        "abstraction (unconfined)",
        "",
      ].join("\n"),
    );
    const host = {
      CROT_L1_APPARMOR_DIR: etc,
      CROT_L1_APPARMOR_PROFILES: loaded,
      CROT_L1_MULTIARCH: "x86_64-linux-gnu",
    };
    for (const abi of ["4.0", "3.0"]) {
      const p = await render(abi, host);
      const rules = [...p.matchAll(/^\s*allow ix "([^"]+)",$/gm)].map((m) => m[1]);
      expect(rules).toEqual([
        "/opt/Some App/some app",
        "/opt/google/chrome/chrome",
        "/opt/microsoft/msedge/msedge",
        "/usr/lib/chromium-browser/chromium",
        "/usr/lib/chromium-browser/chromium-browser",
        "/usr/lib/chromium/chromium",
        "/usr/lib/chromium/chromium-browser",
        "/usr/lib/x86_64-linux-gnu/opera/opera",
      ]);
      // Only in crot-l1-<v>: the payload profile inherits on exec anyway, the container profile has
      // no exec rule.
      expect(profileBody(p, bwrap).match(/^\s*allow ix "/gm)).toHaveLength(rules.length);
      expect(profileBody(p, payload)).not.toContain('allow ix "');
      expect(profileBody(p, container)).not.toContain('allow ix "');
      expect(p).not.toContain("@HOST_EXEC@");
    }
  });

  it("takes the version and the pinned bubblewrap release from components.ts", () => {
    const status = execFileSync("bash", [path.join(repo, "scripts/l1-install.sh"), "status"], { encoding: "utf8" });
    expect(status).toContain(`L1 version: ${L1_VERSION} (bubblewrap ${BUBBLEWRAP_RELEASE.version})`);
    const script = readFileSync(path.join(repo, "scripts/l1-install.sh"), "utf8");
    expect(script).toContain("sha256sum -c");
    expect(BUBBLEWRAP_RELEASE.source).toBe(
      `https://github.com/containers/bubblewrap/releases/download/v${BUBBLEWRAP_RELEASE.version}/bubblewrap-${BUBBLEWRAP_RELEASE.version}.tar.xz`,
    );
  });
});
