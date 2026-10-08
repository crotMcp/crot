/**
 * REAL checks of the L1 availability reason codes (AD-20 point 12) on a host
 * whose state is changed for the test and restored afterwards: the L1 policy
 * unloaded, unprivileged user namespaces disabled. Needs passwordless sudo;
 * run by the L1 workflow with CROT_L1_REQUIRED=1 and CROT_L1_SUDO=1. In
 * each state a remote shell command is refused with CONFINEMENT_UNAVAILABLE
 * before admission and no process is started.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { remotePrincipal } from "../../../src/core/auth/principal.js";
import { profileNames } from "../../../src/native-host/linux-l1/components.js";
import { readHostFacts } from "../../../src/native-host/linux-l1/host.js";
import { assertAvailable, l1Fixture, type L1Fixture } from "./l1-harness.js";
import { isLinux, l1Required } from "./l1-support.js";

const run = isLinux && l1Required && process.env.CROT_L1_SUDO === "1";
const policyFile = `/etc/apparmor.d/${profileNames().bwrap}`;
const sudo = (...args: string[]) => execFileSync("sudo", ["-n", ...args], { stdio: "pipe" });

describe.skipIf(!run)("L1 reason codes on a changed host (sudo)", () => {
  let f: L1Fixture;
  let maxNs = "";

  beforeAll(async () => {
    maxNs = (await readFile("/proc/sys/user/max_user_namespaces", "utf8")).trim();
    f = await l1Fixture();
    assertAvailable(f);
  }, 120_000);
  afterEach(async () => {
    sudo("sysctl", "-q", `user.max_user_namespaces=${maxNs}`);
    if ((await readHostFacts("1")).apparmorEnabled) sudo("apparmor_parser", "-r", policyFile);
  });
  afterAll(async () => {
    await f?.close();
  });

  const remote = {
    principal: remotePrincipal({
      id: "r",
      transport: "http",
      authMethod: "test",
      accountId: "a",
      deviceId: "d",
      clientId: "c",
    }),
  };

  async function expectUnavailable(reason: string): Promise<void> {
    expect(await f.core.refreshConfinement()).toMatchObject({ available: false, reason });
    const marker = `${f.workspace}/must-not-exist`;
    await expect(
      f.core.processes.shell(remote, { script: `touch '${marker}'`, timeoutMs: 10_000 }),
    ).rejects.toMatchObject({
      code: "CONFINEMENT_UNAVAILABLE",
    });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.core.refreshConfinement()).toMatchObject({ available: false });
  }

  it("reports apparmor_profile_not_loaded when the L1 policy is unloaded, and recovers", async () => {
    if (!(await readHostFacts("1")).apparmorEnabled) throw new Error("AppArmor is required on the L1 runners");
    sudo("apparmor_parser", "-R", policyFile);
    await expectUnavailable("apparmor_profile_not_loaded");
    sudo("apparmor_parser", "-r", policyFile);
    expect(await f.core.refreshConfinement()).toMatchObject({ available: true, reason: null });
  });

  it("reports userns_unavailable when unprivileged user namespaces are disabled, and recovers", async () => {
    sudo("sysctl", "-q", "user.max_user_namespaces=0");
    await expectUnavailable("userns_unavailable");
    sudo("sysctl", "-q", `user.max_user_namespaces=${maxNs}`);
    expect(await f.core.refreshConfinement()).toMatchObject({ available: true, reason: null });
  });
});
