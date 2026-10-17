/** Fixed helper protocol/ownership fault injection, not native desktop proof. */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec, ExitStatus, ProcessLauncher } from "../../../src/core/platform/types.js";
import type { OwnedDesktop } from "../../../src/native-host/windows-l1/owned-desktop.js";

const mocks = vi.hoisted(() => ({
  tokens: vi.fn(),
  pipes: vi.fn(),
  jobs: vi.fn(),
  construct: vi.fn(),
}));
vi.mock("../../../src/native-host/windows-l1/restricted-token.js", () => ({ loadRestrictedTokens: mocks.tokens }));
vi.mock("../../../src/native-host/windows-l1/byte-stdio.js", () => ({ loadBytePipeApi: mocks.pipes }));
vi.mock("../../../src/native-host/windows-job.js", () => ({ loadJobObjectApi: mocks.jobs }));
vi.mock("../../../src/native-host/windows-l1/native-process.js", () => ({
  NativeProcessLauncher: class {
    constructor(options: unknown) {
      return mocks.construct(options);
    }
  },
}));

function fixture() {
  let settle!: (status: ExitStatus) => void;
  const exited = new Promise<ExitStatus>((resolve) => {
    settle = resolve;
  });
  const token = { prepareProbeObjects: vi.fn(), close: vi.fn() };
  const proc = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    hasExited: false,
    failure: undefined,
    exited,
  };
  const helper = {
    launch: vi.fn(async (spec: CommandSpec) => {
      proc.stdout.write(JSON.stringify({ desktop: `${spec.args[2]}\\actor` }) + "\n");
      return proc;
    }),
    close: vi.fn(async () => undefined),
    closeSync: vi.fn(),
  };
  const create = vi.fn(() => token);
  mocks.tokens.mockResolvedValue({ create });
  mocks.pipes.mockResolvedValue({});
  mocks.jobs.mockResolvedValue({});
  mocks.construct.mockImplementation(() => helper);
  return { token, proc, helper, create, settle };
}
let createOwnedDesktop: typeof import("../../../src/native-host/windows-l1/owned-desktop.js").createOwnedDesktop;
let desktops: OwnedDesktop[];
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  desktops = [];
  ({ createOwnedDesktop } = await import("../../../src/native-host/windows-l1/owned-desktop.js"));
});
afterEach(() => {
  vi.useRealTimers();
  for (const desktop of desktops) {
    try {
      desktop.closeSync();
    } catch {
      /* deliberate fault owner */
    }
  }
});
const options = {
  launcher: {} as ProcessLauncher,
  environment: { caseInsensitive: true, merge: () => ({}), get: () => undefined },
  ownerSid: "S-1-5-21-1-2-3-4",
  restrictingSid: "S-1-5-21-5-6-7-8",
  systemRoot: "C:\\Windows",
  privateRoot: "C:\\owned-private",
};
const start = async () => {
  const desktop = await createOwnedDesktop(options);
  desktops.push(desktop);
  return desktop;
};

describe("owned desktop helper protocol and cleanup", () => {
  it("accepts only exact readiness, releases its parser and sends one bounded shutdown", async () => {
    const f = fixture();
    const d = await start();
    expect(d.desktop).toMatch(/^crot-[0-9a-f]{48}\\actor$/);
    expect(d.restrictingSid).toBe(options.restrictingSid);
    expect(f.proc.stdout.listenerCount("data")).toBe(0);
    let shutdown = "";
    f.proc.stdin.on("data", (b: Buffer) => {
      shutdown += b.toString();
    });
    f.settle({ code: 0, signal: null });
    const closing = d.close();
    expect(d.close()).toBe(closing);
    await closing;
    await d.close();
    d.closeSync();
    expect(shutdown).toBe("close\n");
    expect(f.helper.close).toHaveBeenCalledOnce();
    expect(f.token.close).toHaveBeenCalledOnce();
    expect(d.closed).toBe(true);
  });
  it.each(["wrong", "extra", "oversized", "malformed"])(
    "rejects %s readiness before returning authority",
    async (kind) => {
      const f = fixture();
      f.helper.launch.mockImplementationOnce(async (spec) => {
        const desktop = `${spec.args[2]}\\actor`;
        f.proc.stdout.write(
          kind === "wrong"
            ? '{"desktop":"borrowed\\\\default"}\n'
            : kind === "extra"
              ? JSON.stringify({ desktop, extra: true }) + "\n"
              : kind === "oversized"
                ? "x".repeat(1025)
                : "not-json\n",
        );
        return f.proc;
      });
      await expect(start()).rejects.toThrow("unavailable");
      expect(f.helper.close).toHaveBeenCalledOnce();
      expect(f.token.close).toHaveBeenCalledOnce();
      expect(f.proc.stdout.destroyed).toBe(true);
    },
  );
  it("retains setup cleanup failures and blocks new allocations until exact owners recover", async () => {
    const f = fixture();
    f.helper.launch.mockRejectedValueOnce(new Error("native setup failure"));
    f.helper.close.mockRejectedValue(new Error("cleanup failed"));
    f.helper.closeSync.mockImplementation(() => {
      throw new Error("cleanup failed");
    });
    await expect(start()).rejects.toThrow("native setup failure");
    expect(f.token.close).not.toHaveBeenCalled();
    await expect(start()).rejects.toThrow("incomplete cleanup");
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.helper.launch).toHaveBeenCalledOnce();
    f.helper.closeSync.mockImplementation(() => undefined);
    f.helper.close.mockResolvedValue(undefined);
    const next = await start();
    // Recovery closes the SAME previous helper/token before allocating again.
    expect(f.helper.closeSync).toHaveBeenCalledTimes(2);
    expect(f.token.close).toHaveBeenCalledOnce();
    expect(f.create).toHaveBeenCalledTimes(2);
    next.closeSync();
  });
  it("retries a failed token close without relaunching or retaining the transcript", async () => {
    const f = fixture();
    const d = await start();
    f.token.close.mockImplementationOnce(() => {
      throw new Error("token close failed");
    });
    expect(() => d.closeSync()).toThrow("token close failed");
    d.closeSync();
    expect(f.helper.launch).toHaveBeenCalledOnce();
    expect(f.token.close).toHaveBeenCalledTimes(2);
    expect(f.proc.stdout.destroyed).toBe(true);
  });
  it("bounds graceful shutdown, force-disposes only the owned helper, and remains idempotent", async () => {
    const f = fixture();
    const d = await start();
    vi.useFakeTimers();
    const closed = d.close();
    const rejected = expect(closed).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(f.helper.close).toHaveBeenCalledOnce();
    expect(f.token.close).toHaveBeenCalledOnce();
    await d.close();
    expect(f.helper.close).toHaveBeenCalledOnce();
  });
  it("cleans up a token if setup fails before any helper is constructed", async () => {
    const f = fixture();
    mocks.pipes.mockRejectedValueOnce(new Error("pipe setup failed"));
    await expect(start()).rejects.toThrow("pipe setup failed");
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(f.token.close).toHaveBeenCalledOnce();
  });
});
