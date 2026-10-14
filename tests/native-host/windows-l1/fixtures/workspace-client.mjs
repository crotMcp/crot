/* Untrusted test-owned Low process. Explicit RPC client, not fs interception. */
import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const request = async (operation, capability = process.env.CROT_PROBE_CAP) => {
  const deadline = Date.now() + 8000;
  while (true) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = connect(process.env.CROT_PROBE_PIPE);
        let response = "";
        socket.setTimeout(3000, () => socket.destroy(new Error("timeout")));
        socket.on("error", reject);
        socket.on("connect", () => socket.write(JSON.stringify({ capability, request: operation })));
        socket.on("data", (bytes) => {
          response += bytes.toString("utf8");
          if (response.includes("\n")) {
            socket.end(".");
            resolve(JSON.parse(response).ok);
          }
        });
        socket.on("end", () => {
          if (!response) reject(new Error("empty"));
        });
      });
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await delay(10);
    }
  }
};
const attempt = (fn) => {
  try {
    fn();
    return "ALLOWED";
  } catch (e) {
    return e.code;
  }
};
if (process.env.CROT_PROBE_DESCENDANT === "1") {
  const ok = await request({ op: "create", path: "descendant.txt", text: "child" });
  process.stdout.write(JSON.stringify({ ok }));
  process.exit(ok ? 0 : 1);
}
let stage = "project-read";
try {
  const root = process.cwd();
  const result = {
    cwd: root,
    argv: process.argv.slice(2),
    project: readFileSync(path.join(root, "project.txt"), "utf8"),
    before: attempt(() => writeFileSync(path.join(root, "direct.txt"), "denied")),
  };
  stage = "rpc-create";
  result.create = await request({ op: "create", path: "native.txt", text: "исходный 😀" });
  if (!result.create) throw new Error("create refused");
  stage = "read-created";
  result.created = readFileSync(path.join(root, "native.txt"), "utf8");
  stage = "rpc-write";
  result.write = await request({ op: "write", path: "native.txt", text: "изменён 😀" });
  stage = "rpc-rename";
  result.rename = await request({ op: "rename", path: "native.txt", destination: "nested/итог.txt" });
  if (!result.rename) throw new Error("rename refused");
  stage = "read-renamed";
  result.renamed = readFileSync(path.join(root, "nested/итог.txt"), "utf8");
  stage = "rpc-remove";
  result.remove = await request({ op: "remove", path: "nested/итог.txt" });
  result.removed = attempt(() => readFileSync(path.join(root, "nested/итог.txt")));
  stage = "rpc-persist";
  result.persist = await request({ op: "create", path: "host-visible.txt", text: "настоящий Medium workspace" });
  result.after = attempt(() => writeFileSync(path.join(root, "direct-after.txt"), "denied"));
  result.outside = attempt(() => writeFileSync(process.env.CROT_PROBE_OUTSIDE, "denied"));
  result.secret = attempt(() => readFileSync(process.env.CROT_PROBE_SECRET));
  stage = "negative-matrix";
  result.refused = [];
  for (const operation of [
    { op: "create", path: "../outside-created.txt", text: "denied" },
    { op: "write", path: "junction/outside.txt", text: "denied" },
    { op: "write", path: "secret-hard.txt", text: "denied" },
    { op: "write", path: "ordinary-hard.txt", text: "denied" },
    { op: "write", path: "PROJECT~1.TXT", text: "denied" },
    { op: "create", path: "native.txt:stream", text: "denied" },
    { op: "create", path: "\\\\?\\C:\\outside.txt", text: "denied" },
    { op: "rename", path: "host-visible.txt", destination: "junction/outside.txt" },
    { op: "exec", path: "project.txt", command: "cmd.exe", args: ["/c", "echo unsafe"] },
    { op: "read", path: "secret-hard.txt" },
  ])
    result.refused.push(await request(operation));
  result.badCapability = await request({ op: "remove", path: "project.txt" }, "0".repeat(64));
  // Async spawn: a sync wait would block neither the trusted broker nor this
  // child's independent event loop. Captures the descendant's actual stdout.
  stage = "descendant";
  const child = spawnSync(process.execPath, [process.env.CROT_PROBE_CLIENT], {
    cwd: root,
    env: { ...process.env, CROT_PROBE_DESCENDANT: "1" },
    windowsHide: true,
    encoding: "utf8",
    timeout: 15000,
  });
  result.descendant = {
    code: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    error: child.error ? { code: child.error.code ?? null, errno: child.error.errno ?? null } : null,
  };
  if (process.env.CROT_PROBE_CAPTURE === "1") {
    process.stdout.write("stdout: Привет 😀\n");
    process.stderr.write("stderr: проверка\n");
  }
  writeFileSync(process.env.CROT_PROBE_RESULT, JSON.stringify(result));
  process.exitCode = 23;
} catch {
  // Never leak test capability or synthetic secret to logs.
  writeFileSync(process.env.CROT_PROBE_RESULT, JSON.stringify({ failure: true, stage }));
  process.exitCode = 99;
}
