/** Disposable WAL crash qualification. Never launches a sandbox actor. */
import process from "node:process";
import { setInterval } from "node:timers";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { chmod, lstat, mkdir } from "node:fs/promises";
const [compiledRoot, directory, serialized, stage] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(path.join(compiledRoot, relative)).href);
try {
  const { openLeaseJournalStore } = await load("native-host/windows-l1/lease-journal.js");
  let privateFiles, lock;
  if (process.platform === "win32") {
    const { currentUserSid, windowsTools } = await load("native-host/windows-acl.js");
    const { loadWindowsPrivateState } = await load("native-host/windows-state.js");
    const { loadWindowsLeaseLock } = await load("native-host/windows-l1/lease-lock.js");
    privateFiles = await loadWindowsPrivateState(
      await currentUserSid(windowsTools(process.env.SystemRoot ?? "C:\\Windows")),
    );
    lock = await loadWindowsLeaseLock();
  } else {
    // Filesystem crash test ONLY. No POSIX production lock implementation claim.
    privateFiles = {
      mechanism: "posix-mode",
      enforced: true,
      fileMode: 0o600,
      ensureDirectory: async (dir) => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
      },
      protectFile: (file) => chmod(file, 0o600),
      inspect: async (file) => ({
        mechanism: "posix-mode",
        ownerOnly: ((await lstat(file)).mode & 0o077) === 0,
        detail: "fixture",
      }),
    };
    lock = async () => ({ close: () => {} });
  }
  const store = await openLeaseJournalStore({ directory, privateFiles, lock });
  const plan = JSON.parse(serialized);
  await store.create(plan);
  if (stage !== "plan") await store.append(plan.id, { type: "active" });
  if (stage === "job") await store.append(plan.id, { type: "job", name: `Local\\crot-l1-job-${"e".repeat(48)}` });
  process.send({ ready: true });
  // Parent forcibly kills the process: no finally/close/compensation path runs.
  setInterval(() => {}, 1000);
} catch (error) {
  process.stderr.write(String(error) + "\n");
  process.exit(1);
}
