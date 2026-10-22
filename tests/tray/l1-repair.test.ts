import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { repairCommand, repairL1 } from "../../src/tray/l1-repair.js";
const root = path.resolve("fixture with spaces; $HOME");
const script = path.join(root, "scripts", "l1-install.sh");
const options = (...present: string[]) => ({
  platform: "linux" as const,
  root,
  exists: async (file: string) => present.includes(file),
});
describe("explicit desktop L1 setup", () => {
  it("elevates only the fixed shipped installer, preserving spaces as argv", async () => {
    expect(await repairCommand(options(script, "/usr/bin/pkexec"))).toEqual({
      file: "/usr/bin/pkexec",
      args: ["/bin/bash", script, "install"],
    });
  });
  it("uses a waiting terminal with sudo when polkit is absent", async () => {
    expect(await repairCommand(options(script, "/usr/bin/sudo", "/usr/bin/gnome-terminal"))).toEqual({
      file: "/usr/bin/gnome-terminal",
      args: ["--wait", "--", "/usr/bin/sudo", "/bin/bash", script, "install"],
    });
  });
  it("supports the fixed installed Linux script location", async () => {
    expect((await repairCommand(options("/usr/lib/crot/l1-install.sh", "/usr/bin/pkexec")))?.args).toContain(
      "/usr/lib/crot/l1-install.sh",
    );
  });
  it("does not start anything when the shipped installer is missing", async () => {
    const run = vi.fn();
    await expect(repairL1({ ...options(), run })).rejects.toThrow("missing");
    expect(run).not.toHaveBeenCalled();
  });
  it("does not treat cancellation as success", async () => {
    await expect(
      repairL1({
        ...options(script, "/usr/bin/pkexec"),
        run: async () => {
          throw new Error("cancelled");
        },
      }),
    ).rejects.toThrow("cancelled");
  });
  it("checks macOS availability without an elevated shell", async () => {
    const run = vi.fn();
    await repairL1({ platform: "darwin", root, exists: async () => true, run });
    expect(run).not.toHaveBeenCalled();
  });
  it("does not claim unsupported macOS can be repaired", async () => {
    await expect(repairCommand({ platform: "darwin", root, exists: async () => false })).rejects.toThrow("Seatbelt");
  });
  it("requests UAC with wait, exit-code propagation and fixed script", async () => {
    const command = await repairCommand({ platform: "win32", root, exists: async () => true });
    expect(command?.args.join(" ")).toContain("-Verb RunAs -Wait -PassThru");
    expect(command?.args.join(" ")).toContain("-Apply");
    expect(command?.args.join(" ")).toContain("$ErrorActionPreference = 'Stop'");
  });
  it("does not overwrite an existing Windows component delivery", async () => {
    const run = vi.fn(async () => undefined);
    await repairL1({ platform: "win32", root, stateDir: "/state", exists: async () => true, run });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
