import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirs } from "../../helpers.js";
import { windowsDockerConfiguration } from "../../../src/native-host/windows-l1/docker-config.js";
describe("Windows Docker endpoint selection", () => {
  it("pins the actual context and reports unauthenticated TCP as the AD-20.14 residual risk", async () => {
    const dirs = await makeTempDirs();
    try {
      expect((await windowsDockerConfiguration({}, dirs.outside)).host).toBe("npipe:////./pipe/docker_engine");
      expect(await windowsDockerConfiguration({ DOCKER_HOST: "tcp://localhost:2375" }, dirs.outside)).toMatchObject({
        host: "tcp://localhost:2375",
        unauthenticatedNetwork: true,
        tls: false,
      });
      const context = "desktop-linux",
        id = createHash("sha256").update(context).digest("hex");
      const meta = path.join(dirs.outside, "contexts", "meta", id);
      await mkdir(meta, { recursive: true });
      await writeFile(
        path.join(meta, "meta.json"),
        JSON.stringify({ Endpoints: { docker: { Host: "npipe:////./pipe/dockerDesktopLinuxEngine" } } }),
      );
      const result = await windowsDockerConfiguration(
        { DOCKER_CONTEXT: context, DOCKER_CONFIG: dirs.outside, DOCKER_HOST: "tcp://unsafe:2375" },
        dirs.outside,
      );
      expect(result.host).toBe("npipe:////./pipe/dockerDesktopLinuxEngine");
      expect(result.env.DOCKER_CONTEXT).toBe(context);
      expect(result.env.DOCKER_HOST).toBe(result.host);
    } finally {
      await dirs.cleanup();
    }
  });
});
