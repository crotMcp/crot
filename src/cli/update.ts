/** Operator-initiated signed update. Trust anchor is supplied out-of-band, never from package. */
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { applyUpdate } from "../installer/update.js";
import { installAutostart, removeAutostart } from "../installer/autostart.js";
import { hostDirectories, osFamily } from "../core/platform/node-platform.js";
import { ControlClient } from "../service/control-client.js";
import { createServicePrivateFiles } from "../service/private-files.js";
import type { ControlStatus } from "../service/protocol.js";
export async function runUpdate(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      package: { type: "string" },
      "public-key": { type: "string" },
      "install-root": { type: "string" },
      config: { type: "string" },
    },
  });
  if (!values.package || !values["public-key"] || !values["install-root"] || !values.config)
    throw new Error(
      "update requires --package <dir> --public-key <trusted.pem> --install-root <dir> --config <file>; stop service first",
    );
  const stateRoot = hostDirectories(process.env).state;
  const connect = () =>
    ControlClient.connect({
      stateDir: stateRoot,
      privateFiles: createServicePrivateFiles(process.platform === "win32"),
    });
  const running = await connect();
  if (running) {
    running.close();
    throw new Error("stop CROT service before updating");
  }
  const configFile = path.resolve(values.config);
  await access(configFile);
  const installRoot = path.resolve(values["install-root"]);
  const contains = (a: string, b: string) =>
    a === b || (!path.relative(a, b).startsWith("..") && !path.isAbsolute(path.relative(a, b)));
  if (contains(installRoot, stateRoot) || contains(installRoot, configFile) || contains(stateRoot, installRoot))
    throw new Error("install root must not overlap private state/config");
  const spec = { os: osFamily(process.platform), home: os.homedir(), executable: process.execPath, configFile };
  const result = await applyUpdate(
    path.resolve(values.package),
    await readFile(path.resolve(values["public-key"])),
    { installRoot, stateRoot },
    {
      register: async (dir) => {
        await removeAutostart(spec);
        await installAutostart({ ...spec, script: path.join(dir, "bin/crot-mcp.js") });
      },
      unregister: async () => {
        await removeAutostart(spec);
      },
      healthCheck: async () => {
        for (let attempt = 0; attempt < 50; attempt++) {
          const client = await connect();
          if (client) {
            try {
              const status = (await client.request("status")) as ControlStatus;
              return status.service.state === "running";
            } finally {
              client.close();
            }
          }
          await delay(100);
        }
        return false;
      },
    },
  );
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.rolledBack) process.exitCode = 1;
}
