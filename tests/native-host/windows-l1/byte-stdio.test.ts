/** Portable state-machine qualification; native byte semantics run separately. */
import { once } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createNativeByteStdio,
  isNativeByteStdio,
  ownedStdioHandles,
  releaseStdioChildEnds,
  type BytePipe,
  type BytePipeApi,
  type PipeOperation,
} from "../../../src/native-host/windows-l1/byte-stdio.js";

const OWNER = "S-1-5-21-1-2-3-1000";
function fixture(chunks: Buffer[][] = [[], [], []], maxWrite = 32768, pendingPolls = 1) {
  const pipes: (BytePipe & { bytes: Buffer[]; operations: PipeOperation[] })[] = [];
  const api: BytePipeApi = {
    create: async () => {
      const i = pipes.length;
      const operations: PipeOperation[] = [],
        bytes: Buffer[] = [];
      const op = (buffer: Buffer, write: boolean): PipeOperation => {
        let ticks = 0,
          complete = false,
          cancelled = false,
          released = false;
        let status: ReturnType<PipeOperation["poll"]> | undefined;
        const operation: PipeOperation = {
          get completed() {
            return complete;
          },
          poll: vi.fn((): ReturnType<PipeOperation["poll"]> => {
            if (released) throw new Error("poll after release");
            if (cancelled) {
              complete = true;
              throw new Error("cancelled");
            }
            if (complete) return status!;
            if (ticks++ < pendingPolls) return { state: "pending" };
            complete = true;
            if (write) {
              const n = Math.min(maxWrite, buffer.length);
              bytes.push(Buffer.from(buffer.subarray(0, n)));
              return (status = { state: "complete", bytes: n });
            }
            const data = chunks[i]?.shift();
            if (!data) return (status = { state: "eof" });
            data.copy(buffer);
            return (status = { state: "complete", bytes: data.length });
          }),
          cancel: vi.fn(() => {
            cancelled = true;
          }),
          release: vi.fn(() => {
            expect(complete).toBe(true);
            released = true;
          }),
        };
        operations.push(operation);
        return operation;
      };
      const pipe = {
        parent: BigInt(i * 2 + 1),
        child: BigInt(i * 2 + 2),
        bytes,
        operations,
        read: (buffer: Buffer) => op(buffer, false),
        write: (buffer: Buffer) => op(buffer, true),
        closeParent: vi.fn(),
        closeChild: vi.fn(),
      };
      pipes.push(pipe);
      return pipe;
    },
  };
  return { api, pipes };
}
async function collect(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
describe("owned native byte stdio state machine", () => {
  it("keeps stdin/stdout/stderr as independent bytes with concurrent drain and no Unicode decoding", async () => {
    const binary = Buffer.from([0, 255, 128, 13, 10]);
    const f = fixture([[], [Buffer.from("😀"), binary], [Buffer.from("ошибка"), binary]], 3);
    const io = await createNativeByteStdio(f.api, OWNER);
    expect(isNativeByteStdio(io)).toBe(true);
    expect(ownedStdioHandles(io)).toEqual([2n, 4n, 6n]);
    releaseStdioChildEnds(io);
    const drained = Promise.all([collect(io.stdout), collect(io.stderr)]);
    io.stdin.end(Buffer.concat([Buffer.from("输入"), binary]));
    await once(io.stdin, "finish");
    const [out, err] = await drained;
    expect(out).toEqual(Buffer.concat([Buffer.from("😀"), binary]));
    expect(err).toEqual(Buffer.concat([Buffer.from("ошибка"), binary]));
    expect(Buffer.concat(f.pipes[0]!.bytes)).toEqual(Buffer.concat([Buffer.from("输入"), binary]));
    await io.close();
    await io.close();
    for (const pipe of f.pipes) {
      expect(pipe.closeChild).toHaveBeenCalledOnce();
      expect(pipe.operations.every((op) => op.completed)).toBe(true);
    }
  });
  it("does not permit a forged transport to supply host handles", () => {
    expect(isNativeByteStdio({ stdin: 1n })).toBe(false);
    expect(() => ownedStdioHandles({} as never)).toThrow("unowned");
    expect(() => releaseStdioChildEnds({} as never)).toThrow("unowned");
  });
  it("rolls back all earlier owned pipe pairs on partial setup failure", async () => {
    const f = fixture();
    const original = f.api.create;
    f.api.create = async (direction, owner) => {
      if (f.pipes.length === 2) throw new Error("setup failure");
      return original(direction, owner);
    };
    await expect(createNativeByteStdio(f.api, OWNER)).rejects.toThrow("setup failure");
    for (const pipe of f.pipes) {
      expect(pipe.closeChild).toHaveBeenCalledOnce();
      expect(pipe.closeParent).toHaveBeenCalledOnce();
    }
  });
  it("cancels pending output I/O before freeing memory and closing handles", async () => {
    const f = fixture([[], [], []], 32768, 100000);
    const io = await createNativeByteStdio(f.api, OWNER);
    io.stdout.resume();
    io.stderr.resume();
    await new Promise((r) => setTimeout(r, 5));
    await io.close();
    for (const pipe of f.pipes.slice(1)) {
      expect(pipe.operations[0]!.cancel).toHaveBeenCalled();
      expect(pipe.operations[0]!.release).toHaveBeenCalledOnce();
    }
  });
  it("synchronous teardown waits for acknowledged cancellation and is idempotent", async () => {
    const f = fixture([[], [], []], 32768, 100000);
    const io = await createNativeByteStdio(f.api, OWNER);
    io.stdout.resume();
    await new Promise((r) => setTimeout(r, 5));
    io.closeSync();
    io.closeSync();
    await io.close();
    expect(f.pipes[1]!.operations[0]!.release).toHaveBeenCalled();
  });
  it("retains failed child closes for retry, without authorizing handle reuse or skipping parent cleanup", async () => {
    const f = fixture();
    const io = await createNativeByteStdio(f.api, OWNER);
    const original = f.pipes[0]!.closeChild;
    f.pipes[0]!.closeChild = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("close child failed");
      })
      .mockImplementation(original);
    await expect(io.close()).rejects.toThrow("close child failed");
    expect(() => ownedStdioHandles(io)).toThrow("unowned child handles");
    for (const pipe of f.pipes) expect(pipe.closeParent).toHaveBeenCalled();
    await io.close();
    expect(f.pipes[0]!.closeChild).toHaveBeenCalledTimes(2);
  });
  it("bounds read buffering when the consumer applies backpressure", async () => {
    const chunks = Array.from({ length: 100 }, () => Buffer.alloc(32768, 0xa5));
    const f = fixture([[], chunks, []], 32768, 0);
    const io = await createNativeByteStdio(f.api, OWNER);
    io.stdout.read(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(io.stdout.readableLength).toBeLessThanOrEqual(65536);
    expect(f.pipes[1]!.operations.length).toBeLessThanOrEqual(3);
    await io.close();
  });
});
