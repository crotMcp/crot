import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), electron: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:module", () => ({ createRequire: () => mocks.electron }));
import { launchControlCenter } from "../../src/tray/launch.js";
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
describe("fixed Control Center launcher", () => {
  it("passes only the shipped entry and state directory, without a shell or inherited Node mode", async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.electron.mockReturnValue("/opt/CROT/electron");
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    await expect(launchControlCenter("/private/owner state")).resolves.toBe(true);
    const [executable, args, options] = mocks.spawn.mock.calls[0]!;
    expect(executable).toBe("/opt/CROT/electron");
    expect(args.at(-1)).toBe("--state-dir=/private/owner state");
    expect(args.at(-2)).toBe(path.resolve(fileURLToPath(new URL("../../src/tray/main.js", import.meta.url))));
    expect(args.includes("--no-sandbox")).toBe(process.platform === "linux");
    expect(options.shell).toBeUndefined();
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(options.stdio).toBe("ignore");
    expect(child.unref).toHaveBeenCalledOnce();
  });
  it("reports missing Electron or OS launch failure instead of false success", async () => {
    mocks.electron.mockImplementationOnce(() => {
      throw new Error("not installed");
    });
    await expect(launchControlCenter("/state")).resolves.toBe(false);
    const child = new EventEmitter();
    mocks.electron.mockReturnValue("/opt/CROT/electron");
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("no display")));
      return child;
    });
    await expect(launchControlCenter("/state")).resolves.toBe(false);
  });
});
