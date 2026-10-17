import { describe, expect, it, vi } from "vitest";
import { dockerFixtureImages, pullDockerFixtureImage } from "./fixtures/docker-image.js";

describe("mandatory Docker fixture immutable registry fallback", () => {
  it("uses the same multi-architecture digest on both official registries, never a mutable tag", () => {
    expect(dockerFixtureImages).toHaveLength(2);
    for (const reference of dockerFixtureImages) expect(reference).toMatch(/\/alpine@sha256:[0-9a-f]{64}$/);
    expect(dockerFixtureImages[0].split("@")[1]).toBe(dockerFixtureImages[1].split("@")[1]);
  });
  it("returns the exact primary reference without extra operations when pull succeeds", async () => {
    const run = vi.fn(),
      wait = vi.fn(async () => undefined);
    expect(await pullDockerFixtureImage(run, wait)).toBe(dockerFixtureImages[0]);
    expect(run.mock.calls).toEqual([[["pull", "-q", dockerFixtureImages[0]]]]);
    expect(wait).not.toHaveBeenCalled();
  });
  it("retries a transient primary failure before switching registries", async () => {
    const run = vi.fn().mockImplementationOnce(() => {
      throw Error("rate limit");
    });
    const wait = vi.fn(async () => undefined);
    expect(await pullDockerFixtureImage(run, wait)).toBe(dockerFixtureImages[0]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_000);
  });
  it("returns the same pinned artifact from the secondary registry when ECR is exhausted", async () => {
    const run = vi
      .fn()
      .mockImplementationOnce(() => {
        throw Error("rate limit");
      })
      .mockImplementationOnce(() => {
        throw Error("rate limit");
      });
    const wait = vi.fn(async () => undefined);
    expect(await pullDockerFixtureImage(run, wait)).toBe(dockerFixtureImages[1]);
    expect(run.mock.calls.map((call) => call[0])).toEqual([
      ["pull", "-q", dockerFixtureImages[0]],
      ["pull", "-q", dockerFixtureImages[0]],
      ["pull", "-q", dockerFixtureImages[1]],
    ]);
  });
  it("fails the mandatory setup after both bounded registries fail, never skipping or accepting another image", async () => {
    const error = Error("unreachable"),
      run = vi.fn((_args: string[]) => {
        throw error;
      }),
      wait = vi.fn(async () => undefined);
    await expect(pullDockerFixtureImage(run, wait)).rejects.toMatchObject({ cause: error });
    expect(run).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(2);
    for (const call of run.mock.calls) expect(dockerFixtureImages).toContain(call[0]?.[2]);
  });
});
