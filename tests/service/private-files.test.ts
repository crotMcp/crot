import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { createServicePrivateFiles, existingPrivateStateFiles } from "../../src/service/private-files.js";
import { secretFile } from "../../src/service/secrets/backends.js";
import { CrotService } from "../../src/service/service.js";
import { writePrivateFileAtomic } from "../../src/service/secrets/backends.js";
import { writeStateFile } from "../../src/service/private-state.js";
import { dpapiDirectory } from "../../src/service/secrets/dpapi.js";
describe("actual service private-file provider", () => {
  it.each(["root", "secret"] as const)(
    "stops legacy Windows bootstrap before secret reads when %s protection fails",
    async (failure) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "crot-legacy-stop-"));
      try {
        const file = secretFile(dir, "service-token");
        const previous = "invalid-existing-secret-must-not-be-read";
        await writeFile(file, previous);
        const protectedFiles: string[] = [];
        const privateFiles = {
          ...createServicePrivateFiles(false),
          protectFile: async (target: string) => {
            protectedFiles.push(target);
            if (target === (failure === "root" ? dir : file)) throw new Error("fixture native protection refused");
          },
        };
        await expect(
          CrotService.start({
            command: {
              kind: "serve",
              config: { workspace: { root: dir }, secrets: { store: "file" }, audit: { sink: "none" } },
              warnings: [],
            },
            launch: "managed",
            stateDir: dir,
            windows: true,
            privateFiles,
            log: () => undefined,
            requestStop: () => undefined,
          }),
        ).rejects.toThrow("fixture native protection refused");
        expect(protectedFiles).toEqual(failure === "root" ? [dir] : [dir, file]);
        expect((await readFile(file, "utf8")) === previous).toBe(true);
        expect(await readdir(dir)).toEqual(["service-token"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it.each([
    ["secret", writePrivateFileAtomic],
    ["device settings", writeStateFile],
  ] as const)(
    "does not write secret bytes or replace old %s after failed empty-temp protection",
    async (_name, write) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "crot-atomic-stop-"));
      try {
        const file = path.join(dir, "state.json");
        await writeFile(file, "unchanged");
        let attempts = 0;
        const privateFiles = {
          ...createServicePrivateFiles(false),
          protectFile: async (temp: string) => {
            attempts++;
            expect((await readFile(temp)).length).toBe(0);
            throw new Error("fixture native protection refused");
          },
        };
        await expect(write(file, "must-not-be-written", privateFiles)).rejects.toThrow(
          "fixture native protection refused",
        );
        expect(attempts).toBe(1);
        expect((await readFile(file, "utf8")) === "unchanged").toBe(true);
        expect(await readdir(dir)).toEqual(["state.json"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps POSIX private-file behavior and verifies protection before secret data is written",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "crot-private-provider-"));
      try {
        const provider = createServicePrivateFiles(false);
        expect(provider.mechanism).toBe("posix-mode");
        expect(provider.enforced).toBe(true);
        const root = path.join(dir, "state");
        await provider.ensureDirectory(root);
        const file = path.join(root, "state.txt");
        await writeFile(file, "fixture", { mode: provider.fileMode });
        expect((await provider.inspect(file)).ownerOnly).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it("does not advertise an inherited-ACL fallback for Windows service state", () => {
    const provider = createServicePrivateFiles(true);
    expect(provider.mechanism).toBe("windows-acl");
    expect(provider.enforced).toBe(true);
    expect(provider.protectFile).toBeTypeOf("function");
  });
  it("migrates only fixed CROT file names, including DPAPI; never scans or mutates other user files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "crot-state-scope-"));
    try {
      const secret = secretFile(dir, "service-token"),
        dpapi = dpapiDirectory(dir),
        user = path.join(dir, "project.txt");
      await mkdir(dpapi);
      await writeFile(secret, "fixture");
      const key = path.join(dpapi, "device-key.dpapi");
      await writeFile(key, "fixture");
      await writeFile(user, "unchanged");
      await writeFile(path.join(dpapi, "project.txt"), "unchanged");
      const files = await existingPrivateStateFiles(dir);
      expect(files).toContain(secret);
      expect(files).toContain(key);
      expect(files).not.toContain(user);
      expect(files).not.toContain(path.join(dpapi, "project.txt"));
      expect(await readFile(user, "utf8")).toBe("unchanged");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform === "win32")(
    "passes an exact-name symlink to the rejecting protector instead of silently following/migrating its target",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "crot-state-alias-"));
      try {
        const user = path.join(dir, "project.txt"),
          secret = secretFile(dir, "service-token");
        await writeFile(user, "unchanged");
        await symlink(user, secret);
        expect(await existingPrivateStateFiles(dir)).toContain(secret);
        expect(await readFile(user, "utf8")).toBe("unchanged");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
