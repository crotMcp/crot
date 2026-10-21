/** Real Task Scheduler XML/execution qualification on disposable Windows CI runner. */
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { autostartPlan, WINDOWS_TASK_NAME } from "../../src/installer/autostart.js";
const exec = promisify(execFile);
it.skipIf(process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true")(
  "imports honest UTF-8 XML and runs exact Node + JS in Task Scheduler",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "crot-task-"));
    const name = `CROT qualification ${process.pid}-${Date.now()}`;
    const marker = path.join(root, "executed.txt");
    try {
      const script = path.join(root, "launch-é.js");
      await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},process.execPath)`);
      const plan = autostartPlan({ os: "windows", home: root, executable: process.execPath, script });
      const file = path.join(root, "task.xml");
      await writeFile(file, plan.artifacts[0]!.content, "utf8");
      await exec("schtasks.exe", ["/Create", "/TN", name, "/XML", file, "/F"]);
      await exec("schtasks.exe", ["/Run", "/TN", name]);
      let result = "";
      for (let n = 0; n < 100; n++) {
        try {
          result = await readFile(marker, "utf8");
          break;
        } catch {
          await delay(100);
        }
      }
      expect(result.toLowerCase()).toBe(process.execPath.toLowerCase());
      expect(name).not.toBe(WINDOWS_TASK_NAME);
    } finally {
      await exec("schtasks.exe", ["/Delete", "/TN", name, "/F"]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
