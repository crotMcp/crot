/** The existing real-Docker L1 jobs qualify WP-38's actual image, not just its example JSON. */
import "../../remote-acceptance/ci-diagnostics.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const exec = promisify(execFile);
const required = process.platform === "linux" && process.arch === "x64" && process.env.CROT_L1_REQUIRED === "1";
it.runIf(required)(
  "WP-38 staging image builds and serves verified TLS as an unprivileged read-only container",
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "wp38-container-"));
    const name = `crot-wp38-${randomUUID()}`;
    const image = `${name}:test`;
    const docker = (...args: string[]) => exec("docker", args, { maxBuffer: 4 * 1024 * 1024, timeout: 240000 });
    try {
      const config = JSON.parse(
        (await docker("compose", "-f", "deploy/staging/compose.yml", "config", "--format", "json")).stdout,
      );
      expect(config.services.relay.tmpfs).toEqual(["/tmp:size=16m,mode=0700,uid=10001,gid=10001"]);
      await exec("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout",
        path.join(temp, "key"),
        "-out",
        path.join(temp, "cert"),
      ]);
      // Disposable test-only key; no operator key or credential is exposed to the build context.
      await chmod(path.join(temp, "key"), 0o644);
      await writeFile(path.join(temp, "relay.json"), await readFile("deploy/staging/relay.example.json"));
      await docker("build", "-f", "deploy/staging/Dockerfile", "-t", image, ".");
      await docker(
        "run",
        "--detach",
        "--name",
        name,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--tmpfs",
        "/tmp:uid=10001,gid=10001,mode=0700",
        "--tmpfs",
        "/state:uid=10001,gid=10001,mode=0700",
        "-p",
        "127.0.0.1::8443",
        "--mount",
        `type=bind,src=${path.join(temp, "key")},dst=/config/tls.key,readonly`,
        "--mount",
        `type=bind,src=${path.join(temp, "cert")},dst=/config/tls.crt,readonly`,
        "--mount",
        `type=bind,src=${path.join(temp, "relay.json")},dst=/config/relay.json,readonly`,
        image,
      );
      const port = (await docker("port", name, "8443/tcp")).stdout.trim().split(":").at(-1)!;
      let reachable = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          await exec(process.execPath, [
            "scripts/staging.mjs",
            "health",
            `https://127.0.0.1:${port}`,
            path.join(temp, "cert"),
          ]);
          reachable = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      expect(reachable, "actual container must start and pass CA/hostname-verified health").toBe(true);
      const inspection = JSON.parse((await docker("inspect", name)).stdout)[0];
      expect(inspection.Config.User).toBe("10001:10001");
      expect(inspection.HostConfig.ReadonlyRootfs).toBe(true);
    } finally {
      await docker("rm", "--force", name).catch(() => undefined);
      await docker("image", "rm", image).catch(() => undefined);
      await rm(temp, { recursive: true, force: true });
    }
  },
  300000,
);
